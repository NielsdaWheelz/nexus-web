"""Route-local values for durable ProviderRuntime model turns.

The contract stops at the transport boundary: no domain owner, tool executor,
credential, policy lookup, or ledger mutation.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from provider_runtime.continuation import (
    decode_continuation,
    encode_continuation,
    pending_tool_calls,
)
from provider_runtime.errors import InvalidRequest, RuntimeDefect
from provider_runtime.types import (
    ContinuationArtifact,
    ProviderTarget,
    StreamOutcome,
    TokenUsage,
    ToolCall,
)

from nexus.schemas.presence import Presence
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import PublishedTools, ToolCallResolution

MAX_PROVIDER_TURN_CONTINUATION_BYTES = 16 * 1024 * 1024


class ProviderGenerationDefect(RuntimeDefect):
    """A broken frozen request, persisted continuation, or provider stream."""

    def __init__(self, *, origin: Literal["intent", "plan", "provider_stream"], message: str):
        # justify-defect: admission already proved these same-system facts,
        # continuation plaintext is authenticated ledger state, and the
        # ProviderRuntime stream is a closed first-party contract.
        super().__init__(
            origin=origin, code="provider_generation_contract_breached", message=message
        )


@dataclass(frozen=True, slots=True)
class ProviderModelTools:
    """Provider-native publication bound to its exact frozen authority."""

    snapshot: FrozenToolPlanSnapshot
    publication: PublishedTools = field(repr=False)


@dataclass(frozen=True, slots=True)
class ProviderToolResult:
    """One ToolAuthority result returned to the matching provider call id."""

    provider_call_id: str
    output: str = field(repr=False)
    is_error: bool

    def __post_init__(self) -> None:
        if not self.provider_call_id or len(self.provider_call_id.encode("utf-8")) > 1_024:
            raise ValueError("provider tool-result call id must be bounded nonblank text")


@dataclass(frozen=True, slots=True)
class ProviderTurnContinuation:
    """Canonical successor material; the durable ledger seals these bytes."""

    source_turn_seq: int
    provider_call_ids: tuple[str, ...]
    canonical_bytes: bytes = field(repr=False)
    fingerprint: str

    def __post_init__(self) -> None:
        if self.source_turn_seq < 1:
            raise ValueError("provider continuation source turn must be positive")
        if not self.provider_call_ids or len(set(self.provider_call_ids)) != len(
            self.provider_call_ids
        ):
            raise ValueError("provider continuation call ids must be nonempty and unique")
        if provider_turn_continuation_fingerprint(self.canonical_bytes) != self.fingerprint:
            raise ValueError("provider continuation fingerprint differs from its bytes")


@dataclass(frozen=True, slots=True)
class DecodedProviderTurnContinuation:
    """Authenticated resume facts accepted from canonical continuation bytes."""

    tool_calls: tuple[ToolCall, ...] = field(repr=False)
    artifact: ContinuationArtifact = field(repr=False)


@dataclass(frozen=True, slots=True)
class ProviderTextDelta:
    kind: Literal["TextDelta"] = field(default="TextDelta", init=False)
    turn_seq: int
    provider_seq: int
    text: str


@dataclass(frozen=True, slots=True)
class ProviderUsageObserved:
    kind: Literal["UsageObserved"] = field(default="UsageObserved", init=False)
    turn_seq: int
    provider_seq: int
    usage: TokenUsage


@dataclass(frozen=True, slots=True)
class ProviderToolProposed:
    kind: Literal["ToolProposed"] = field(default="ToolProposed", init=False)
    turn_seq: int
    provider_seq: int
    proposal: ToolCallResolution


@dataclass(frozen=True, slots=True)
class ProviderTerminal:
    kind: Literal["Terminal"] = field(default="Terminal", init=False)
    turn_seq: int
    provider_seq: int
    outcome: StreamOutcome
    correlation: Presence[str]
    successor: Presence[ProviderTurnContinuation]


type ProviderGenerationEvent = (
    ProviderTextDelta | ProviderUsageObserved | ProviderToolProposed | ProviderTerminal
)


def encode_provider_turn_continuation(
    *,
    source_turn_seq: int,
    target: ProviderTarget,
    codec_id: str,
    tool_calls: tuple[ToolCall, ...],
    artifact: ContinuationArtifact,
) -> ProviderTurnContinuation:
    """Persist only the library's complete native prefix under the ledger seal."""

    if source_turn_seq < 1:
        raise ValueError("provider continuation source turn must be positive")
    if artifact.target != target or artifact.codec_id != codec_id:
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider continuation differs from the frozen target or codec",
        )
    try:
        if pending_tool_calls(artifact) != tool_calls:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider continuation calls differ from terminal calls",
            )
        encoded = encode_continuation(artifact)
    except InvalidRequest as error:
        raise ProviderGenerationDefect(
            origin="provider_stream", message="provider continuation is invalid"
        ) from error
    return ProviderTurnContinuation(
        source_turn_seq=source_turn_seq,
        provider_call_ids=tuple(call.id for call in tool_calls),
        canonical_bytes=encoded,
        fingerprint=provider_turn_continuation_fingerprint(encoded),
    )


def decode_provider_turn_continuation(
    encoded: bytes,
    *,
    target: ProviderTarget,
    codec_id: str,
) -> DecodedProviderTurnContinuation:
    """Accept the library artifact after ledger authentication and target binding."""

    if not encoded or len(encoded) > MAX_PROVIDER_TURN_CONTINUATION_BYTES:
        raise ProviderGenerationDefect(
            origin="plan", message="provider turn continuation is outside its durable byte bound"
        )
    try:
        artifact = decode_continuation(encoded, target, codec_id)
        calls = pending_tool_calls(artifact)
    except InvalidRequest as error:
        raise ProviderGenerationDefect(
            origin="plan", message="provider continuation is invalid"
        ) from error
    return DecodedProviderTurnContinuation(
        tool_calls=calls,
        artifact=artifact,
    )


def provider_turn_continuation_fingerprint(value: bytes) -> str:
    """Return the durable identity of one canonical route continuation."""

    return hashlib.sha256(b"nexus.provider-turn-continuation.v2\0" + value).hexdigest()
