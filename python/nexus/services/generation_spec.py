"""One immutable route-neutral generation admission snapshot.

The semantic spec sits above both transport adapters.  It contains every fact
that may affect dispatch, but no credential, bearer, continuation, or raw
prompt bytes.  Durable persistence validates the same canonical document at
the database boundary without importing this module.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from nexus.config import GenerationApiProvider
from nexus.schemas.llm import SelectionPresentation
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_selection import (
    CodexPersonalSelection,
    GenerationSelectionSpec,
    ProviderApiSelection,
)
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
BoundedText = Annotated[str, StringConstraints(min_length=1, max_length=512)]
type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type BackgroundOperationKey = Literal[
    "metadata_enrichment",
    "media_summary",
    "synapse",
    "dawn_write",
    "oracle",
    "dossier_page",
    "dossier_note",
    "dossier_media",
    "dossier_conversation",
    "dossier_library",
    "dossier_podcast",
    "dossier_contributor",
    "dossier_idea",
    "dossier_idea_resolve",
]
type GenerationOperation = Literal["chat"] | BackgroundOperationKey


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, populate_by_name=True)


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
    CodexDispatchTargetSnapshot | ProviderDispatchTargetSnapshot,
    Field(discriminator="kind"),
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
    TextOutputSnapshot | StrictJsonOutputSnapshot,
    Field(discriminator="kind"),
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
    return generation_fact_digest(scope.model_dump(mode="json"))


def generation_fact_digest(value: object) -> str:
    """Hash one canonical JSON generation fact without adding hidden context."""

    return _digest(value)


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
        if self.selection.route != self.resolved_dispatch_target.kind:
            raise ValueError("selection and dispatch target routes disagree")
        if self.selection.route == "CodexPersonal":
            if not isinstance(self.selection, CodexPersonalSelection):
                raise ValueError("Codex route lacks a Codex selection")
            if not isinstance(self.resolved_dispatch_target, CodexDispatchTargetSnapshot):
                raise ValueError("Codex selection lacks a Codex dispatch target")
            if self.selection.model != self.resolved_dispatch_target.model_key:
                raise ValueError("Codex selection and dispatch model identities disagree")
            if not isinstance(self.agent_definition_revision, Present):
                raise ValueError("Codex generation lacks its Agent definition revision")
            if not isinstance(self.provider_registry_revision, Absent):
                raise ValueError("Codex generation carries provider registry state")
            if (
                self.agent_definition_revision.value
                != self.resolved_dispatch_target.agent_definition_revision
            ):
                raise ValueError("Codex Agent definition revisions disagree")
        else:
            if not isinstance(self.selection, ProviderApiSelection):
                raise ValueError("provider route lacks a provider selection")
            if not isinstance(self.resolved_dispatch_target, ProviderDispatchTargetSnapshot):
                raise ValueError("provider selection lacks a provider dispatch target")
            if self.selection.model_ref != self.resolved_dispatch_target.model_ref:
                raise ValueError("provider selection and dispatch model identities disagree")
            if not isinstance(self.agent_definition_revision, Absent):
                raise ValueError("provider generation carries Agent definition state")
            if not isinstance(self.provider_registry_revision, Present):
                raise ValueError("provider generation lacks registry state")
            if (
                self.provider_registry_revision.value
                != self.resolved_dispatch_target.registry_revision
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
        model_tool_fields = (
            self.model_tool_plan_snapshot,
            self.tool_effect_mode,
            self.admitted_tool_scope,
            self.admitted_tool_scope_digest,
        )
        present_count = sum(isinstance(value, Present) for value in model_tool_fields)
        if present_count not in {0, len(model_tool_fields)}:
            raise ValueError("model-tool authority must be wholly Absent or Present")
        if present_count:
            assert isinstance(self.model_tool_plan_snapshot, Present)
            assert isinstance(self.tool_effect_mode, Present)
            assert isinstance(self.admitted_tool_scope, Present)
            assert isinstance(self.admitted_tool_scope_digest, Present)
            if self.admitted_tool_scope_digest.value != tool_scope_digest(
                self.admitted_tool_scope.value
            ):
                raise ValueError("admitted tool scope digest differs from its facts")
            max_writes = self.model_tool_plan_snapshot.value.max_live_writes
            if self.tool_effect_mode.value == "ReadOnly" and max_writes is not None:
                raise ValueError("read-only authority carries a live-write allowance")
            if self.tool_effect_mode.value == "AdditiveWrites" and max_writes is None:
                raise ValueError("additive-write authority lacks a live-write allowance")
        if isinstance(self.host_tool_plan_snapshot, Present) != isinstance(
            self.host_evidence_revision, Present
        ):
            raise ValueError("host tool plan and evidence revision must share Presence")
        expected_output = _digest(self.output_contract.model_dump(mode="json", by_alias=True))
        if self.output_contract_fingerprint != expected_output:
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
        document = checked.model_dump(mode="json", by_alias=True)
        python_values = checked.model_dump(mode="python", by_alias=True)
        return cls(**python_values, fingerprint=_digest(document))


def decode_generation_spec_document(value: object) -> GenerationSpec:
    """Decode one JSON-native spec document without weakening strict validation.

    A ``GenerationSpec`` is nested inside multiple outer wire envelopes. Pydantic
    parses those envelopes first, so strict immutable JSON arrays otherwise arrive
    at the nested model as mutable Python lists. Re-entering the JSON validator at
    this single semantic boundary preserves JSON array-to-tuple decoding while
    retaining strict scalar, discriminator, extra-field, and fingerprint checks.
    """

    if isinstance(value, GenerationSpec):
        return value
    if not isinstance(value, dict):
        raise ValueError("GenerationSpec wire value must be a JSON object")
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as error:
        raise ValueError("GenerationSpec wire value must be canonical JSON data") from error
    return GenerationSpec.model_validate_json(encoded)


GenerationSpecWire = Annotated[GenerationSpec, BeforeValidator(decode_generation_spec_document)]


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


__all__ = [
    "BackgroundOperationKey",
    "CodexDispatchTargetSnapshot",
    "FrozenHostToolPlanSnapshot",
    "FrozenScopePredicate",
    "FrozenToolScope",
    "GenerationBounds",
    "GenerationOperation",
    "GenerationSpec",
    "GenerationSpecFacts",
    "GenerationSpecWire",
    "GenerationStreamBounds",
    "ImmutablePromptPayloadRef",
    "OutputContractSnapshot",
    "ProviderDispatchTargetSnapshot",
    "ResolvedDispatchTargetSnapshot",
    "StrictJsonOutputSnapshot",
    "TextOutputSnapshot",
    "generation_fact_digest",
    "decode_generation_spec_document",
    "tool_scope_digest",
]
