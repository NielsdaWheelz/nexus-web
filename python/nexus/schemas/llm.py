"""Generation wire: exact selections, route disclosure, readiness, the catalog, chat failures."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.config import GenerationApiProvider
from nexus.schemas.presence import Presence


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("generation catalog instants must be timezone-aware")
    return value


ModelKey = Annotated[str, Field(min_length=1, max_length=256, pattern=r"^[^\s]+$")]
ReasoningKey = Annotated[str, Field(pattern=r"^[!-~]{1,64}$")]


class CodexPersonalSelection(_Frozen):
    route: Literal["CodexPersonal"]
    model: ModelKey
    reasoning: ReasoningKey


class ProviderApiSelection(_Frozen):
    route: Literal["ProviderApi"]
    model_ref: ModelKey
    reasoning: ReasoningKey


GenerationSelection = Annotated[
    CodexPersonalSelection | ProviderApiSelection, Field(discriminator="route")
]


class SubscriptionBilling(_Frozen):
    kind: Literal["Subscription"] = "Subscription"
    label: Literal["Codex subscription"] = "Codex subscription"


class MeteredApiBilling(_Frozen):
    kind: Literal["MeteredApi"] = "MeteredApi"
    label: Literal["Metered API"] = "Metered API"


class PrivacyDisclosure(_Frozen):
    summary: str = Field(min_length=1, max_length=1_000)
    retention: str = Field(min_length=1, max_length=1_000)
    training: str = Field(min_length=1, max_length=1_000)


class ProcessorChain(_Frozen):
    processors: tuple[str, ...] = Field(min_length=1, max_length=4)


class SelectionPresentation(_Frozen):
    route_label: str = Field(min_length=1, max_length=128)
    model_label: str = Field(min_length=1, max_length=256)
    reasoning_label: str = Field(min_length=1, max_length=128)
    billing: Annotated[SubscriptionBilling | MeteredApiBilling, Field(discriminator="kind")]
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain


ReadinessCode = Literal[
    "codex_host_unavailable",
    "required_tool_unavailable",
]


class Ready(_Frozen):
    kind: Literal["Ready"] = "Ready"
    last_checked: datetime

    _aware = field_validator("last_checked")(_aware)


class OperatorActionRequired(_Frozen):
    kind: Literal["OperatorActionRequired"] = "OperatorActionRequired"
    code: ReadinessCode
    explanation: str = Field(min_length=1, max_length=1_000)
    action: str = Field(min_length=1, max_length=500)
    last_checked: datetime

    _aware = field_validator("last_checked")(_aware)


class TemporarilyUnavailable(_Frozen):
    kind: Literal["TemporarilyUnavailable"] = "TemporarilyUnavailable"
    code: ReadinessCode
    explanation: str = Field(min_length=1, max_length=1_000)
    action: str = Field(min_length=1, max_length=500)
    last_checked: datetime

    _aware = field_validator("last_checked")(_aware)


Readiness = Annotated[
    Ready | OperatorActionRequired | TemporarilyUnavailable, Field(discriminator="kind")
]


class Selectable(_Frozen):
    kind: Literal["Selectable"] = "Selectable"


class Ineligible(_Frozen):
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


class CodexPersonalRoute(_Frozen):
    kind: Literal["CodexPersonal"] = "CodexPersonal"


class ProviderApiRoute(_Frozen):
    kind: Literal["ProviderApi"] = "ProviderApi"
    provider: GenerationApiProvider


class GenerationReasoningRow(_Frozen):
    key: ReasoningKey
    label: str = Field(min_length=1, max_length=256)
    readiness: Readiness
    chat_state: SelectionState


class GenerationModelRow(_Frozen):
    key: ModelKey
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
    def _default_names_one_row(self) -> Self:
        keys = [row.key for row in self.reasoning]
        if len(set(keys)) != len(keys):
            raise ValueError("generation reasoning rows must be unique")
        default = self.source_default_reasoning
        if default.kind == "Present" and default.value not in keys:
            raise ValueError("source default must name a reasoning row")
        return self


class GenerationCatalogRoute(_Frozen):
    route: Annotated[CodexPersonalRoute | ProviderApiRoute, Field(discriminator="kind")]
    label: str = Field(min_length=1, max_length=128)
    readiness: Readiness
    billing: Annotated[SubscriptionBilling | MeteredApiBilling, Field(discriminator="kind")]
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain
    models: tuple[GenerationModelRow, ...] = Field(min_length=1)


class ChatSeed(_Frozen):
    selection: GenerationSelection
    state: SelectionState
    presentation: SelectionPresentation


class GenerationCatalog(_Frozen):
    observed_at: datetime
    chat_seed: ChatSeed
    routes: tuple[GenerationCatalogRoute, ...] = Field(min_length=1)

    _aware = field_validator("observed_at")(_aware)


class RunSelectionOut(_Frozen):
    selection: GenerationSelection
    display_at_dispatch: SelectionPresentation
    tool_authority: Literal["ReadOnly", "AdditiveWrites"]


class InvalidGenerationSelection(_Frozen):
    code: Literal["InvalidGenerationSelection"] = "InvalidGenerationSelection"
    field: Presence[str]
    explanation: str = Field(min_length=1, max_length=1_000)


class GenerationSelectionUnavailable(_Frozen):
    code: Literal["GenerationSelectionUnavailable"] = "GenerationSelectionUnavailable"
    selection: GenerationSelection
    state: NonSelectableState


class _ChatFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CancelledChatFailure(_ChatFailure):
    code: Literal["cancelled"] = "cancelled"
    can_rerun: bool


class ContextTooLargeChatFailure(_ChatFailure):
    code: Literal["context_too_large"] = "context_too_large"
    can_rerun: Literal[False] = False


class InvalidOutputChatFailure(_ChatFailure):
    code: Literal["invalid_output"] = "invalid_output"
    can_rerun: Literal[False] = False


class IncompleteChatFailure(_ChatFailure):
    code: Literal["incomplete"] = "incomplete"
    can_rerun: bool


class AssistantUnavailableChatFailure(_ChatFailure):
    code: Literal["assistant_unavailable"] = "assistant_unavailable"
    can_rerun: bool


class OperatorDefectChatFailure(_ChatFailure):
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
