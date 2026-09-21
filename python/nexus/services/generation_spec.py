"""The frozen-admission vocabulary: selection, intent, and one immutable spec.

Everything here is route-neutral and dependency-light: no credential, no
continuation, no raw prompt bytes, and no import heavier than the durable
tool-plan snapshot algebra.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Annotated, Any, Literal, Self, get_origin

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    ValidationInfo,
    model_validator,
)
from pydantic_core import PydanticUndefined

from nexus.config import GenerationApiProvider
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
BoundedText = Annotated[str, StringConstraints(min_length=1, max_length=512)]
ModelKey = Annotated[str, StringConstraints(min_length=1, max_length=256, pattern=r"^[^\s]+$")]
AgentReasoningKey = Annotated[
    str, StringConstraints(min_length=1, max_length=64, pattern=r"^[^\s]+$")
]
ProviderReasoningLevel = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type BackgroundOperationKey = Literal[
    "metadata_enrichment",
    "media_summary",
    "synapse",
    "oracle",
    "dossier_page",
    "dossier_note",
    "dossier_media",
    "dossier_conversation",
    "dossier_library",
    "dossier_podcast",
    "dossier_contributor",
    "dossier_idea",
]
type GenerationOperation = Literal["chat"] | BackgroundOperationKey

_MAX_INSTRUCTIONS_BYTES = 32 * 1024
_MAX_INPUT_BYTES = 1024 * 1024


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def generation_fact_digest(value: object) -> str:
    """Hash one canonical JSON generation fact without adding hidden context."""

    return _digest(value)


def utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, populate_by_name=True)


class WireTaggedModel(BaseModel):
    """Strict frozen wire base that requires every Literal tag on JSON input."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _require_wire_tags(cls, data: object, info: ValidationInfo) -> object:
        if info.mode == "json" and isinstance(data, dict):
            missing = [
                name
                for name, field in cls.model_fields.items()
                if field.default is not PydanticUndefined
                and get_origin(field.annotation) is Literal
                and name not in data
            ]
            if missing:
                raise ValueError(f"wire tags are required: {', '.join(missing)}")
        return data


class CodexPersonalSelection(_FrozenModel):
    route: Literal["CodexPersonal"]
    model: ModelKey
    reasoning: AgentReasoningKey


class ProviderApiSelection(_FrozenModel):
    route: Literal["ProviderApi"]
    model_ref: ModelKey
    reasoning: ProviderReasoningLevel


GenerationSelectionSpec = Annotated[
    CodexPersonalSelection | ProviderApiSelection, Field(discriminator="route")
]


def selection_fingerprint(selection: CodexPersonalSelection | ProviderApiSelection) -> str:
    """Return the domain-separated identity of one exact selection."""

    payload = _canonical_json(selection.model_dump(mode="json"))
    return hashlib.sha256(b"nexus.generation-selection.v1\0" + payload).hexdigest()


class TextOutput(WireTaggedModel):
    kind: Literal["Text"] = "Text"


class JsonSchemaOutput(WireTaggedModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    kind: Literal["JsonSchema"] = "JsonSchema"
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    schema_: dict[str, JsonValue] = Field(alias="schema", serialization_alias="schema")
    strict: Literal[True] = True

    @model_validator(mode="after")
    def _schema_is_object(self) -> Self:
        if self.schema_.get("type") != "object":
            raise ValueError("strict JsonSchema output must have an object root")
        return self


GenerationOutput = Annotated[TextOutput | JsonSchemaOutput, Field(discriminator="kind")]


class BearerToolGrant(WireTaggedModel):
    """Sensitive, run-scoped material; its value is never serialized."""

    kind: Literal["Bearer"] = "Bearer"
    token: SecretStr = Field(exclude=True, repr=False)

    @model_validator(mode="after")
    def _token_is_not_blank(self) -> Self:
        if not self.token.get_secret_value().strip():
            raise ValueError("bearer token must not be blank")
        return self


class GenerationIntent(WireTaggedModel):
    instructions: str
    input: str
    output: GenerationOutput

    @model_validator(mode="after")
    def _bounded_text(self) -> Self:
        if not self.instructions.strip():
            raise ValueError("instructions must not be blank")
        if not self.input.strip():
            raise ValueError("input must not be blank")
        if utf8_size(self.instructions) > _MAX_INSTRUCTIONS_BYTES:
            raise ValueError(f"instructions exceeds {_MAX_INSTRUCTIONS_BYTES} UTF-8 bytes")
        if utf8_size(self.input) > _MAX_INPUT_BYTES:
            raise ValueError(f"input exceeds {_MAX_INPUT_BYTES} UTF-8 bytes")
        return self


def validate_intent_bounds(
    intent: GenerationIntent, *, instructions_max_bytes: int, input_max_bytes: int
) -> None:
    if utf8_size(intent.instructions) > instructions_max_bytes:
        raise ValueError(f"instructions exceeds {instructions_max_bytes} UTF-8 bytes")
    if utf8_size(intent.input) > input_max_bytes:
        raise ValueError(f"input exceeds {input_max_bytes} UTF-8 bytes")


class SubscriptionBilling(_FrozenModel):
    kind: Literal["Subscription"] = "Subscription"
    label: Literal["Codex subscription"] = "Codex subscription"


class MeteredApiBilling(_FrozenModel):
    kind: Literal["MeteredApi"] = "MeteredApi"
    label: Literal["Metered API"] = "Metered API"


BillingDisclosure = Annotated[SubscriptionBilling | MeteredApiBilling, Field(discriminator="kind")]


class PrivacyDisclosure(_FrozenModel):
    summary: str = Field(min_length=1, max_length=1_000)
    retention: str = Field(min_length=1, max_length=1_000)
    training: str = Field(min_length=1, max_length=1_000)


class ProcessorChain(_FrozenModel):
    processors: tuple[str, ...] = Field(min_length=1, max_length=4)


class SelectionPresentation(_FrozenModel):
    route_label: str = Field(min_length=1, max_length=128)
    model_label: str = Field(min_length=1, max_length=256)
    reasoning_label: str = Field(min_length=1, max_length=128)
    billing: BillingDisclosure
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain


class CodexDispatchTargetSnapshot(_FrozenModel):
    kind: Literal["CodexPersonal"] = "CodexPersonal"
    model_key: BoundedText
    dispatch_model: BoundedText
    agent_definition_revision: BoundedText


class ProviderDispatchTargetSnapshot(_FrozenModel):
    kind: Literal["ProviderApi"] = "ProviderApi"
    model_ref: BoundedText
    provider: GenerationApiProvider
    model_id: BoundedText
    engine: BoundedText
    base_url: Presence[Annotated[str, StringConstraints(min_length=1, max_length=2_048)]]
    correlation: Literal["header", "in_band", "none"]
    routing: Presence[dict[str, JsonValue]]
    continuation_codec: BoundedText
    registry_revision: BoundedText


ResolvedDispatchTargetSnapshot = Annotated[
    CodexDispatchTargetSnapshot | ProviderDispatchTargetSnapshot, Field(discriminator="kind")
]


class GenerationStreamBounds(_FrozenModel):
    max_frames: int = Field(gt=0)
    max_frame_bytes: int = Field(gt=0)
    max_stream_bytes: int = Field(gt=0)
    text_flush_interval_ms: Presence[int]
    text_flush_bytes: Presence[int]


class GenerationBounds(_FrozenModel):
    instructions_max_bytes: int = Field(gt=0)
    input_max_bytes: int = Field(gt=0)
    turn_timeout_seconds: int = Field(gt=0)
    session_open_timeout_seconds: int = Field(gt=0)
    runtime_close_timeout_seconds: int = Field(gt=0)
    transport_margin_seconds: int = Field(gt=0)
    transport_deadline_seconds: int = Field(gt=0)
    stream: GenerationStreamBounds


class TextOutputSnapshot(_FrozenModel):
    kind: Literal["Text"] = "Text"


class StrictJsonOutputSnapshot(_FrozenModel):
    kind: Literal["StrictJson"] = "StrictJson"
    name: BoundedText
    json_schema: dict[str, JsonValue] = Field(alias="schema")


OutputContractSnapshot = Annotated[
    TextOutputSnapshot | StrictJsonOutputSnapshot, Field(discriminator="kind")
]


class ImmutablePromptPayloadRef(_FrozenModel):
    """Address of raw prompt bytes in the domain owner's protected ledger."""

    kind: Literal["DomainPromptPayload"] = "DomainPromptPayload"
    owner_kind: BoundedText
    owner_id: BoundedText
    revision: BoundedText
    payload_digest: Sha256


class FrozenHostToolPlanSnapshot(_FrozenModel):
    plan_id: BoundedText
    authority_revision: BoundedText
    facts: dict[str, JsonValue]


class FrozenScopePredicate(_FrozenModel):
    kind: BoundedText
    arguments: dict[str, JsonValue]


class FrozenToolScope(_FrozenModel):
    admitted_refs: tuple[BoundedText, ...]
    predicates: tuple[FrozenScopePredicate, ...]

    @model_validator(mode="after")
    def _canonical_refs(self) -> Self:
        if len(set(self.admitted_refs)) != len(self.admitted_refs):
            raise ValueError("frozen tool scope refs must be unique")
        if self.admitted_refs != tuple(sorted(self.admitted_refs)):
            raise ValueError("frozen tool scope refs must be canonical")
        return self


def tool_scope_digest(scope: FrozenToolScope) -> str:
    return _digest(scope.model_dump(mode="json"))


class GenerationSpecFacts(_FrozenModel):
    schema_version: Literal["nexus-generation-spec.v1"] = "nexus-generation-spec.v1"
    operation: GenerationOperation
    selection: GenerationSelectionSpec
    selection_source: Literal["ChatRun", "BackgroundPolicy"]
    resolved_dispatch_target: ResolvedDispatchTargetSnapshot
    source_catalog_definition_revision: BoundedText
    source_row_fingerprint: Sha256
    agent_definition_revision: Presence[BoundedText]
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    effective_context_budget_tokens: int = Field(gt=0)
    effective_output_budget_tokens: int = Field(gt=0)
    bounds: GenerationBounds
    prompt_template_revision: BoundedText
    prompt_payload_ref: ImmutablePromptPayloadRef
    instructions_digest: Sha256
    input_digest: Sha256
    output_contract: OutputContractSnapshot
    output_contract_fingerprint: Sha256
    display_at_dispatch: SelectionPresentation
    host_tool_plan_snapshot: Presence[FrozenHostToolPlanSnapshot]
    host_evidence_revision: Presence[BoundedText]
    model_tool_plan_snapshot: Presence[FrozenToolPlanSnapshot]
    tool_effect_mode: Presence[Literal["ReadOnly", "AdditiveWrites"]]
    admitted_tool_scope: Presence[FrozenToolScope]
    admitted_tool_scope_digest: Presence[Sha256]
    catalog_definition_revision: Sha256
    policy_revision: BoundedText
    backend_contract_revision: BoundedText
    provider_registry_revision: Presence[BoundedText]

    @model_validator(mode="after")
    def _closed_semantics(self) -> Self:
        if (self.operation == "chat") != (self.selection_source == "ChatRun"):
            raise ValueError("generation operation and selection source disagree")
        target = self.resolved_dispatch_target
        agent_revision = self.agent_definition_revision
        registry_revision = self.provider_registry_revision
        if isinstance(self.selection, CodexPersonalSelection):
            if not isinstance(target, CodexDispatchTargetSnapshot):
                raise ValueError("Codex selection lacks a Codex dispatch target")
            if self.selection.model != target.model_key:
                raise ValueError("Codex selection and dispatch model identities disagree")
            if not isinstance(agent_revision, Present) or (
                agent_revision.value != target.agent_definition_revision
            ):
                raise ValueError("Codex Agent definition revisions disagree")
            if not isinstance(registry_revision, Absent):
                raise ValueError("Codex generation carries provider registry state")
        else:
            if not isinstance(target, ProviderDispatchTargetSnapshot):
                raise ValueError("provider selection lacks a provider dispatch target")
            if self.selection.model_ref != target.model_ref:
                raise ValueError("provider selection and dispatch model identities disagree")
            if not isinstance(agent_revision, Absent):
                raise ValueError("provider generation carries Agent definition state")
            if not isinstance(registry_revision, Present) or (
                registry_revision.value != target.registry_revision
            ):
                raise ValueError("provider registry revisions disagree")
        if isinstance(self.source_context_window, Present) and (
            self.effective_context_budget_tokens > self.source_context_window.value
        ):
            raise ValueError("effective context budget exceeds source capacity")
        if isinstance(self.source_max_output_tokens, Present) and (
            self.effective_output_budget_tokens > self.source_max_output_tokens.value
        ):
            raise ValueError("effective output budget exceeds source capacity")
        plan = self.model_tool_plan_snapshot
        mode = self.tool_effect_mode
        scope = self.admitted_tool_scope
        scope_digest = self.admitted_tool_scope_digest
        present_count = sum(
            isinstance(value, Present) for value in (plan, mode, scope, scope_digest)
        )
        if present_count not in {0, 4}:
            raise ValueError("model-tool authority must be wholly Absent or Present")
        if (
            isinstance(plan, Present)
            and isinstance(mode, Present)
            and isinstance(scope, Present)
            and isinstance(scope_digest, Present)
        ):
            if scope_digest.value != tool_scope_digest(scope.value):
                raise ValueError("admitted tool scope digest differs from its facts")
            max_writes = plan.value.max_live_writes
            if (mode.value == "AdditiveWrites") != (max_writes is not None):
                raise ValueError("tool effect mode and live-write allowance disagree")
        if isinstance(self.host_tool_plan_snapshot, Present) != isinstance(
            self.host_evidence_revision, Present
        ):
            raise ValueError("host tool plan and evidence revision must share Presence")
        if self.output_contract_fingerprint != _digest(
            self.output_contract.model_dump(mode="json", by_alias=True)
        ):
            raise ValueError("output contract fingerprint differs from its facts")
        return self


class GenerationSpec(GenerationSpecFacts):
    fingerprint: Sha256

    @model_validator(mode="after")
    def _fingerprint_matches(self) -> Self:
        document = self.model_dump(mode="json", by_alias=True)
        fingerprint = document.pop("fingerprint")
        if fingerprint != _digest(document):
            raise ValueError("GenerationSpec fingerprint differs from canonical content")
        return self

    @classmethod
    def freeze(cls, facts: GenerationSpecFacts | dict[str, Any]) -> GenerationSpec:
        checked = facts if isinstance(facts, GenerationSpecFacts) else GenerationSpecFacts(**facts)
        fingerprint = _digest(checked.model_dump(mode="json", by_alias=True))
        return cls(**checked.model_dump(mode="python", by_alias=True), fingerprint=fingerprint)


def decode_generation_spec_document(value: object) -> GenerationSpec:
    """Decode one JSON-native spec document without weakening strict validation.

    A spec is nested inside outer wire envelopes that already parsed its JSON
    arrays into mutable lists; re-entering the JSON validator here restores
    tuple decoding under strict mode.
    """

    if isinstance(value, GenerationSpec):
        return value
    if not isinstance(value, dict):
        raise ValueError("GenerationSpec wire value must be a JSON object")
    try:
        encoded = _canonical_json(value)
    except (TypeError, ValueError) as error:
        raise ValueError("GenerationSpec wire value must be canonical JSON data") from error
    return GenerationSpec.model_validate_json(encoded)


GenerationSpecWire = Annotated[GenerationSpec, BeforeValidator(decode_generation_spec_document)]


class ToolPlanIdentity(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True, strict=True)

    plan_id: str
    plan_revision: str


class GenerationHistory(BaseModel):
    """A read projection of stable facts, never an admission or dispatch input."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    operation: str
    selection_source: Literal["ChatRun", "BackgroundPolicy"]
    selection: GenerationSelectionSpec
    resolved_dispatch_target: ResolvedDispatchTargetSnapshot
    catalog_definition_revision: str
    source_catalog_definition_revision: str
    display_at_dispatch: SelectionPresentation
    tool_effect_mode: Presence[Literal["ReadOnly", "AdditiveWrites"]]
    model_tool_plan_snapshot: Presence[ToolPlanIdentity]


def read_generation_history(value: GenerationSpec | Mapping[str, object]) -> GenerationHistory:
    """Project stable presentation facts from one validated frozen spec."""

    spec = decode_generation_spec_document(
        value if isinstance(value, GenerationSpec) else dict(value)
    )
    plan = spec.model_tool_plan_snapshot
    return GenerationHistory(
        operation=spec.operation,
        selection_source=spec.selection_source,
        selection=spec.selection,
        resolved_dispatch_target=spec.resolved_dispatch_target,
        catalog_definition_revision=spec.catalog_definition_revision,
        source_catalog_definition_revision=spec.source_catalog_definition_revision,
        display_at_dispatch=spec.display_at_dispatch,
        tool_effect_mode=spec.tool_effect_mode,
        model_tool_plan_snapshot=(
            Present(
                value=ToolPlanIdentity(
                    plan_id=plan.value.plan_id, plan_revision=plan.value.plan_revision
                )
            )
            if isinstance(plan, Present)
            else Absent()
        ),
    )
