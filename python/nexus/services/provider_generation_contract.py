"""Route-local values for durable ProviderRuntime model turns.

The contract deliberately stops at the transport boundary.  It contains no
domain owner, tool executor, credential, policy lookup, or ledger mutation.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from provider_runtime.continuation import decode_continuation, encode_continuation
from provider_runtime.errors import InvalidRequest, RuntimeDefect
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
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
from provider_runtime.types import (
    Present as RuntimePresent,
)

from nexus.schemas.presence import Presence
from nexus.services.generation_spec import GenerationSpec
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import PublishedTools, ToolCallResolution

MAX_PROVIDER_TURN_CONTINUATION_BYTES = 16 * 1024 * 1024
_CONTINUATION_SCHEMA = "nexus-provider-turn-continuation.v1"
_CONTINUATION_FIELDS = frozenset(
    {
        "schema_version",
        "generation_spec_fingerprint",
        "source_turn_seq",
        "target",
        "codec_id",
        "assistant_text",
        "tool_calls",
        "native_continuation",
    }
)
_TARGET_FIELDS = frozenset({"provider", "model"})
_TOOL_CALL_FIELDS = frozenset({"id", "name", "arguments"})
_PRESENCE_ABSENT_FIELDS = frozenset({"kind"})
_PRESENCE_PRESENT_FIELDS = frozenset({"kind", "value"})


class ProviderGenerationDefect(RuntimeDefect):
    """A broken frozen request, persisted continuation, or provider stream."""

    def __init__(self, *, origin: Literal["intent", "plan", "provider_stream"], message: str):
        # justify-defect: GenerationService already admitted these same-system
        # facts, continuation plaintext is authenticated ledger state, and the
        # ProviderRuntime stream is a closed library contract.  Drift or an
        # invalid envelope is therefore an implementation/integration defect.
        super().__init__(
            origin=origin,
            code="provider_generation_contract_breached",
            message=message,
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
        if (
            not isinstance(self.provider_call_id, str)
            or not self.provider_call_id
            or len(self.provider_call_id.encode("utf-8")) > 1_024
        ):
            raise ValueError("provider tool-result call id must be bounded nonblank text")
        if type(self.is_error) is not bool:
            raise TypeError("provider tool-result is_error must be bool")


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
        if not self.canonical_bytes or len(self.canonical_bytes) > (
            MAX_PROVIDER_TURN_CONTINUATION_BYTES
        ):
            raise ValueError("provider continuation is outside its canonical byte bound")
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
    native: dict[str, object]
    if isinstance(native_continuation, RuntimePresent):
        artifact = native_continuation.value
        if artifact.target != target or artifact.codec_id != codec_id:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider native continuation differs from the frozen target or codec",
            )
        try:
            native_document = json.loads(encode_continuation(artifact))
        except (InvalidRequest, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider native continuation is not canonically encodable",
            ) from error
        native = {"kind": "Present", "value": native_document}
    elif isinstance(native_continuation, RuntimeAbsent):
        native = {"kind": "Absent"}
    else:
        raise TypeError("native continuation must use ProviderRuntime Presence")
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
                            call.arguments,
                            context="provider continuation tool arguments",
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

    if (
        not isinstance(encoded, bytes)
        or not encoded
        or len(encoded) > (MAX_PROVIDER_TURN_CONTINUATION_BYTES)
    ):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation is outside its durable byte bound",
        )
    try:
        document = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation is not valid JSON",
        ) from error
    if not isinstance(document, dict) or set(document) != _CONTINUATION_FIELDS:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation has an invalid field set",
        )
    if document["schema_version"] != _CONTINUATION_SCHEMA:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation schema is unsupported",
        )
    if document["generation_spec_fingerprint"] != spec.fingerprint:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation belongs to another GenerationSpec",
        )
    if document["source_turn_seq"] != expected_source_turn_seq:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation source sequence is not the expected predecessor",
        )
    encoded_target = document["target"]
    if not isinstance(encoded_target, dict) or set(encoded_target) != _TARGET_FIELDS:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation target is malformed",
        )
    if encoded_target != {"provider": target.provider, "model": target.model}:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation target differs from the frozen target",
        )
    if document["codec_id"] != codec_id:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation codec differs from the frozen target",
        )
    assistant_text = document["assistant_text"]
    if not isinstance(assistant_text, str):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation assistant text is malformed",
        )
    tool_calls = _decode_tool_calls(document["tool_calls"])
    native = _decode_native_continuation(
        document["native_continuation"],
        target=target,
        codec_id=codec_id,
    )
    try:
        canonical = canonical_json_bytes(
            freeze_json_object(document, context="provider turn continuation")
        )
    except (TypeError, ValueError) as error:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation is outside the canonical JSON domain",
        ) from error
    if canonical != encoded:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation is not canonically encoded",
        )
    return DecodedProviderTurnContinuation(
        source_turn_seq=expected_source_turn_seq,
        assistant_text=assistant_text,
        tool_calls=tool_calls,
        native_continuation=native,
    )


def _decode_tool_calls(value: object) -> tuple[ToolCall, ...]:
    if not isinstance(value, list) or not value:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider turn continuation requires nonempty tool calls",
        )
    calls: list[ToolCall] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != _TOOL_CALL_FIELDS:
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider turn continuation tool call is malformed",
            )
        if not isinstance(item["id"], str) or not isinstance(item["name"], str):
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider turn continuation tool identity is malformed",
            )
        if not isinstance(item["arguments"], dict):
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider turn continuation tool arguments are malformed",
            )
        calls.append(
            ToolCall(
                id=item["id"],
                name=item["name"],
                arguments=item["arguments"],
            )
        )
    result = tuple(calls)
    _validate_tool_calls(result)
    return result


def _decode_native_continuation(
    value: object,
    *,
    target: ProviderTarget,
    codec_id: str,
) -> RuntimePresent[ContinuationArtifact] | RuntimeAbsent:
    if not isinstance(value, dict):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider native continuation Presence is malformed",
        )
    if set(value) == _PRESENCE_ABSENT_FIELDS and value.get("kind") == "Absent":
        return RuntimeAbsent()
    if set(value) != _PRESENCE_PRESENT_FIELDS or value.get("kind") != "Present":
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider native continuation Presence is malformed",
        )
    native_document = value["value"]
    if not isinstance(native_document, dict):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider native continuation document is malformed",
        )
    try:
        native_bytes = canonical_json_bytes(
            freeze_json_object(native_document, context="provider native continuation")
        )
        artifact = decode_continuation(native_bytes, target, codec_id)
    except (InvalidRequest, TypeError, ValueError) as error:
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider native continuation is invalid for the frozen target",
        ) from error
    return RuntimePresent(artifact)


def _validate_tool_calls(calls: tuple[ToolCall, ...]) -> None:
    if not calls:
        raise ValueError("provider continuation requires at least one tool call")
    ids: list[str] = []
    for call in calls:
        if not call.id or len(call.id.encode("utf-8")) > 1_024:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider tool-call id is outside its bound",
            )
        if not call.name or len(call.name.encode("utf-8")) > 256:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider tool-call name is outside its bound",
            )
        try:
            freeze_json_object(call.arguments, context="provider tool-call arguments")
        except (TypeError, ValueError) as error:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider tool-call arguments are outside canonical JSON",
            ) from error
        ids.append(call.id)
    if len(set(ids)) != len(ids):
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider emitted duplicate tool-call ids in one turn",
        )


def provider_turn_continuation_fingerprint(value: bytes) -> str:
    """Return the durable identity of one canonical route continuation."""

    if not isinstance(value, bytes):
        raise TypeError("provider continuation fingerprint input must be bytes")
    return hashlib.sha256(b"nexus.provider-turn-continuation.v1\0" + value).hexdigest()


__all__ = [
    "DecodedProviderTurnContinuation",
    "MAX_PROVIDER_TURN_CONTINUATION_BYTES",
    "ProviderGenerationDefect",
    "ProviderGenerationEvent",
    "ProviderModelTools",
    "ProviderTerminal",
    "ProviderTextDelta",
    "ProviderToolProposed",
    "ProviderToolResult",
    "ProviderTurnContinuation",
    "ProviderUsageObserved",
    "decode_provider_turn_continuation",
    "encode_provider_turn_continuation",
    "provider_turn_continuation_fingerprint",
]
