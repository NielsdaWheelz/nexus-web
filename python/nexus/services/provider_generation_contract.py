"""Route-local values for durable ProviderRuntime model turns.

The contract stops at the transport boundary: no domain owner, tool executor,
credential, policy lookup, or ledger mutation.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from provider_runtime.continuation import decode_continuation, encode_continuation
from provider_runtime.errors import InvalidRequest, RuntimeDefect
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import (
    ContinuationArtifact,
    ProviderTarget,
    StreamOutcome,
    TokenUsage,
    ToolCall,
    canonical_json_bytes,
    freeze_json_object,
    thaw_json_value,
)
from provider_runtime.types import Present as RuntimePresent
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_spec import GenerationSpec
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import PublishedTools, ToolCallResolution

MAX_PROVIDER_TURN_CONTINUATION_BYTES = 16 * 1024 * 1024
_CONTINUATION_SCHEMA = "nexus-provider-turn-continuation.v1"


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

    source_turn_seq: int
    assistant_text: str = field(repr=False)
    tool_calls: tuple[ToolCall, ...] = field(repr=False)
    native_continuation: RuntimePresent[ContinuationArtifact] | RuntimeAbsent = field(repr=False)


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


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _WireTarget(_WireModel):
    provider: str
    model: str


class _WireToolCall(_WireModel):
    id: str = Field(min_length=1, max_length=1_024)
    name: str = Field(min_length=1, max_length=256)
    arguments: dict[str, JsonValue]


class _WireContinuation(_WireModel):
    schema_version: Literal["nexus-provider-turn-continuation.v1"]
    generation_spec_fingerprint: str
    source_turn_seq: int = Field(gt=0)
    target: _WireTarget
    codec_id: str
    assistant_text: str
    tool_calls: tuple[_WireToolCall, ...] = Field(min_length=1)
    native_continuation: Presence[dict[str, JsonValue]]


def encode_provider_turn_continuation(
    *,
    spec: GenerationSpec,
    source_turn_seq: int,
    target: ProviderTarget,
    codec_id: str,
    assistant_text: str,
    tool_calls: tuple[ToolCall, ...],
    native_continuation: RuntimePresent[ContinuationArtifact] | RuntimeAbsent,
) -> ProviderTurnContinuation:
    """Encode complete typed assistant state plus optional native replay data."""

    if source_turn_seq < 1:
        raise ValueError("provider continuation source turn must be positive")
    _validate_tool_calls(tool_calls)
    if isinstance(native_continuation, RuntimePresent):
        artifact = native_continuation.value
        if artifact.target != target or artifact.codec_id != codec_id:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider native continuation differs from the frozen target or codec",
            )
        try:
            native: dict[str, object] = {
                "kind": "Present",
                "value": json.loads(encode_continuation(artifact)),
            }
        except (InvalidRequest, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider native continuation is not canonically encodable",
            ) from error
    else:
        native = {"kind": "Absent"}
    document = freeze_json_object(
        {
            "schema_version": _CONTINUATION_SCHEMA,
            "generation_spec_fingerprint": spec.fingerprint,
            "source_turn_seq": source_turn_seq,
            "target": {"provider": target.provider, "model": target.model},
            "codec_id": codec_id,
            "assistant_text": assistant_text,
            "tool_calls": [
                {
                    "id": call.id,
                    "name": call.name,
                    "arguments": thaw_json_value(
                        freeze_json_object(
                            call.arguments, context="provider continuation tool arguments"
                        )
                    ),
                }
                for call in tool_calls
            ],
            "native_continuation": native,
        },
        context="provider turn continuation",
    )
    encoded = canonical_json_bytes(document)
    if len(encoded) > MAX_PROVIDER_TURN_CONTINUATION_BYTES:
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider turn continuation exceeds its 16 MiB durable bound",
        )
    return ProviderTurnContinuation(
        source_turn_seq=source_turn_seq,
        provider_call_ids=tuple(call.id for call in tool_calls),
        canonical_bytes=encoded,
        fingerprint=provider_turn_continuation_fingerprint(encoded),
    )


def decode_provider_turn_continuation(
    encoded: bytes,
    *,
    spec: GenerationSpec,
    expected_source_turn_seq: int,
    target: ProviderTarget,
    codec_id: str,
) -> DecodedProviderTurnContinuation:
    """Accept only one canonical continuation for the exact frozen successor."""

    if not encoded or len(encoded) > MAX_PROVIDER_TURN_CONTINUATION_BYTES:
        raise ProviderGenerationDefect(
            origin="plan", message="provider turn continuation is outside its durable byte bound"
        )
    try:
        document = _WireContinuation.model_validate_json(encoded)
    except ValidationError as error:
        raise ProviderGenerationDefect(
            origin="plan", message="provider turn continuation is malformed"
        ) from error
    if document.generation_spec_fingerprint != spec.fingerprint:
        raise ProviderGenerationDefect(
            origin="plan", message="provider turn continuation belongs to another GenerationSpec"
        )
    if document.source_turn_seq != expected_source_turn_seq:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation source sequence is not the expected predecessor",
        )
    if (document.target.provider, document.target.model, document.codec_id) != (
        target.provider,
        target.model,
        codec_id,
    ):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation target differs from the frozen target",
        )
    tool_calls = tuple(
        ToolCall(id=call.id, name=call.name, arguments=call.arguments)
        for call in document.tool_calls
    )
    _validate_tool_calls(tool_calls)
    return DecodedProviderTurnContinuation(
        source_turn_seq=expected_source_turn_seq,
        assistant_text=document.assistant_text,
        tool_calls=tool_calls,
        native_continuation=_decode_native(document.native_continuation, target, codec_id),
    )


def _decode_native(
    value: Presence[dict[str, JsonValue]], target: ProviderTarget, codec_id: str
) -> RuntimePresent[ContinuationArtifact] | RuntimeAbsent:
    if isinstance(value, Absent):
        return RuntimeAbsent()
    if not isinstance(value, Present):
        raise ProviderGenerationDefect(
            origin="plan", message="provider native continuation Presence is malformed"
        )
    try:
        native_bytes = canonical_json_bytes(
            freeze_json_object(value.value, context="provider native continuation")
        )
        return RuntimePresent(decode_continuation(native_bytes, target, codec_id))
    except (InvalidRequest, TypeError, ValueError) as error:
        raise ProviderGenerationDefect(
            origin="plan", message="provider native continuation is invalid for the frozen target"
        ) from error


def _validate_tool_calls(calls: tuple[ToolCall, ...]) -> None:
    if not calls:
        raise ValueError("provider continuation requires at least one tool call")
    for call in calls:
        if not call.id or len(call.id.encode("utf-8")) > 1_024:
            raise ProviderGenerationDefect(
                origin="provider_stream", message="provider tool-call id is outside its bound"
            )
        if not call.name or len(call.name.encode("utf-8")) > 256:
            raise ProviderGenerationDefect(
                origin="provider_stream", message="provider tool-call name is outside its bound"
            )
        try:
            freeze_json_object(call.arguments, context="provider tool-call arguments")
        except (TypeError, ValueError) as error:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider tool-call arguments are outside canonical JSON",
            ) from error
    ids = [call.id for call in calls]
    if len(set(ids)) != len(ids):
        raise ProviderGenerationDefect(
            origin="provider_stream", message="provider emitted duplicate tool-call ids in one turn"
        )


def provider_turn_continuation_fingerprint(value: bytes) -> str:
    """Return the durable identity of one canonical route continuation."""

    return hashlib.sha256(b"nexus.provider-turn-continuation.v1\0" + value).hexdigest()
