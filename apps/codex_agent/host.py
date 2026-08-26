"""Strict v2 Codex generation host over a private Unix-domain socket."""

from __future__ import annotations

import asyncio
import importlib.metadata
import ipaddress
import re
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, assert_never
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from apps.codex_agent.capacity import (
    PRODUCTION_CAPACITY_PATHS,
    CapacityPaths,
    capacity_is_available,
)
from apps.codex_agent.credential_state import (
    CredentialFileIdentity,
    CredentialStateUnavailable,
    EphemeralRuntimePaths,
    create_ephemeral_runtime_paths,
    enrolled_auth_identity,
    link_runtime_auth,
    remove_ephemeral_runtime_paths,
    sync_enrolled_auth_file,
    validate_enrolled_auth_file,
    validate_runtime_auth_link,
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
    AgentRuntimeConfig,
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
    CredentialRef,
    CredentialRejected,
    CredentialUnavailable,
    ExecutableUnavailable,
    InvalidAgentRequest,
    JsonSchemaAgentOutput,
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
from provider_runtime.types import CancelSignal
from pydantic import ValidationError
from starlette.types import Receive, Scope, Send

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    MAX_COMMAND_BODY_BYTES,
    ChatOperation,
    FailureKind,
    GenerationCommand,
    GenerationEvent,
    GenerationFailure,
    GenerationFrame,
    GenerationHealth,
    GenerationNative,
    GenerationPermissionRequest,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
    GenerationToolUse,
    GenerationUsage,
    GenerationUsageEvent,
    capacity_rejection_bytes,
    command_policy,
)
from nexus.services.codex_generation_operations import (
    CHAT_MCP_SERVER_NAME,
    ResolvedCodexGeneration,
    chat_mcp_allowed_tools,
    resolve_codex_generation,
)

_SDK_DISTRIBUTION = "openai-codex"
_RUNTIME_DISTRIBUTION = "openai-codex-cli-bin"
_PINNED_CODEX_VERSION = "0.144.4"
_SYNTHESIS_TEXT_RUN_BYTES = 32 * 1024
CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS = 10.0
CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS = float(
    max(
        [policy.runtime_close_timeout_seconds for policy in generation_policy.OPERATIONS.values()]
        + [
            generation_policy.chat_policy(profile).runtime_close_timeout_seconds
            for profile in generation_policy.CHAT_PROFILES
        ]
    )
)
_EXIT_MARGIN_SECONDS = 5.0
CODEX_AGENT_HOST_STOP_GRACE_SECONDS = int(
    CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS
    + CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS
    + _EXIT_MARGIN_SECONDS
)

type _AbortReason = Literal["cancelled", "policy_violation"]
type _HostPhase = Literal["session_open", "turn_stream", "runtime_close"]
type _RelayedFrame = bytes | None


@dataclass(frozen=True, slots=True)
class RuntimeVersions:
    sdk: str
    runtime: str


def resolve_runtime_versions() -> RuntimeVersions:
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
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[AgentEvent]: ...

    async def close(self) -> None: ...


type AgentRuntimeFactory = Callable[[AgentRuntimeConfig], AgentRuntimePort]


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
            raise RuntimeError("Codex generation slot released while free")
        self._claimed = False


@dataclass(slots=True)
class _TurnControl:
    request_id: UUID
    cancel: asyncio.Event
    reason: _AbortReason | None = None

    def interrupt(self, reason: _AbortReason) -> None:
        if reason == "policy_violation" or self.reason is None:
            self.reason = reason
        self.cancel.set()


class TurnLifecycle:
    """Own the admitted task and its exact request-scoped abort signal."""

    def __init__(self) -> None:
        self._active: asyncio.Task[None] | None = None
        self._control: _TurnControl | None = None
        self._fatal_reason: str | None = None

    @property
    def ready(self) -> bool:
        return self._fatal_reason is None

    def fail(self, reason: str) -> None:
        if not reason:
            raise ValueError("Codex generation host fatal reason must be non-empty")
        self._fatal_reason = reason

    def start(
        self,
        control: _TurnControl,
        turn: Coroutine[object, object, None],
    ) -> asyncio.Task[None]:
        if self._active is not None and not self._active.done():
            raise RuntimeError("Codex generation host started two turns")
        self._control = control
        self._active = asyncio.create_task(turn)
        return self._active

    def interrupt(self, request_id: UUID, reason: _AbortReason) -> None:
        control = self._control
        if control is not None and control.request_id == request_id:
            control.interrupt(reason)

    def finish(self, control: _TurnControl) -> None:
        if self._control is not control:
            raise RuntimeError("Codex generation lifecycle finished the wrong turn")
        self._control = None
        self._active = None

    async def drain(self, deadline_seconds: float) -> bool:
        active = self._active
        if active is None or active.done():
            return True
        done, _pending = await asyncio.wait({active}, timeout=deadline_seconds)
        return active in done


class _OwnedStreamingResponse(StreamingResponse):
    """Bind ASGI response-start/send failure to the independent turn owner."""

    def __init__(
        self,
        relay: asyncio.Queue[_RelayedFrame],
        owner: asyncio.Task[None],
        abandoned: asyncio.Event,
    ) -> None:
        self._owner = owner
        self._abandoned = abandoned
        super().__init__(
            _relay_frames(relay, owner, abandoned),
            media_type="application/x-ndjson",
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._abandoned.set()
            await _cancel_and_wait_owner(self._owner)


def turn_lifecycle(app: FastAPI) -> TurnLifecycle:
    lifecycle = app.state.turn_lifecycle
    if not isinstance(lifecycle, TurnLifecycle):
        raise AssertionError("Codex generation app has no turn lifecycle")
    return lifecycle


def create_codex_agent_app(
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory_root: Path,
    credential_file: Path,
    versions: RuntimeVersions,
    mcp_origin: str | None = None,
    chat_network_attested: bool = False,
    capacity_paths: CapacityPaths = PRODUCTION_CAPACITY_PATHS,
) -> FastAPI:
    generation_policy.validate_policy()
    if versions != RuntimeVersions(
        sdk=_PINNED_CODEX_VERSION,
        runtime=_PINNED_CODEX_VERSION,
    ):
        raise ValueError("Codex credential persistence is qualified only for pinned 0.144.4")
    _validate_host_configuration(
        working_directory_root=working_directory_root,
        credential_file=credential_file,
        mcp_origin=mcp_origin,
        chat_network_attested=chat_network_attested,
    )
    validate_enrolled_auth_file(credential_file)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    slot = _TurnSlot()
    lifecycle = TurnLifecycle()
    app.state.turn_lifecycle = lifecycle

    @app.get("/health", response_model=GenerationHealth)
    async def health() -> GenerationHealth:
        if not lifecycle.ready:
            raise HTTPException(status_code=503, detail="Codex generation host is not ready")
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version=versions.sdk,
            runtime_version=versions.runtime,
        )

    @app.post("/v2/generations")
    async def generation(request: Request) -> Response:
        if _content_type(request) != "application/json":
            raise HTTPException(status_code=415, detail="content type must be application/json")
        if request.headers.get("accept", "").strip().lower() != "application/x-ndjson":
            raise HTTPException(status_code=406, detail="accept must be application/x-ndjson")
        command = await _read_command(request)
        if isinstance(command.operation, ChatOperation) and not chat_network_attested:
            raise HTTPException(status_code=422, detail="ChatTools network is not attested")
        if not lifecycle.ready:
            raise HTTPException(status_code=503, detail="Codex generation host is not ready")

        if not slot.try_acquire():
            return _capacity_rejection()
        if not capacity_is_available(capacity_paths):
            slot.release()
            return _capacity_rejection()

        try:
            runtime_paths = create_ephemeral_runtime_paths(
                working_directory_root,
                command.request_id.hex,
            )
        except Exception:
            slot.release()
            raise
        accepted_at = _utc_now()
        control = _TurnControl(command.request_id, asyncio.Event())
        relay: asyncio.Queue[_RelayedFrame] = asyncio.Queue(maxsize=1)
        owner_started = asyncio.Event()
        execution_released = asyncio.Event()
        relay_abandoned = asyncio.Event()
        turn = _own_admitted_turn(
            command,
            accepted_at,
            control,
            relay,
            slot,
            lifecycle,
            owner_started,
            execution_released,
            relay_abandoned,
            runtime_factory=runtime_factory,
            runtime_paths=runtime_paths,
            working_directory_root=working_directory_root,
            credential_file=credential_file,
            mcp_origin=mcp_origin,
            versions=versions,
        )
        try:
            owner = lifecycle.start(control, turn)
        except BaseException:
            turn.close()
            remove_ephemeral_runtime_paths(
                runtime_paths,
                root=working_directory_root,
            )
            slot.release()
            raise
        try:
            await owner_started.wait()
        except BaseException:
            relay_abandoned.set()
            await _cancel_and_wait_owner(owner)
            if not owner_started.is_set():
                _finish_unstarted_turn(
                    control,
                    runtime_paths,
                    slot,
                    lifecycle,
                    working_directory_root=working_directory_root,
                )
            raise
        try:
            response = _OwnedStreamingResponse(relay, owner, relay_abandoned)
        except BaseException:
            relay_abandoned.set()
            await _cancel_and_wait_owner(owner)
            raise
        execution_released.set()
        return response

    @app.post("/v2/generations/{request_id}/cancel")
    async def cancel(request_id: UUID, request: Request) -> Response:
        await _require_empty_body(request)
        lifecycle.interrupt(request_id, "cancelled")
        return Response(status_code=204)

    @app.post("/v2/generations/{request_id}/policy-violation")
    async def policy_violation(request_id: UUID, request: Request) -> Response:
        await _require_empty_body(request)
        lifecycle.interrupt(request_id, "policy_violation")
        return Response(status_code=204)

    return app


def _validate_host_configuration(
    *,
    working_directory_root: Path,
    credential_file: Path,
    mcp_origin: str | None,
    chat_network_attested: bool,
) -> None:
    if not working_directory_root.is_absolute():
        raise ValueError("Codex generation working-directory root must be absolute")
    if not credential_file.is_absolute():
        raise ValueError("Codex generation credential file must be absolute")
    if type(chat_network_attested) is not bool:
        raise ValueError("chat_network_attested must be bool")
    if not chat_network_attested:
        return
    parsed = urlsplit(mcp_origin) if isinstance(mcp_origin, str) else None
    if (
        parsed is None
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.netloc != parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/internal/agent-tools/mcp"
        or bool(parsed.query)
        or bool(parsed.fragment)
        or not _is_public_dns_hostname(parsed.hostname)
    ):
        raise ValueError("attested ChatTools requires the canonical public HTTPS MCP endpoint")


def _is_public_dns_hostname(hostname: str) -> bool:
    if hostname != hostname.lower() or len(hostname) > 253:
        return False
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        return False
    if (
        "." not in hostname
        or hostname.endswith(".")
        or hostname == "localhost"
        or hostname.endswith((".localhost", ".local", ".internal"))
    ):
        return False
    return all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) is not None
        for label in hostname.split(".")
    )


async def _own_admitted_turn(
    command: GenerationCommand,
    accepted_at: str,
    control: _TurnControl,
    relay: asyncio.Queue[_RelayedFrame],
    slot: _TurnSlot,
    lifecycle: TurnLifecycle,
    owner_started: asyncio.Event,
    execution_released: asyncio.Event,
    relay_abandoned: asyncio.Event,
    *,
    runtime_factory: AgentRuntimeFactory,
    runtime_paths: EphemeralRuntimePaths,
    working_directory_root: Path,
    credential_file: Path,
    mcp_origin: str | None,
    versions: RuntimeVersions,
) -> None:
    credential_identity: CredentialFileIdentity | None = None
    execution_released_observed = False
    runtime_close_unproven = asyncio.Event()
    try:
        owner_started.set()
        # Cleanup ownership is established before any credential or runtime work.
        # The endpoint releases execution only after the streaming response exists,
        # leaving a deterministic cancellation point at the ownership handoff.
        await execution_released.wait()
        execution_released_observed = True
        credential_identity = enrolled_auth_identity(credential_file)
        async for line in _run_turn(
            command,
            accepted_at,
            control,
            runtime_factory=runtime_factory,
            runtime_paths=runtime_paths,
            credential_file=credential_file,
            credential_identity=credential_identity,
            runtime_close_unproven=runtime_close_unproven,
            mcp_origin=mcp_origin,
            versions=versions,
        ):
            await relay.put(line)
    finally:
        if runtime_close_unproven.is_set():
            lifecycle.fail("turn_runtime_close_unproven")
        try:
            try:
                if execution_released_observed:
                    if credential_identity is None:
                        lifecycle.fail("turn_credential_state_invalid")
                    else:
                        validate_runtime_auth_link(
                            runtime_paths.state_root_base
                            / "codex"
                            / "codex-personal"
                            / "auth.json",
                            credential_file,
                        )
                        sync_enrolled_auth_file(
                            credential_file,
                            expected_identity=credential_identity,
                        )
            except BaseException:
                lifecycle.fail("turn_credential_state_invalid")
                raise
        finally:
            try:
                try:
                    remove_ephemeral_runtime_paths(
                        runtime_paths,
                        root=working_directory_root,
                    )
                except BaseException:
                    lifecycle.fail("turn_workspace_cleanup_failed")
                    raise
            finally:
                try:
                    slot.release()
                finally:
                    try:
                        lifecycle.finish(control)
                    finally:
                        if not relay_abandoned.is_set():
                            await relay.put(None)


async def _relay_frames(
    relay: asyncio.Queue[_RelayedFrame],
    owner: asyncio.Task[None],
    abandoned: asyncio.Event,
) -> AsyncIterator[bytes]:
    try:
        while (chunk := await relay.get()) is not None:
            yield chunk
        await owner
    finally:
        abandoned.set()
        await _cancel_and_wait_owner(owner)


async def _cancel_and_wait_owner(owner: asyncio.Task[None]) -> None:
    if not owner.done():
        owner.cancel()
    completion = asyncio.gather(owner, return_exceptions=True)
    while not completion.done():
        try:
            await asyncio.shield(completion)
        except asyncio.CancelledError:
            continue
    completion.result()


def _finish_unstarted_turn(
    control: _TurnControl,
    runtime_paths: EphemeralRuntimePaths,
    slot: _TurnSlot,
    lifecycle: TurnLifecycle,
    *,
    working_directory_root: Path,
) -> None:
    try:
        remove_ephemeral_runtime_paths(
            runtime_paths,
            root=working_directory_root,
        )
    except BaseException:
        lifecycle.fail("turn_workspace_cleanup_failed")
        raise
    finally:
        try:
            slot.release()
        finally:
            lifecycle.finish(control)


async def _read_command(request: Request) -> GenerationCommand:
    declared = request.headers.get("content-length", "")
    if not declared.isdigit():
        raise HTTPException(status_code=411, detail="content length is required")
    if int(declared) > MAX_COMMAND_BODY_BYTES:
        raise HTTPException(status_code=413, detail="command exceeds its byte bound")
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > MAX_COMMAND_BODY_BYTES:
            raise HTTPException(status_code=413, detail="command exceeds its byte bound")
    try:
        return GenerationCommand.model_validate_json(bytes(payload))
    except ValidationError as error:
        raise HTTPException(status_code=422, detail="invalid generation command") from error


async def _require_empty_body(request: Request) -> None:
    if request.headers.get("content-length", "0") not in ("", "0"):
        raise HTTPException(status_code=422, detail="control request body is forbidden")
    async for chunk in request.stream():
        if chunk:
            raise HTTPException(status_code=422, detail="control request body is forbidden")


def _capacity_rejection() -> Response:
    return Response(capacity_rejection_bytes(), status_code=503, media_type="application/json")


class _StreamBudget:
    def __init__(self, command: GenerationCommand) -> None:
        self._bounds = command_policy(command).stream
        self._frames = 0
        self._bytes = 0

    def admits_intermediate(self, line: bytes) -> bool:
        return (
            len(line) <= self._bounds.max_frame_bytes
            and self._frames < self._bounds.max_frames - 1
            and self._bytes + len(line) + self._bounds.max_frame_bytes
            <= self._bounds.max_stream_bytes
        )

    def admits_terminal(self, line: bytes) -> bool:
        return (
            len(line) <= self._bounds.max_frame_bytes
            and self._frames < self._bounds.max_frames
            and self._bytes + len(line) <= self._bounds.max_stream_bytes
        )

    def record(self, line: bytes) -> None:
        self._frames += 1
        self._bytes += len(line)


async def _run_turn(
    command: GenerationCommand,
    accepted_at: str,
    control: _TurnControl,
    *,
    runtime_factory: AgentRuntimeFactory,
    runtime_paths: EphemeralRuntimePaths,
    credential_file: Path,
    credential_identity: CredentialFileIdentity,
    runtime_close_unproven: asyncio.Event,
    mcp_origin: str | None,
    versions: RuntimeVersions,
) -> AsyncIterator[bytes]:
    policy = command_policy(command)
    sequence = 0
    budget = _StreamBudget(command)
    runtime: AgentRuntimePort | None = None
    runtime_auth_link: Path | None = None
    session: AgentSession | None = None
    operation: ResolvedCodexGeneration | None = None
    terminal: GenerationTerminal | None = None
    terminal_seen = False
    credential_sync_failed = False
    synthesis_text: list[str] = []
    synthesis_text_bytes = 0
    secret_table: dict[str, str] = {}

    credential: CredentialRef | None = None
    if command.tool_grant is not None:
        reference_name = f"generation-{command.request_id.hex}-{uuid4().hex}"
        credential = CredentialRef(
            kind="secret_reference",
            profile_key="codex-personal",
            name=reference_name,
        )
        secret_table[reference_name] = f"Bearer {command.tool_grant.token.get_secret_value()}"

    async def resolve_secret(name: str) -> str:
        try:
            return secret_table[name]
        except KeyError as error:
            raise CredentialUnavailable("generation tool grant is unavailable") from error

    def serialize(event: GenerationEvent) -> bytes:
        return (
            GenerationFrame(
                request_id=command.request_id, sequence=sequence, event=event
            ).model_dump_json()
            + "\n"
        ).encode()

    def relay(events: list[GenerationEvent]) -> list[bytes]:
        nonlocal sequence, terminal
        lines: list[bytes] = []
        for event in events:
            line = serialize(event)
            if not budget.admits_intermediate(line):
                terminal = _failed_terminal(
                    "output_limit_exceeded",
                    session=session,
                    accepted_at=accepted_at,
                    versions=versions,
                    diagnostics=_diagnostics("turn_stream", "stream bound exceeded"),
                )
                break
            budget.record(line)
            sequence += 1
            lines.append(line)
        return lines

    def flush_synthesis_text() -> list[GenerationEvent]:
        nonlocal synthesis_text_bytes
        if not synthesis_text:
            return []
        text = "".join(synthesis_text)
        synthesis_text.clear()
        synthesis_text_bytes = 0
        return [GenerationText(text=text)]

    try:
        runtime_auth_link = link_runtime_auth(credential_file, runtime_paths)
        operation = resolve_codex_generation(
            command,
            working_directory=runtime_paths.working_directory,
            mcp_origin=mcp_origin,
            tool_credential=credential,
        )
        runtime = runtime_factory(
            AgentRuntimeConfig(
                state_root_base=runtime_paths.state_root_base,
                max_turn_seconds=float(policy.turn_timeout_seconds),
                secret_resolver=resolve_secret if credential is not None else None,
            )
        )
        try:
            async with asyncio.timeout(float(policy.session_open_timeout_seconds)):
                session = await runtime.open_session(operation.session)
        except TimeoutError:
            terminal = _failed_terminal(
                "session_unavailable",
                session=None,
                accepted_at=accepted_at,
                versions=versions,
                diagnostics=_diagnostics("session_open", "deadline expired"),
            )
        else:
            async for event in runtime.stream_turn(
                session, operation.turn, approvals=None, cancel=control.cancel
            ):
                if terminal_seen:
                    terminal = _failed_terminal(
                        "runtime_defect",
                        session=session,
                        accepted_at=accepted_at,
                        versions=versions,
                        diagnostics=_diagnostics("turn_stream", "frame after terminal"),
                    )
                    break
                if isinstance(event, AgentTerminal):
                    terminal_seen = True
                    terminal = _terminal_to_wire(
                        event,
                        operation=operation,
                        accepted_at=accepted_at,
                        versions=versions,
                    )
                    continue
                if isinstance(event, AgentText):
                    if operation.capability == "ChatTools":
                        # Chat text is never held: each provider event is relayed now and
                        # split at the named byte run. Immediate event-granular relay is a
                        # strict implementation of the policy's maximum flush interval.
                        maximum = policy.stream.text_flush_bytes or _SYNTHESIS_TEXT_RUN_BYTES
                        for piece in _split_utf8(event.text, maximum):
                            for line in relay([GenerationText(text=piece)]):
                                yield line
                    else:
                        for piece in _split_utf8(event.text, _SYNTHESIS_TEXT_RUN_BYTES):
                            piece_bytes = len(piece.encode())
                            if (
                                synthesis_text
                                and synthesis_text_bytes + piece_bytes > _SYNTHESIS_TEXT_RUN_BYTES
                            ):
                                for line in relay(flush_synthesis_text()):
                                    yield line
                            synthesis_text.append(piece)
                            synthesis_text_bytes += piece_bytes
                            if synthesis_text_bytes == _SYNTHESIS_TEXT_RUN_BYTES:
                                for line in relay(flush_synthesis_text()):
                                    yield line
                    if terminal is not None:
                        break
                    continue

                for line in relay(flush_synthesis_text()):
                    yield line
                wire = _event_to_wire(event)
                forbidden = isinstance(event, AgentPermissionRequest) or (
                    isinstance(event, AgentToolUse)
                    and not _tool_is_legal(event, operation.capability)
                )
                for line in relay([wire]):
                    yield line
                if forbidden:
                    control.interrupt("policy_violation")
                    terminal = _failed_terminal(
                        "policy_violation",
                        session=session,
                        accepted_at=accepted_at,
                        versions=versions,
                        diagnostics=_diagnostics("turn_stream", "forbidden capability event"),
                    )
                    break
                if terminal is not None:
                    break
            if terminal is None:
                terminal = _failed_terminal(
                    "runtime_defect",
                    session=session,
                    accepted_at=accepted_at,
                    versions=versions,
                    diagnostics=_diagnostics("turn_stream", "stream ended without terminal"),
                )
            elif terminal_seen:
                for line in relay(flush_synthesis_text()):
                    yield line
    except CredentialStateUnavailable:
        terminal = _failed_terminal(
            "credential_unavailable",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("session_open", "credential linking failed"),
        )
    except TurnNotStarted as error:
        terminal = _turn_not_started_terminal(
            error, session=session, accepted_at=accepted_at, versions=versions
        )
    except AgentRuntimeError as error:
        terminal = _failed_terminal(
            _runtime_error_kind(error),
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    except AgentRuntimeDefect as error:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    except Exception as error:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", type(error).__name__),
        )
    finally:
        # A completed/interrupted turn has no authority to resolve another MCP
        # request while its process tree is being reaped.
        secret_table.clear()
        if runtime is not None:
            try:
                await close_runtime_before_release(
                    runtime,
                    float(policy.runtime_close_timeout_seconds),
                    runtime_close_unproven=runtime_close_unproven,
                )
            except Exception as error:
                if control.reason != "policy_violation":
                    terminal = _failed_terminal(
                        "runtime_defect",
                        session=session,
                        accepted_at=accepted_at,
                        versions=versions,
                        diagnostics=_diagnostics("runtime_close", type(error).__name__),
                    )

    if runtime_auth_link is not None:
        try:
            validate_runtime_auth_link(runtime_auth_link, credential_file)
            sync_enrolled_auth_file(
                credential_file,
                expected_identity=credential_identity,
            )
        except CredentialStateUnavailable as error:
            credential_sync_failed = True
            terminal = _failed_terminal(
                "runtime_defect",
                session=session,
                accepted_at=accepted_at,
                versions=versions,
                diagnostics=_diagnostics("runtime_close", type(error).__name__),
            )

    if control.reason == "policy_violation":
        terminal = _failed_terminal(
            "policy_violation",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", "policy violation abort"),
        )
    elif control.reason == "cancelled" and not credential_sync_failed:
        terminal = _cancelled_terminal(session=session, accepted_at=accepted_at, versions=versions)
    if terminal is None:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", "turn produced no terminal"),
        )
    line = serialize(terminal)
    if not budget.admits_terminal(line):
        terminal = _failed_terminal(
            "output_limit_exceeded",
            session=session,
            accepted_at=accepted_at,
            versions=versions,
            diagnostics=_diagnostics("turn_stream", "terminal exceeded stream bound"),
        )
        line = serialize(terminal)
    yield line


async def _bounded_runtime_close(runtime: AgentRuntimePort, timeout_seconds: float) -> None:
    async with asyncio.timeout(timeout_seconds):
        await runtime.close()


async def close_runtime_before_release(
    runtime: AgentRuntimePort,
    timeout_seconds: float,
    *,
    runtime_close_unproven: asyncio.Event,
) -> None:
    """Finish the bounded native close despite repeated caller cancellation."""

    close_task = asyncio.create_task(_bounded_runtime_close(runtime, timeout_seconds))
    try:
        await asyncio.shield(close_task)
    except asyncio.CancelledError as cancellation:
        # Repeated ASGI cancellation must not reach the native close through an
        # unshielded follow-up await and release the single admission slot early.
        while not close_task.done():
            try:
                await asyncio.shield(close_task)
            except asyncio.CancelledError:
                continue
        try:
            close_task.result()
        except BaseException as close_error:
            runtime_close_unproven.set()
            raise cancellation from close_error
        raise cancellation
    except BaseException:
        runtime_close_unproven.set()
        raise


def _tool_is_legal(event: AgentToolUse, capability: generation_policy.Capability) -> bool:
    if capability != "ChatTools":
        return False
    return event.name in {f"{CHAT_MCP_SERVER_NAME}/{tool}" for tool in chat_mcp_allowed_tools()}


def _event_to_wire(event: AgentEvent) -> GenerationEvent:
    if isinstance(event, AgentToolUse):
        return GenerationToolUse(
            tool_call_id=event.tool_call_id,
            name=event.name,
            phase=event.phase,
            succeeded=event.succeeded,
        )
    if isinstance(event, AgentUsage):
        return GenerationUsageEvent(usage=_usage(event.usage))
    if isinstance(event, AgentPermissionRequest):
        return GenerationPermissionRequest(
            operation=event.request.operation,
            summary=event.request.summary[:1_000],
            tool_name=event.request.tool_name,
            decision=event.decision,
        )
    if isinstance(event, AgentNative):
        return GenerationNative(native_type=event.native_type)
    raise AssertionError("event conversion received terminal, text, or unknown event")


def _terminal_to_wire(
    terminal: AgentTerminal,
    *,
    operation: ResolvedCodexGeneration,
    accepted_at: str,
    versions: RuntimeVersions,
) -> GenerationTerminal:
    failure = _failure_to_wire(terminal.failure)
    structured = thaw_json_value(terminal.structured_output)
    if terminal.status == "succeeded" and isinstance(
        operation.session.output, JsonSchemaAgentOutput
    ):
        if not isinstance(structured, dict):
            return _failed_terminal(
                "output_schema_violation",
                session_ref=terminal.session_ref,
                accepted_at=accepted_at,
                versions=versions,
                diagnostics=_diagnostics("turn_stream", "structured output was not an object"),
            )
        structured_output = structured
    else:
        structured_output = None
    return GenerationTerminal(
        status=terminal.status,
        failure=failure,
        final_text=terminal.final_text if terminal.status == "succeeded" else "",
        structured_output=structured_output,
        session_ref=_session_ref(terminal.session_ref),
        usage=_optional_usage(terminal.usage),
        diagnostics=_runtime_terminal_diagnostics(terminal.status, failure),
        accepted_at=accepted_at,
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _failure_to_wire(
    failure: AgentTerminalFailure | None,
) -> GenerationFailure | None:
    match failure:
        case None:
            return None
        case AgentQuotaExhausted():
            return GenerationFailure(kind="quota_exhausted")
        case AgentFailure():
            return GenerationFailure(kind=failure.cause)
        case _ as unreachable:
            assert_never(unreachable)


def _failed_terminal(
    kind: FailureKind,
    *,
    session: AgentSession | None = None,
    session_ref: AgentSessionRef | None = None,
    accepted_at: str,
    versions: RuntimeVersions,
    diagnostics: tuple[str, ...],
) -> GenerationTerminal:
    ref = session_ref
    if ref is None and session is not None and session.ref_is_complete:
        ref = session.ref
    return GenerationTerminal(
        status="failed",
        failure=GenerationFailure(kind=kind),
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=diagnostics,
        accepted_at=accepted_at,
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _cancelled_terminal(
    *,
    session: AgentSession | None,
    accepted_at: str,
    versions: RuntimeVersions,
) -> GenerationTerminal:
    ref = session.ref if session is not None and session.ref_is_complete else None
    return GenerationTerminal(
        status="cancelled",
        failure=None,
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=_diagnostics("turn_stream", "turn was cancelled"),
        accepted_at=accepted_at,
        sdk_version=versions.sdk,
        runtime_version=versions.runtime,
    )


def _turn_not_started_terminal(
    error: TurnNotStarted,
    *,
    session: AgentSession | None,
    accepted_at: str,
    versions: RuntimeVersions,
) -> GenerationTerminal:
    if error.reason == "cancelled":
        return _cancelled_terminal(session=session, accepted_at=accepted_at, versions=versions)
    kind: FailureKind = "turn_timeout" if error.reason == "turn_timeout" else "runtime_defect"
    return _failed_terminal(
        kind,
        session=session,
        accepted_at=accepted_at,
        versions=versions,
        diagnostics=_diagnostics("turn_stream", f"turn not started: {error.reason}"),
    )


def _runtime_error_kind(error: AgentRuntimeError) -> FailureKind:
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
    raise AssertionError("unmapped AgentRuntimeError")


def _runtime_terminal_diagnostics(
    status: Literal["succeeded", "failed", "cancelled"],
    failure: GenerationFailure | None,
) -> tuple[str, ...]:
    if status == "succeeded":
        return ()
    reason = failure.kind if failure is not None else status
    return _diagnostics("turn_stream", f"runtime terminal {reason}")


def _diagnostics(phase: _HostPhase, reason: str) -> tuple[str, ...]:
    return (f"codex generation host {phase}: {reason}",)


def _session_ref(ref: AgentSessionRef) -> GenerationSessionRef:
    return GenerationSessionRef.model_validate(thaw_json_value(ref_to_json(ref)))


def _optional_usage(value: Present[TokenUsage] | Absent) -> GenerationUsage | None:
    return _usage(value.value) if isinstance(value, Present) else None


def _usage(value: TokenUsage) -> GenerationUsage:
    return GenerationUsage(
        input_tokens=value.input_tokens,
        output_tokens=value.output_tokens,
        total_tokens=value.total_tokens,
        reasoning_tokens=_presence(value.reasoning_tokens),
        cache_read_input_tokens=_presence(value.cache_read_input_tokens),
        cache_write_input_tokens=_presence(value.cache_write_input_tokens),
    )


def _presence(value: Present[int] | Absent) -> int | None:
    return value.value if isinstance(value, Present) else None


def _split_utf8(text: str, maximum_bytes: int) -> list[str]:
    pieces: list[str] = []
    offset = 0
    while offset < len(text):
        end = min(len(text), offset + maximum_bytes)
        while end > offset and len(text[offset:end].encode()) > maximum_bytes:
            end -= 1
        if end == offset:
            raise AssertionError("text bound cannot hold one code point")
        pieces.append(text[offset:end])
        offset = end
    return pieces


def _content_type(request: Request) -> str:
    return request.headers.get("content-type", "").split(";", 1)[0].strip().lower()


def _utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


__all__ = [
    "CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS",
    "CODEX_AGENT_HOST_STOP_GRACE_SECONDS",
    "CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS",
    "AgentRuntimeFactory",
    "AgentRuntimePort",
    "RuntimeVersions",
    "TurnLifecycle",
    "close_runtime_before_release",
    "create_codex_agent_app",
    "resolve_runtime_versions",
    "turn_lifecycle",
]
