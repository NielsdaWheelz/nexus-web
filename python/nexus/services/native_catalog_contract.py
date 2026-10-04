"""Secret-free source catalog and the owned native callback execution contract."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self

from provider_runtime import Absent as RuntimeAbsent
from provider_runtime import Present as RuntimePresent
from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION, AgentModelCatalog
from pydantic import Field, StringConstraints, field_validator, model_validator

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_spec import WireTaggedModel

EXECUTION_POLICY_REVISION = "codex-native-callbacks-contained.v1"
MODEL_CATALOG_SCHEMA_VERSION = "nexus-native-model-catalog.v1"
CatalogKey = Annotated[str, StringConstraints(min_length=1, max_length=256)]
CatalogRevision = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class CodexCatalogReasoning(WireTaggedModel):
    key: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    native_wire_value: CatalogKey


class NativeExecutionFacts(WireTaggedModel):
    """Application transport capability; never represented as a native model fact."""

    mode: Literal["callbacks"] = "callbacks"
    final_outputs: tuple[Literal["text", "json_schema"], ...] = ("text", "json_schema")


class CodexCatalogModel(WireTaggedModel):
    key: CatalogKey
    dispatch_model: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    input_modalities: tuple[Literal["text", "image"], ...] = Field(min_length=1)
    reasoning: tuple[CodexCatalogReasoning, ...] = Field(min_length=1, max_length=16)
    source_default_reasoning: Presence[CatalogKey]
    row_fingerprint: Sha256Hex

    @model_validator(mode="after")
    def _validate_source_facts(self) -> Self:
        if len(set(self.input_modalities)) != len(self.input_modalities):
            raise ValueError("Codex catalog input modalities must be unique")
        reasoning_keys = tuple(item.key for item in self.reasoning)
        if len(set(reasoning_keys)) != len(reasoning_keys):
            raise ValueError("Codex catalog reasoning keys must be unique")
        for capacity in (self.source_context_window, self.source_max_output_tokens):
            if isinstance(capacity, Present) and capacity.value <= 0:
                raise ValueError("Codex catalog source capacities must be positive")
        if (
            isinstance(self.source_default_reasoning, Present)
            and self.source_default_reasoning.value not in reasoning_keys
        ):
            raise ValueError("Codex catalog default reasoning is not a reasoning row")
        return self


class CodexModelCatalog(WireTaggedModel):
    schema_version: Literal["nexus-native-model-catalog.v1"] = MODEL_CATALOG_SCHEMA_VERSION
    backend_contract_revision: CatalogRevision
    definition_revision: Sha256Hex
    native_revision: Presence[CatalogRevision]
    observed_at: datetime
    models: tuple[CodexCatalogModel, ...] = Field(max_length=512)
    execution: NativeExecutionFacts
    execution_policy_revision: CatalogRevision

    @field_validator("observed_at")
    @classmethod
    def _observed_at_is_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Codex catalog observed_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def _unique_models(self) -> Self:
        keys = tuple(model.key for model in self.models)
        if len(set(keys)) != len(keys):
            raise ValueError("Codex catalog model keys must be unique")
        return self


def codex_model_catalog_to_wire(catalog: AgentModelCatalog) -> CodexModelCatalog:
    if catalog.backend_contract_revision != AGENT_BACKEND_CONTRACT_REVISION:
        raise ValueError("Codex provider catalog contract revision differs")
    return CodexModelCatalog(
        backend_contract_revision=catalog.backend_contract_revision,
        definition_revision=catalog.definition_revision,
        native_revision=_to_wire(catalog.native_revision),
        observed_at=catalog.observed_at,
        models=tuple(
            CodexCatalogModel(
                key=model.key,
                dispatch_model=model.dispatch_model,
                label=model.label,
                source_context_window=_to_wire(model.source_context_window),
                source_max_output_tokens=_to_wire(model.source_max_output_tokens),
                input_modalities=model.input_modalities,
                reasoning=tuple(
                    CodexCatalogReasoning(
                        key=reasoning.key,
                        label=reasoning.label,
                        native_wire_value=reasoning.native_wire_value,
                    )
                    for reasoning in model.reasoning
                ),
                source_default_reasoning=_to_wire(model.source_default_reasoning),
                row_fingerprint=model.row_fingerprint,
            )
            for model in catalog.models
        ),
        execution=NativeExecutionFacts(),
        execution_policy_revision=EXECUTION_POLICY_REVISION,
    )


def _to_wire[T](value: RuntimeAbsent | RuntimePresent[T]) -> Absent | Present[T]:
    if isinstance(value, RuntimeAbsent):
        return Absent()
    return Present[T](value=value.value)
