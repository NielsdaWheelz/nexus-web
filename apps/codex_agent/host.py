"""Metadata-only AgentRuntime host over a private Unix-domain socket."""

from __future__ import annotations

import importlib.metadata
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Protocol

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

from nexus.services.native_agent_contract import (
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
    NativeAgentText,
    NativeAgentToolUse,
    NativeAgentUsage,
    NativeAgentUsageEvent,
)
from nexus.services.native_agent_operations import resolve_native_agent_operation

_SDK_DISTRIBUTION = "openai-codex"
_RUNTIME_DISTRIBUTION = "openai-codex-cli-bin"


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
            raise RuntimeError("Codex agent turn slot released while free")
        self._claimed = False


def create_codex_agent_app(
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory: Path,
    capacity_paths: CapacityPaths = PRODUCTION_CAPACITY_PATHS,
) -> FastAPI:
    if not working_directory.is_absolute():
        raise ValueError("Codex agent working directory must be absolute")
    app = FastAPI()
    one_turn = _TurnSlot()

    @app.get("/health", response_model=NativeAgentHealth)
    async def health() -> NativeAgentHealth:
        return NativeAgentHealth()

    @app.post("/v1/turns")
    async def turn(command: NativeAgentCommand, request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise HTTPException(status_code=415, detail="content type must be application/json")
        if request.headers.get("accept", "").strip().lower() != "application/x-ndjson":
            raise HTTPException(status_code=406, detail="accept must be application/x-ndjson")

        if not one_turn.try_acquire():
            return _capacity_rejection()
        if not capacity_is_available(capacity_paths):
            one_turn.release()
            return _capacity_rejection()

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for frame in _run_turn(
                    command,
                    runtime_factory=runtime_factory,
                    working_directory=working_directory,
                ):
                    yield frame.model_dump_json().encode("utf-8") + b"\n"
            finally:
                one_turn.release()

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    return app


def _capacity_rejection() -> Response:
    return Response(
        content=NativeAgentCapacityRejection().model_dump_json(),
        status_code=503,
        media_type="application/json",
    )


async def _run_turn(
    command: NativeAgentCommand,
    *,
    runtime_factory: AgentRuntimeFactory,
    working_directory: Path,
) -> AsyncIterator[NativeAgentFrame]:
    try:
        sdk_version, runtime_version = _runtime_versions()
    except Exception:
        yield _frame(
            command,
            0,
            _failed_terminal(
                "runtime_defect",
                session=None,
                sdk_version="unavailable",
                runtime_version="unavailable",
            ),
        )
        return
    sequence = 0
    runtime: AgentRuntimePort | None = None
    session: AgentSession | None = None
    terminal: NativeAgentTerminal | None = None
    terminal_seen = False
    try:
        runtime = runtime_factory()
        operation = resolve_native_agent_operation(command, working_directory=working_directory)
        session = await runtime.open_session(operation.session)
        async for event in runtime.stream_turn(session, operation.turn, approvals=None):
            if terminal_seen:
                terminal = _failed_terminal(
                    "runtime_defect",
                    session=session,
                    sdk_version=sdk_version,
                    runtime_version=runtime_version,
                )
                break
            if isinstance(event, AgentToolUse | AgentPermissionRequest):
                yield _frame(command, sequence, _event_to_wire(event))
                sequence += 1
                terminal = _failed_terminal(
                    "policy_violation",
                    session=session,
                    sdk_version=sdk_version,
                    runtime_version=runtime_version,
                )
                break
            if isinstance(event, AgentTerminal):
                terminal_seen = True
                terminal = _terminal_to_wire(
                    event,
                    sdk_version=sdk_version,
                    runtime_version=runtime_version,
                )
                continue
            yield _frame(command, sequence, _event_to_wire(event))
            sequence += 1
        if terminal is None:
            terminal = _failed_terminal(
                "runtime_defect",
                session=session,
                sdk_version=sdk_version,
                runtime_version=runtime_version,
            )
    except TurnNotStarted as error:
        terminal = _turn_not_started_terminal(
            error,
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    except AgentRuntimeError as error:
        terminal = _failed_terminal(
            _runtime_error_kind(error),
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    except AgentRuntimeDefect:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    except Exception:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    finally:
        if runtime is not None:
            try:
                await runtime.close()
            except Exception:
                if (
                    terminal is None
                    or terminal.failure is None
                    or terminal.failure.kind != "policy_violation"
                ):
                    terminal = _failed_terminal(
                        "runtime_defect",
                        session=session,
                        sdk_version=sdk_version,
                        runtime_version=runtime_version,
                    )
    if terminal is None:
        terminal = _failed_terminal(
            "runtime_defect",
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    yield _frame(command, sequence, terminal)


def _event_to_wire(event: AgentEvent) -> NativeAgentEvent:
    if isinstance(event, AgentText):
        return NativeAgentText(text=event.text)
    if isinstance(event, AgentToolUse):
        return NativeAgentToolUse(
            tool_call_id=event.tool_call_id,
            name=event.name,
            phase=event.phase,
            payload=None,
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
        return NativeAgentNative(
            native_type=event.native_type,
            payload={},
        )
    raise AssertionError("event conversion received terminal or unknown event")


def _terminal_to_wire(
    terminal: AgentTerminal,
    *,
    sdk_version: str,
    runtime_version: str,
) -> NativeAgentTerminal:
    failure = None
    if isinstance(terminal.failure, AgentQuotaExhausted):
        failure = NativeAgentFailure(kind="quota_exhausted")
    elif isinstance(terminal.failure, AgentFailure):
        failure = NativeAgentFailure(kind=terminal.failure.cause)

    structured = thaw_json_value(terminal.structured_output)
    if terminal.status == "succeeded" and not isinstance(structured, dict):
        return NativeAgentTerminal(
            status="failed",
            failure=NativeAgentFailure(kind="output_schema_violation"),
            final_text="",
            structured_output=None,
            session_ref=_session_ref(terminal.session_ref),
            usage=_optional_usage(terminal.usage),
            diagnostics=(),
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    return NativeAgentTerminal(
        status=terminal.status,
        failure=failure,
        final_text=terminal.final_text if terminal.status == "succeeded" else "",
        structured_output=structured if isinstance(structured, dict) else None,
        session_ref=_session_ref(terminal.session_ref),
        usage=_optional_usage(terminal.usage),
        diagnostics=(),
        sdk_version=sdk_version,
        runtime_version=runtime_version,
    )


def _failed_terminal(
    kind: NativeAgentFailureKind,
    *,
    session: AgentSession | None,
    sdk_version: str,
    runtime_version: str,
) -> NativeAgentTerminal:
    ref = session.ref if session is not None and session.ref_is_complete else None
    return NativeAgentTerminal(
        status="failed",
        failure=NativeAgentFailure(kind=kind),
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=(),
        sdk_version=sdk_version,
        runtime_version=runtime_version,
    )


def _turn_not_started_terminal(
    error: TurnNotStarted,
    *,
    session: AgentSession | None,
    sdk_version: str,
    runtime_version: str,
) -> NativeAgentTerminal:
    if error.reason == "turn_timeout":
        return _failed_terminal(
            "turn_timeout",
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    if error.reason != "cancelled":
        return _failed_terminal(
            "runtime_defect",
            session=session,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
    ref = session.ref if session is not None and session.ref_is_complete else None
    return NativeAgentTerminal(
        status="cancelled",
        failure=None,
        final_text="",
        structured_output=None,
        session_ref=_session_ref(ref) if ref is not None else None,
        usage=None,
        diagnostics=(),
        sdk_version=sdk_version,
        runtime_version=runtime_version,
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


def _runtime_versions() -> tuple[str, str]:
    return (
        importlib.metadata.version(_SDK_DISTRIBUTION),
        importlib.metadata.version(_RUNTIME_DISTRIBUTION),
    )


__all__ = ["AgentRuntimeFactory", "AgentRuntimePort", "create_codex_agent_app"]
