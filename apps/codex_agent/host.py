"""Metadata-only AgentRuntime host over a private Unix-domain socket."""

from __future__ import annotations

import asyncio
import importlib.metadata
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, assert_never

from apps.codex_agent.capacity import (
    PRODUCTION_CAPACITY_PATHS,
    CapacityPaths,
    capacity_is_available,
)
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from provider_runtime import Absent, Present, TokenUsage
from provider_runtime.agent_runtime import (
    AgentEvent,
    AgentFailure,
    AgentNative,
    AgentPermissionRequest,
    AgentQuotaExhausted,
    AgentRuntimeDefect,
    AgentRuntimeError,
    AgentSession,
    AgentSessionRef,
    AgentSessionRequest,
    AgentTerminal,
    AgentTerminalFailure,
    AgentText,
    AgentToolUse,
    AgentUsage,
    ApprovalHandler,
    ConcurrentTurn,
    CredentialRejected,
    CredentialUnavailable,
    ExecutableUnavailable,
    InvalidAgentRequest,
    McpConfigurationError,
    McpUnavailable,
    SdkUnavailable,
    SessionMismatch,
    SessionUnavailable,
    TurnNotStarted,
    TurnRequest,
    UnsupportedCapability,
    ref_to_json,
    thaw_json_value,
)
from pydantic import ValidationError

from nexus.services.native_agent_contract import (
    NATIVE_AGENT_MAX_FRAME_BYTES,
    NATIVE_AGENT_MAX_FRAMES,
    NATIVE_AGENT_MAX_STREAM_BYTES,
    NativeAgentCapacityRejection,
    NativeAgentCommand,
    NativeAgentEvent,
    NativeAgentFailure,
    NativeAgentFailureKind,
    NativeAgentFrame,
    NativeAgentHealth,
    NativeAgentNative,
    NativeAgentPermissionRequest,
    NativeAgentSessionRef,
    NativeAgentTerminal,
    NativeAgentTerminalStatus,
    NativeAgentText,
    NativeAgentToolUse,
    NativeAgentUsage,
    NativeAgentUsageEvent,
)
from nexus.services.native_agent_operations import (
    METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS,
    METADATA_ENRICHMENT_SESSION_OPEN_DEADLINE_SECONDS,
    resolve_native_agent_operation,
)

_SDK_DISTRIBUTION = "openai-codex"
_RUNTIME_DISTRIBUTION = "openai-codex-cli-bin"

# The body cap is a memory guard for the socket, not the operation's input bound: JSON
# escaping expands a decoded input by up to six bytes per byte (`\uXXXX`), so a cap set
# just above the decoded bound would reject contract-legal commands. This cap dominates
# the largest body a legal command can serialize to instead — a maximal
# `METADATA_ENRICHMENT_MAX_INPUT_BYTES` (32768) input escaped sixfold plus the command
# envelope — while the decoded 32768-byte input bound itself stays enforced after parsing
# by `MetadataEnrichmentOperation`.
_MAX_COMMAND_BODY_BYTES = 256 * 1_024

# Shutdown budget. On SIGTERM the server first lets an in-flight request run for the
# request drain bound, so a turn that is about to emit its terminal still does; it then
# cancels the request, which interrupts the admitted turn, and the host waits for that
# turn's runtime close — the catalog's close deadline — before the interpreter exits.
# The deployment must grant at least both bounds plus an exit margin before SIGKILL, or
# a shutdown could orphan the native process tree the close is reaping.
CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS = 10.0
CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS = METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS
_EXIT_MARGIN_SECONDS = 5.0
CODEX_AGENT_HOST_STOP_GRACE_SECONDS = int(
    CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS
    + CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS
    + _EXIT_MARGIN_SECONDS
)

type _HostPhase = Literal["session_open", "turn_stream", "runtime_close"]


@dataclass(frozen=True, slots=True)
class RuntimeVersions:
    """Pinned executable identity resolved once when the host starts."""

    sdk: str
    runtime: str


def resolve_runtime_versions() -> RuntimeVersions:
    """Resolve the pinned Codex distributions; a missing distribution fails startup."""

    return RuntimeVersions(
        sdk=importlib.metadata.version(_SDK_DISTRIBUTION),
        runtime=importlib.metadata.version(_RUNTIME_DISTRIBUTION),
    )


class AgentRuntimePort(Protocol):
    async def open_session(self, request: AgentSessionRequest) -> AgentSession: ...

    def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
    ) -> AsyncIterator[AgentEvent]: ...

    async def close(self) -> None: ...


type AgentRuntimeFactory = Callable[[], AgentRuntimePort]


class _TurnSlot:
    def __init__(self) -> None:
        self._claimed = False

    def try_acquire(self) -> bool:
        if self._claimed:
            return False
        self._claimed = True
        return True

    def release(self) -> None:
        if not self._claimed:
            # justify-service-invariant-check: single-turn admission is a property of the
            # request lifecycle, which no parameter type can carry.
            # justify-defect: only a host defect can release a slot nobody holds.
            raise RuntimeError("Codex agent turn slot released while free")
        self._claimed = False


type _RelayedFrame = bytes | None


class TurnLifecycle:
    """Own the single admitted turn independently of the HTTP connection that asked for it.

    The sole turn slot is held from admission through terminal emission and runtime
    close (spec §8). A client that disconnects after acceptance, or a server shutdown
    that cancels its request, must not shorten that span: the turn runs in a
    host-owned task whose own teardown closes the runtime — interrupting the native
    turn and reaping its descendants — and only then releases the slot. The response
    generator merely relays frames; losing it interrupts the turn, never the cleanup.
    """

    def __init__(self) -> None:
        self._active: asyncio.Task[None] | None = None

    def start(self, turn: Coroutine[object, object, None]) -> asyncio.Task[None]:
        if self._active is not None and not self._active.done():
            # justify-defect: the slot admits one turn; a second active task is a host defect.
            raise RuntimeError("Codex agent host started a turn while one is still active")
        self._active = asyncio.create_task(turn)
        return self._active

    async def drain(self, deadline_seconds: float) -> bool:
        """Wait for the admitted turn's teardown so shutdown reaps before the process exits.

        The server has already cancelled the relaying request by the time this runs, so
        the owner is closing its runtime; a second cancellation would interrupt that
        close, so this only waits. Returns whether the turn finished within the bound.
        """

        active = self._active
        if active is None or active.done():
            return True
        done, _pending = await asyncio.wait({active}, timeout=deadline_seconds)
        return active in done


def turn_lifecycle(app: FastAPI) -> TurnLifecycle:
    lifecycle = app.state.turn_lifecycle
    if not isinstance(lifecycle, TurnLifecycle):
        # justify-defect: only create_codex_agent_app builds this app and it always installs one.
        raise AssertionError("Codex agent app has no turn lifecycle")
    return lifecycle


def create_codex_agent_app(
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory: Path,
    versions: RuntimeVersions,
    capacity_paths: CapacityPaths = PRODUCTION_CAPACITY_PATHS,
) -> FastAPI:
    if not working_directory.is_absolute():
        # justify-service-invariant-check: `Path` cannot express absoluteness.
        raise ValueError("Codex agent working directory must be absolute")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    one_turn = _TurnSlot()
    lifecycle = TurnLifecycle()
    app.state.turn_lifecycle = lifecycle

    @app.get("/health", response_model=NativeAgentHealth)
    async def health() -> NativeAgentHealth:
        return NativeAgentHealth()

    @app.post("/v1/turns")
    async def turn(request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise HTTPException(status_code=415, detail="content type must be application/json")
        if request.headers.get("accept", "").strip().lower() != "application/x-ndjson":
            raise HTTPException(status_code=406, detail="accept must be application/x-ndjson")
        command = await _read_command(request)

        if not one_turn.try_acquire():
            return _capacity_rejection()
        if not capacity_is_available(capacity_paths):
            one_turn.release()
            return _capacity_rejection()

        relay: asyncio.Queue[_RelayedFrame] = asyncio.Queue()
        owner = lifecycle.start(
            _own_admitted_turn(
                command,
                relay,
                one_turn,
                runtime_factory=runtime_factory,
                working_directory=working_directory,
                versions=versions,
            )
        )
        return StreamingResponse(_relay_frames(relay, owner), media_type="application/x-ndjson")

    return app


async def _own_admitted_turn(
    command: NativeAgentCommand,
    relay: asyncio.Queue[_RelayedFrame],
    slot: _TurnSlot,
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory: Path,
    versions: RuntimeVersions,
) -> None:
    """Run one admitted turn to its terminal and release the slot only after runtime close."""

    try:
        async for line in _run_turn(
            command,
            runtime_factory=runtime_factory,
            working_directory=working_directory,
            versions=versions,
        ):
            relay.put_nowait(line)
    finally:
        # `_run_turn` has closed the runtime by the time control reaches here, on every
        # path including cancellation, so the slot is free for the next admission.
        relay.put_nowait(None)
        slot.release()


async def _relay_frames(
    relay: asyncio.Queue[_RelayedFrame],
    owner: asyncio.Task[None],
) -> AsyncIterator[bytes]:
    try:
        while (chunk := await relay.get()) is not None:
            yield chunk
    finally:
        # Reached after the terminal, on client disconnect, and on server shutdown. A
        # turn whose consumer is gone is interrupted; cancelling a finished task is a
        # no-op, and the owner's own teardown closes the runtime and frees the slot.
        owner.cancel()


async def _read_command(request: Request) -> NativeAgentCommand:
    """Read one bounded command body without buffering an unbounded request."""

    declared = request.headers.get("content-length", "")
    if not declared.isdigit():
        raise HTTPException(status_code=411, detail="content length is required")
    if int(declared) > _MAX_COMMAND_BODY_BYTES:
        raise HTTPException(status_code=413, detail="command exceeds its byte bound")
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > _MAX_COMMAND_BODY_BYTES:
            raise HTTPException(status_code=413, detail="command exceeds its byte bound")
    try:
        return NativeAgentCommand.model_validate_json(bytes(payload))
    except ValidationError as error:
        raise HTTPException(
            status_code=422,
            detail="command is not a valid native agent command",
        ) from error


def _capacity_rejection() -> Response:
    return Response(
        content=NativeAgentCapacityRejection().model_dump_json(),
        status_code=503,
        media_type="application/json",
    )


class _StreamBudget:
    """Author the response stream inside the contract's closed bounds, by construction.

    The worker refuses a stream above `NATIVE_AGENT_MAX_FRAMES` frames,
    `NATIVE_AGENT_MAX_STREAM_BYTES` in total, or any frame above
    `NATIVE_AGENT_MAX_FRAME_BYTES`, and an accepted turn it refuses becomes an
    uncertain, never-redispatched job. So the host never authors such a stream: it
    reserves one maximal frame for the terminal, and a turn whose relayed events or
    terminal would overrun the bound ends with the typed `output_limit_exceeded`
    terminal instead of a stream the contract rejects.
    """

    def __init__(self) -> None:
        self.frames = 0
        self.bytes = 0

    def admits_intermediate(self, line: bytes) -> bool:
        return (
            self.frames + 1 <= NATIVE_AGENT_MAX_FRAMES - 1
            and self.bytes + len(line)
            <= NATIVE_AGENT_MAX_STREAM_BYTES - NATIVE_AGENT_MAX_FRAME_BYTES
        )

    def admits_terminal(self, line: bytes) -> bool:
        return (
            len(line) <= NATIVE_AGENT_MAX_FRAME_BYTES
            and self.bytes + len(line) <= NATIVE_AGENT_MAX_STREAM_BYTES
        )

    def record(self, line: bytes) -> None:
        self.frames += 1
        self.bytes += len(line)


# A text frame carries at most this much decoded UTF-8. JSON escaping expands text by
# at most six bytes per byte, so the largest serialized text frame stays under
# `NATIVE_AGENT_MAX_FRAME_BYTES` with its envelope (32 KiB * 6 = 192 KiB < 256 KiB).
_MAX_TEXT_FRAME_BYTES = 32 * 1024


class _EventCoalescer:
    """Collapse the SDK's per-delta events into the bounded frames the contract relays.

    The pinned Codex adapter yields one `AgentText` per agent-message delta and one
    `AgentNative` per reasoning delta, so relaying one frame per event would let an
    ordinary structured-output turn overrun the frame bound. Text deltas coalesce into
    bounded runs, and consecutive native events of one type collapse into one frame —
    a native frame carries only its type, so repeats add nothing a consumer can read.
    """

    def __init__(self) -> None:
        self._text: list[str] = []
        self._text_bytes = 0
        self._last_native: str | None = None

    def absorb(self, event: AgentText | AgentUsage | AgentNative) -> list[NativeAgentEvent]:
        if isinstance(event, AgentText):
            self._last_native = None
            return self._absorb_text(event.text)
        frames = self.flush()
        if isinstance(event, AgentNative):
            if event.native_type == self._last_native:
                return frames
            self._last_native = event.native_type
        else:
            self._last_native = None
        frames.append(_event_to_wire(event))
        return frames

    def flush(self) -> list[NativeAgentEvent]:
        if not self._text:
            return []
        frame = NativeAgentText(text="".join(self._text))
        self._text = []
        self._text_bytes = 0
        return [frame]

    def _absorb_text(self, text: str) -> list[NativeAgentEvent]:
        frames: list[NativeAgentEvent] = []
        for piece in _split_utf8(text, _MAX_TEXT_FRAME_BYTES):
            piece_bytes = len(piece.encode("utf-8"))
            if self._text and self._text_bytes + piece_bytes > _MAX_TEXT_FRAME_BYTES:
                frames.extend(self.flush())
            self._text.append(piece)
            self._text_bytes += piece_bytes
        return frames


def _split_utf8(text: str, max_bytes: int) -> list[str]:
    """Split text into pieces of at most `max_bytes` UTF-8 bytes at code-point boundaries."""

    encoded = text.encode("utf-8")
    pieces: list[str] = []
    offset = 0
    while offset < len(encoded):
        # `offset` always sits on a code-point boundary, so `ignore` drops only the
        # trailing code point a byte cut would split.
        piece = encoded[offset : offset + max_bytes].decode("utf-8", errors="ignore")
        if not piece:
            # justify-defect: every code point encodes to at most four bytes, far below
            # the text frame bound, so a single code point always fits.
            raise AssertionError("text frame bound cannot hold one code point")
        pieces.append(piece)
        offset += len(piece.encode("utf-8"))
    return pieces


async def _run_turn(
    command: NativeAgentCommand,
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory: Path,
    versions: RuntimeVersions,
) -> AsyncIterator[bytes]:
    """Drive one admitted turn and yield its serialized NDJSON frames, terminal last."""

    sequence = 0
    budget = _StreamBudget()
    coalescer = _EventCoalescer()
    runtime: AgentRuntimePort | None = None
    session: AgentSession | None = None
    terminal: NativeAgentTerminal | None = None
    terminal_seen = False

    def serialize(event: NativeAgentEvent) -> bytes:
        return _frame(command, sequence, event).model_dump_json().encode("utf-8") + b"\n"

    def relay(events: list[NativeAgentEvent]) -> list[bytes]:
        """Serialize intermediate frames, or stop the turn when the stream bound is met."""

        nonlocal sequence, terminal
        lines: list[bytes] = []
        for event in events:
            line = serialize(event)
            if not budget.admits_intermediate(line):
                terminal = _failed_terminal(
                    "output_limit_exceeded",
                    session=session,
                    versions=versions,
                    diagnostics=_diagnostics("turn_stream", "stream exceeded its frame bound"),
                )
                break
            budget.record(line)
            sequence += 1
            lines.append(line)
        return lines

    try:
        runtime = runtime_factory()
        operation = resolve_native_agent_operation(command, working_directory=working_directory)
        try:
            async with asyncio.timeout(METADATA_ENRICHMENT_SESSION_OPEN_DEADLINE_SECONDS):
                session = await runtime.open_session(operation.session)
        except TimeoutError as error:
            terminal = _failed_terminal(
                "session_unavailable",
                session=None,
                versions=versions,
                diagnostics=_diagnostics("session_open", type(error).__name__),
            )
        else:
            async for event in runtime.stream_turn(session, operation.turn, approvals=None):
                if terminal_seen:
                    terminal = _failed_terminal(
                        "runtime_defect",
                        session=session,
                        versions=versions,
                        diagnostics=_diagnostics("turn_stream", "frame after terminal"),
                    )
                    break
                if isinstance(event, AgentToolUse | AgentPermissionRequest):
                    for line in relay([*coalescer.flush(), _event_to_wire(event)]):
                        yield line
                    # The observed forbidden capability is the fact that matters, even
                    # when the stream bound kept its frame from being relayed.
                    terminal = _failed_terminal(
                        "policy_violation",
                        session=session,
                        versions=versions,
                        diagnostics=_diagnostics("turn_stream", "forbidden capability event"),
                    )
                    break
                if isinstance(event, AgentTerminal):
                    terminal_seen = True
                    terminal = _terminal_to_wire(event, versions=versions)
                    continue
                for line in relay(coalescer.absorb(event)):
                    yield line
                if terminal is not None:
                    break
            if terminal is None:
                terminal = _failed_terminal(
                    "runtime_defect",
                    session=session,
                    versions=versions,
                    diagnostics=_diagnostics("turn_stream", "stream ended without terminal"),
                )
            elif terminal_seen:
                for line in relay(coalescer.flush()):
                    yield line
    except TurnNotStarted as error:
        terminal = _turn_not_started_terminal(error, session=session, versions=versions)
    except AgentRuntimeError as error:
        terminal = _failed_terminal(
            _runtime_error_kind(error),
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    except AgentRuntimeDefect as error:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    except Exception as error:
        # justify-ignore-error: the private host owes its caller exactly one terminal, so
        # an unmodeled internal failure is classified here as the runtime defect it is and
        # its message is dropped because no host text may reach a persisted product record.
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    finally:
        if runtime is not None:
            try:
                async with asyncio.timeout(METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS):
                    await runtime.close()
            except Exception as error:
                # justify-ignore-error: a failed close cannot withdraw an observed policy
                # violation, and every other outcome degrades to the runtime defect it is.
                if (
                    terminal is None
                    or terminal.failure is None
                    or terminal.failure.kind != "policy_violation"
                ):
                    terminal = _failed_terminal(
                        "runtime_defect",
                        session=session,
                        versions=versions,
                        diagnostics=_diagnostics("runtime_close", type(error).__name__),
                    )
    if terminal is None:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", "turn produced no terminal"),
        )
    line = serialize(terminal)
    if not budget.admits_terminal(line):
        # The terminal is authored last, so its size is known exactly: one that the
        # worker would refuse is replaced by the typed bound failure, keeping the
        # session reference and usage the oversized terminal already established.
        line = serialize(
            NativeAgentTerminal(
                status="failed",
                failure=NativeAgentFailure(kind="output_limit_exceeded"),
                final_text="",
                structured_output=None,
                session_ref=terminal.session_ref,
                usage=terminal.usage,
                diagnostics=_diagnostics("turn_stream", "terminal exceeded its byte bound"),
                sdk_version=terminal.sdk_version,
                runtime_version=terminal.runtime_version,
            )
        )
    yield line


def _diagnostics(phase: _HostPhase, reason: str) -> tuple[str, ...]:
    """Return the host-owned, content-free diagnostic carried by a terminal."""

    return (f"codex agent host {phase}: {reason}",)


def _event_to_wire(event: AgentEvent) -> NativeAgentEvent:
    if isinstance(event, AgentText):
        return NativeAgentText(text=event.text)
    if isinstance(event, AgentToolUse):
        return NativeAgentToolUse(
            tool_call_id=event.tool_call_id,
            name=event.name,
            phase=event.phase,
            succeeded=event.succeeded,
        )
    if isinstance(event, AgentUsage):
        return NativeAgentUsageEvent(usage=_usage(event.usage))
    if isinstance(event, AgentPermissionRequest):
        return NativeAgentPermissionRequest(
            operation=event.request.operation,
            summary=event.request.summary[:1_000],
            tool_name=event.request.tool_name,
            decision=event.decision,
        )
    if isinstance(event, AgentNative):
        return NativeAgentNative(native_type=event.native_type)
    # justify-defect: the caller routes terminals separately and the event union is closed.
    raise AssertionError("event conversion received terminal or unknown event")


def _terminal_to_wire(
    terminal: AgentTerminal,
    *,
    versions: RuntimeVersions,
) -> NativeAgentTerminal:
    failure = _failure_to_wire(terminal.failure)

    structured = thaw_json_value(terminal.structured_output)
    if terminal.status == "succeeded" and not isinstance(structured, dict):
        return NativeAgentTerminal(
            status="failed",
            failure=NativeAgentFailure(kind="output_schema_violation"),
            final_text="",
            structured_output=None,
            session_ref=_session_ref(terminal.session_ref),
            usage=_optional_usage(terminal.usage),
            diagnostics=_diagnostics("turn_stream", "structured output was not an object"),
            sdk_version=versions.sdk,
            runtime_version=versions.runtime,
        )
    return NativeAgentTerminal(
        status=terminal.status,
        failure=failure,
        final_text=terminal.final_text if terminal.status == "succeeded" else "",
        structured_output=structured if isinstance(structured, dict) else None,
        session_ref=_session_ref(terminal.session_ref),
        usage=_optional_usage(terminal.usage),
        diagnostics=_provider_terminal_diagnostics(terminal.status, failure),
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _failure_to_wire(failure: AgentTerminalFailure | None) -> NativeAgentFailure | None:
    match failure:
        case None:
            return None
        case AgentQuotaExhausted():
            return NativeAgentFailure(kind="quota_exhausted")
        case AgentFailure():
            return NativeAgentFailure(kind=failure.cause)
        case _ as unreachable:
            assert_never(unreachable)


def _provider_terminal_diagnostics(
    status: NativeAgentTerminalStatus,
    failure: NativeAgentFailure | None,
) -> tuple[str, ...]:
    match status:
        case "succeeded":
            return ()
        case "failed" | "cancelled":
            if failure is None:
                return _diagnostics("turn_stream", f"provider terminal {status}")
            return _diagnostics("turn_stream", f"provider terminal {status}: {failure.kind}")
        case _:
            assert_never(status)


def _failed_terminal(
    kind: NativeAgentFailureKind,
    *,
    session: AgentSession | None,
    versions: RuntimeVersions,
    diagnostics: tuple[str, ...],
) -> NativeAgentTerminal:
    ref = session.ref if session is not None and session.ref_is_complete else None
    return NativeAgentTerminal(
        status="failed",
        failure=NativeAgentFailure(kind=kind),
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=diagnostics,
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _turn_not_started_terminal(
    error: TurnNotStarted,
    *,
    session: AgentSession | None,
    versions: RuntimeVersions,
) -> NativeAgentTerminal:
    if error.reason == "turn_timeout":
        return _failed_terminal(
            "turn_timeout",
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", "turn exceeded its catalog timeout"),
        )
    if error.reason != "cancelled":
        return _failed_terminal(
            "runtime_defect",
            session=session,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", f"turn not started: {error.reason}"),
        )
    ref = session.ref if session is not None and session.ref_is_complete else None
    return NativeAgentTerminal(
        status="cancelled",
        failure=None,
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=_diagnostics("turn_stream", "turn was cancelled before it started"),
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _runtime_error_kind(error: AgentRuntimeError) -> NativeAgentFailureKind:
    if isinstance(error, CredentialUnavailable):
        return "credential_unavailable"
    if isinstance(error, CredentialRejected):
        return "credential_rejected"
    if isinstance(error, ExecutableUnavailable):
        return "executable_unavailable"
    if isinstance(error, SdkUnavailable):
        return "sdk_unavailable"
    if isinstance(error, SessionUnavailable | SessionMismatch | McpUnavailable):
        return "session_unavailable"
    if isinstance(
        error,
        InvalidAgentRequest | UnsupportedCapability | McpConfigurationError | ConcurrentTurn,
    ):
        return "invalid_request"
    # justify-defect: the pinned runtime's error hierarchy is closed and fully mapped.
    raise AssertionError("unmapped AgentRuntimeError")


def _session_ref(ref: AgentSessionRef) -> NativeAgentSessionRef:
    return NativeAgentSessionRef.model_validate(thaw_json_value(ref_to_json(ref)))


def _optional_usage(value: Present[TokenUsage] | Absent) -> NativeAgentUsage | None:
    if isinstance(value, Absent):
        return None
    return _usage(value.value)


def _usage(value: TokenUsage) -> NativeAgentUsage:
    return NativeAgentUsage(
        input_tokens=value.input_tokens,
        output_tokens=value.output_tokens,
        total_tokens=value.total_tokens,
        reasoning_tokens=_presence(value.reasoning_tokens),
        cache_read_input_tokens=_presence(value.cache_read_input_tokens),
        cache_write_input_tokens=_presence(value.cache_write_input_tokens),
    )


def _presence(value: Present[int] | Absent) -> int | None:
    return value.value if isinstance(value, Present) else None


def _frame(
    command: NativeAgentCommand,
    sequence: int,
    event: NativeAgentEvent,
) -> NativeAgentFrame:
    return NativeAgentFrame(request_id=command.request_id, sequence=sequence, event=event)


__all__ = [
    "CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS",
    "CODEX_AGENT_HOST_STOP_GRACE_SECONDS",
    "CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS",
    "AgentRuntimeFactory",
    "AgentRuntimePort",
    "RuntimeVersions",
    "TurnLifecycle",
    "create_codex_agent_app",
    "resolve_runtime_versions",
    "turn_lifecycle",
]
