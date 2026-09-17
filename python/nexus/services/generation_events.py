"""Route-neutral events for one frozen Nexus generation.

Codex and API transports keep separate native contracts.  This module is the
single Nexus-owned composition point: it projects both closed event families
without allowing one backend adapter to import or impersonate the other.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, assert_never

from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import ResponsePayload, StreamOutcome, Succeeded, TokenUsage

from nexus.schemas.presence import Presence
from nexus.services.codex_generation_contract import (
    GenerationFrame,
    GenerationNative,
    GenerationPermissionRequest,
    GenerationTerminal,
    GenerationText,
    GenerationToolUse,
    GenerationUsage,
    GenerationUsageEvent,
)
from nexus.services.provider_generation_contract import (
    ProviderGenerationEvent,
    ProviderTerminal,
    ProviderTextDelta,
    ProviderToolProposed,
    ProviderUsageObserved,
)

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import ToolCallResolution

type BackendRoute = Literal["CodexPersonal", "ProviderApi"]


@dataclass(frozen=True, slots=True)
class BackendTextDelta:
    kind: Literal["TextDelta"] = field(default="TextDelta", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    text: str


@dataclass(frozen=True, slots=True)
class BackendUsageObserved:
    kind: Literal["UsageObserved"] = field(default="UsageObserved", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    usage: GenerationUsage | TokenUsage


@dataclass(frozen=True, slots=True)
class BackendToolProposed:
    """An API-native proposal awaiting the shared Nexus ToolAuthority."""

    kind: Literal["ToolProposed"] = field(default="ToolProposed", init=False)
    route: Literal["ProviderApi"] = field(default="ProviderApi", init=False)
    child_seq: int
    backend_seq: int
    proposal: ToolCallResolution = field(repr=False)


@dataclass(frozen=True, slots=True)
class BackendToolObserved:
    """A Codex MCP call already executed through the shared ToolAuthority."""

    kind: Literal["ToolObserved"] = field(default="ToolObserved", init=False)
    route: Literal["CodexPersonal"] = field(default="CodexPersonal", init=False)
    child_seq: Literal[1] = field(default=1, init=False)
    backend_seq: int
    observation: GenerationToolUse


@dataclass(frozen=True, slots=True)
class CodexTerminalEvidence:
    route: Literal["CodexPersonal"] = field(default="CodexPersonal", init=False)
    native: GenerationTerminal


@dataclass(frozen=True, slots=True)
class ProviderTerminalEvidence:
    """Complete provider terminal truth, excluding successor secret material.

    ``successor`` on the route-local event is Nexus continuation state rather
    than provider terminal evidence.  The backend runtime passes it only to the
    durable child lifecycle so observable event consumers cannot log it.
    """

    route: Literal["ProviderApi"] = field(default="ProviderApi", init=False)
    outcome: StreamOutcome = field(repr=False)
    correlation: Presence[str]


type BackendTerminalEvidence = CodexTerminalEvidence | ProviderTerminalEvidence


@dataclass(frozen=True, slots=True)
class BackendTerminal:
    kind: Literal["Terminal"] = field(default="Terminal", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    evidence: BackendTerminalEvidence


type BackendEvent = (
    BackendTextDelta
    | BackendUsageObserved
    | BackendToolProposed
    | BackendToolObserved
    | BackendTerminal
)


def project_codex_generation_frame(frame: GenerationFrame) -> BackendEvent | None:
    """Project one already-validated Codex frame into the Nexus event union.

    Permission requests and native diagnostics carry no Nexus event; the client
    stream validator is their only reader.
    """

    event = frame.event
    match event:
        case GenerationText(text=text):
            return BackendTextDelta(
                route="CodexPersonal",
                child_seq=1,
                backend_seq=frame.sequence,
                text=text,
            )
        case GenerationUsageEvent(usage=usage):
            return BackendUsageObserved(
                route="CodexPersonal",
                child_seq=1,
                backend_seq=frame.sequence,
                usage=usage,
            )
        case GenerationToolUse():
            return BackendToolObserved(backend_seq=frame.sequence, observation=event)
        case GenerationPermissionRequest() | GenerationNative():
            return None
        case GenerationTerminal():
            return BackendTerminal(
                route="CodexPersonal",
                child_seq=1,
                backend_seq=frame.sequence,
                evidence=CodexTerminalEvidence(native=event),
            )
        case other:
            assert_never(other)


def project_provider_generation_event(event: ProviderGenerationEvent) -> BackendEvent:
    """Project one route-local API event without exposing continuation bytes."""

    match event:
        case ProviderTextDelta():
            return BackendTextDelta(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                text=event.text,
            )
        case ProviderUsageObserved():
            return BackendUsageObserved(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                usage=event.usage,
            )
        case ProviderToolProposed():
            return BackendToolProposed(
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                proposal=event.proposal,
            )
        case ProviderTerminal():
            return BackendTerminal(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                evidence=ProviderTerminalEvidence(
                    outcome=_public_provider_outcome(event.outcome),
                    correlation=event.correlation,
                ),
            )
        case other:
            assert_never(other)


def _public_provider_outcome(outcome: StreamOutcome) -> StreamOutcome:
    """Remove opaque native continuation material from observable terminal truth."""

    if not isinstance(outcome, Succeeded):
        return outcome
    return Succeeded(
        meta=outcome.meta,
        response=ResponsePayload(
            content=outcome.response.content,
            continuation=RuntimeAbsent(),
        ),
    )


__all__ = [
    "BackendEvent",
    "BackendRoute",
    "BackendTerminal",
    "BackendTerminalEvidence",
    "BackendTextDelta",
    "BackendToolObserved",
    "BackendToolProposed",
    "BackendUsageObserved",
    "CodexTerminalEvidence",
    "ProviderTerminalEvidence",
    "project_codex_generation_frame",
    "project_provider_generation_event",
]
