"""Strict product-facing generation catalog, selection, and failure schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.config import GenerationApiProvider
from nexus.schemas.presence import Presence
from nexus.services.generation_spec import (
    BillingDisclosure,
    GenerationSelectionSpec,
    MeteredApiBilling,
    PrivacyDisclosure,
    ProcessorChain,
    SelectionPresentation,
    SubscriptionBilling,
)


class _StrictGenerationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("generation catalog instants must be timezone-aware")
    return value


ReadinessCode = Literal[
    "catalog_refresh_failed",
    "codex_host_unavailable",
    "credential_unavailable",
    "required_tool_unavailable",
]


class Ready(_StrictGenerationModel):
    kind: Literal["Ready"] = "Ready"
    last_checked: datetime

    _last_checked_is_aware = field_validator("last_checked")(_aware)


class OperatorActionRequired(_StrictGenerationModel):
    kind: Literal["OperatorActionRequired"] = "OperatorActionRequired"
    code: ReadinessCode
    explanation: str = Field(min_length=1, max_length=1_000)
    action: str = Field(min_length=1, max_length=500)
    last_checked: datetime

    _last_checked_is_aware = field_validator("last_checked")(_aware)


class TemporarilyUnavailable(_StrictGenerationModel):
    kind: Literal["TemporarilyUnavailable"] = "TemporarilyUnavailable"
    code: ReadinessCode
    explanation: str = Field(min_length=1, max_length=1_000)
    action: str = Field(min_length=1, max_length=500)
    last_checked: datetime

    _last_checked_is_aware = field_validator("last_checked")(_aware)


class CapacityPaused(_StrictGenerationModel):
    """A parked Codex capacity refusal, rendered by the dossier surface."""

    kind: Literal["CapacityPaused"] = "CapacityPaused"
    code: Literal["quota_unavailable"] = "quota_unavailable"
    explanation: str = Field(min_length=1, max_length=1_000)
    reset_at: Presence[datetime]
    next_check_at: datetime
    last_checked: datetime

    @field_validator("next_check_at", "last_checked")
    @classmethod
    def _instant_is_aware(cls, value: datetime) -> datetime:
        return _aware(value)


Readiness = Annotated[
    Ready | OperatorActionRequired | TemporarilyUnavailable, Field(discriminator="kind")
]


class Selectable(_StrictGenerationModel):
    kind: Literal["Selectable"] = "Selectable"


class Ineligible(_StrictGenerationModel):
    kind: Literal["Ineligible"] = "Ineligible"
    code: Literal["unsupported_capability", "selection_not_configured"]
    explanation: str = Field(min_length=1, max_length=1_000)


NonSelectableState = Annotated[
    Ineligible | OperatorActionRequired | TemporarilyUnavailable, Field(discriminator="kind")
]
SelectionState = Annotated[
    Selectable | Ineligible | OperatorActionRequired | TemporarilyUnavailable,
    Field(discriminator="kind"),
]


class CodexPersonalRoute(_StrictGenerationModel):
    kind: Literal["CodexPersonal"] = "CodexPersonal"


class ProviderApiRoute(_StrictGenerationModel):
    kind: Literal["ProviderApi"] = "ProviderApi"
    provider: GenerationApiProvider


GenerationRoute = Annotated[CodexPersonalRoute | ProviderApiRoute, Field(discriminator="kind")]


class GenerationReasoningRow(_StrictGenerationModel):
    key: str = Field(pattern=r"^[!-~]{1,64}$")
    label: str = Field(min_length=1, max_length=256)
    readiness: Readiness
    chat_state: SelectionState


class GenerationModelRow(_StrictGenerationModel):
    key: str = Field(min_length=1, max_length=256, pattern=r"^[^\s]+$")
    label: str = Field(min_length=1, max_length=256)
    description: str = Field(min_length=1, max_length=1_000)
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    effective_chat_context_budget_tokens: int = Field(gt=0)
    effective_chat_output_budget_tokens: int = Field(gt=0)
    readiness: Readiness
    input_modalities: tuple[Literal["text", "image"], ...] = Field(min_length=1)
    source_default_reasoning: Presence[str]
    reasoning: tuple[GenerationReasoningRow, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _default_and_reasoning_are_closed(self) -> Self:
        for capacity in (self.source_context_window, self.source_max_output_tokens):
            if capacity.kind == "Present" and capacity.value <= 0:
                raise ValueError("source model capacities must be positive when reported")
        keys = tuple(row.key for row in self.reasoning)
        if len(set(keys)) != len(keys):
            raise ValueError("generation reasoning rows must be unique")
        if self.source_default_reasoning.kind == "Present":
            if keys.count(self.source_default_reasoning.value) != 1:
                raise ValueError("source default must name exactly one reasoning row")
        return self


class GenerationCatalogRoute(_StrictGenerationModel):
    route: GenerationRoute
    label: str = Field(min_length=1, max_length=128)
    readiness: Readiness
    billing: BillingDisclosure
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain
    models: tuple[GenerationModelRow, ...] = Field(min_length=1)


class ChatSeed(_StrictGenerationModel):
    policy_revision: str = Field(min_length=1, max_length=128)
    selection: GenerationSelectionSpec
    state: SelectionState
    presentation: SelectionPresentation


class RunSelectionOut(_StrictGenerationModel):
    selection: GenerationSelectionSpec
    catalog_definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_catalog_definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    display_at_dispatch: SelectionPresentation
    tool_authority: Literal["ReadOnly", "AdditiveWrites"]
    current_state: SelectionState
    current_state_observed_at: datetime
    rerun_eligibility: bool

    _state_observed_at_is_aware = field_validator("current_state_observed_at")(_aware)


class GenerationCatalog(_StrictGenerationModel):
    definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    observed_at: datetime
    chat_seed: ChatSeed
    routes: tuple[GenerationCatalogRoute, ...] = Field(min_length=1)

    _observed_at_is_aware = field_validator("observed_at")(_aware)

    @model_validator(mode="after")
    def _catalog_order_is_duplicate_free(self) -> Self:
        route_keys: list[tuple[str, str]] = []
        for route in self.routes:
            route_keys.append(
                (
                    route.route.kind,
                    route.route.provider if isinstance(route.route, ProviderApiRoute) else "",
                )
            )
            model_keys = tuple(model.key for model in route.models)
            if len(set(model_keys)) != len(model_keys):
                raise ValueError("generation catalog models must be unique within a route")
        if len(set(route_keys)) != len(route_keys):
            raise ValueError("generation catalog routes must be unique")
        return self


class InvalidGenerationSelection(_StrictGenerationModel):
    code: Literal["InvalidGenerationSelection"] = "InvalidGenerationSelection"
    field: Presence[str]
    explanation: str = Field(min_length=1, max_length=1_000)


class GenerationSelectionUnavailable(_StrictGenerationModel):
    code: Literal["GenerationSelectionUnavailable"] = "GenerationSelectionUnavailable"
    selection: GenerationSelectionSpec
    state: NonSelectableState


class CatalogDefinitionStale(_StrictGenerationModel):
    code: Literal["CatalogDefinitionStale"] = "CatalogDefinitionStale"
    current_definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


GenerationSelectionFailure = Annotated[
    InvalidGenerationSelection | GenerationSelectionUnavailable | CatalogDefinitionStale,
    Field(discriminator="code"),
]


class ExpectedChatFailureBase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CancelledChatFailure(ExpectedChatFailureBase):
    code: Literal["cancelled"] = "cancelled"
    can_rerun: bool


class ContextTooLargeChatFailure(ExpectedChatFailureBase):
    code: Literal["context_too_large"] = "context_too_large"
    can_rerun: Literal[False] = False


class InvalidOutputChatFailure(ExpectedChatFailureBase):
    code: Literal["invalid_output"] = "invalid_output"
    can_rerun: Literal[False] = False


class IncompleteChatFailure(ExpectedChatFailureBase):
    code: Literal["incomplete"] = "incomplete"
    can_rerun: bool


class AssistantUnavailableChatFailure(ExpectedChatFailureBase):
    code: Literal["assistant_unavailable"] = "assistant_unavailable"
    can_rerun: bool


class OperatorDefectChatFailure(ExpectedChatFailureBase):
    code: Literal["operator_defect"] = "operator_defect"
    can_rerun: Literal[False] = False


ExpectedChatFailure = Annotated[
    CancelledChatFailure
    | ContextTooLargeChatFailure
    | InvalidOutputChatFailure
    | IncompleteChatFailure
    | AssistantUnavailableChatFailure
    | OperatorDefectChatFailure,
    Field(discriminator="code"),
]


__all__ = [
    "AssistantUnavailableChatFailure",
    "BillingDisclosure",
    "CancelledChatFailure",
    "CapacityPaused",
    "CatalogDefinitionStale",
    "ChatSeed",
    "CodexPersonalRoute",
    "ContextTooLargeChatFailure",
    "ExpectedChatFailure",
    "ExpectedChatFailureBase",
    "GenerationCatalog",
    "GenerationCatalogRoute",
    "GenerationModelRow",
    "GenerationReasoningRow",
    "GenerationRoute",
    "GenerationSelectionFailure",
    "GenerationSelectionUnavailable",
    "IncompleteChatFailure",
    "Ineligible",
    "InvalidGenerationSelection",
    "InvalidOutputChatFailure",
    "MeteredApiBilling",
    "NonSelectableState",
    "OperatorActionRequired",
    "OperatorDefectChatFailure",
    "PrivacyDisclosure",
    "ProcessorChain",
    "ProviderApiRoute",
    "Readiness",
    "ReadinessCode",
    "Ready",
    "RunSelectionOut",
    "Selectable",
    "SelectionPresentation",
    "SelectionState",
    "SubscriptionBilling",
    "TemporarilyUnavailable",
]
