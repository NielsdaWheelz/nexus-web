"""LLM product-facing API schemas.

Two independent contracts live here (`docs/cutovers/llm-provider-runtime-hard-
cutover.md` §10):

- `LlmProfilesOut`: the `GET /llm-profiles` response, built from
  `nexus.services.llm_profiles.PROFILES`. The browser owns no provider/model/
  reasoning enum, ordering, default, capability, key, or availability policy;
  this schema is the entire product-facing profile contract.
- `ExpectedChatFailure`: the closed, discriminated chat-failure union exposed
  by `ChatRunOut`, message hydration, terminal SSE, reconnect folding, and the
  trust trail — all derived by `chat_failure_projection`
  (`services/chat_failure.py`), never synthesized ad hoc. One variant per
  card-bearing §10 code; each variant fixes its `origin` to the narrowed
  `ChatRun.error_origin` Literal(s) that code can actually carry (§9's closed
  origin union), except `cancelled`, which carries no origin — a cancelled run
  has NULL error columns; run status alone drives that variant. Transient
  variants (mapped from the runtime's `TransientExhausted`) additionally carry
  `attempts`.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence
from nexus.services.llm_profiles import DEFAULT_PROFILE_ID, PROFILES, LlmProfile

# =============================================================================
# GET /llm-profiles
# =============================================================================


class ReasoningOptionOut(BaseModel):
    id: str
    label: str

    model_config = ConfigDict(frozen=True)


class LlmProfileOut(BaseModel):
    id: str
    label: str
    description: str
    provider_label: str
    model_label: str
    reasoning_options: list[ReasoningOptionOut]
    default_reasoning_option_id: str
    privacy_notice: str

    model_config = ConfigDict(frozen=True)

    @classmethod
    def from_profile(cls, entry: LlmProfile) -> LlmProfileOut:
        """Project a `services.llm_profiles.LlmProfile` onto its product-facing
        API fields. Deliberately omits `target`: the resolved provider/model
        pair is an internal runtime fact, not a selection control (§10)."""
        return cls(
            id=entry.id,
            label=entry.label,
            description=entry.description,
            provider_label=entry.provider_label,
            model_label=entry.model_label,
            reasoning_options=[
                ReasoningOptionOut(id=option.id, label=option.label)
                for option in entry.reasoning_options
            ],
            default_reasoning_option_id=entry.default_reasoning_option_id,
            privacy_notice=entry.privacy_notice,
        )


class LlmProfilesOut(BaseModel):
    """Response schema for `GET /llm-profiles`."""

    default_profile_id: str
    profiles: list[LlmProfileOut]

    model_config = ConfigDict(frozen=True)

    @classmethod
    def from_profiles(cls) -> LlmProfilesOut:
        """Build the route's entire response from the product profile
        registry, so `api/routes/llm_profiles.py` is a thin adapter."""
        return cls(
            default_profile_id=DEFAULT_PROFILE_ID,
            profiles=[LlmProfileOut.from_profile(entry) for entry in PROFILES],
        )


# =============================================================================
# ExpectedChatFailure
# =============================================================================


class RefusedChatFailure(BaseModel):
    """Streamed Fable refusal (`provider_stream`) or a non-streamed provider
    refusal (`provider_http`). Never rerunnable (§10)."""

    code: Literal["refused"] = "refused"
    origin: Literal["provider_http", "provider_stream"]
    support_id: Presence[str]
    can_rerun: bool


class IncompleteChatFailure(BaseModel):
    """Provider-declared incomplete completion, or local truncation folded to
    the same closed code. `origin` is always `provider_response`."""

    code: Literal["incomplete"] = "incomplete"
    origin: Literal["provider_response"]
    support_id: Presence[str]
    can_rerun: bool


class CancelledChatFailure(BaseModel):
    """Run status `cancelled` alone drives this variant — `ChatRun` never
    stores a `cancelled` `error_code`, and a cancelled run's error columns are
    NULL, so this variant carries no `origin`."""

    code: Literal["cancelled"] = "cancelled"
    support_id: Presence[str]
    can_rerun: bool


class ContextTooLargeChatFailure(BaseModel):
    """Owner-side assembly rejected the intent before any generation attempt
    began (`intent`, ledgerless), or the provider rejected an in-bound request
    as oversize (`provider_http`)."""

    code: Literal["context_too_large"] = "context_too_large"
    origin: Literal["intent", "provider_http"]
    support_id: Presence[str]
    can_rerun: bool


class InvalidToolArgumentsChatFailure(BaseModel):
    code: Literal["invalid_tool_arguments"] = "invalid_tool_arguments"
    origin: Literal["tool_arguments"]
    support_id: Presence[str]
    can_rerun: bool


class BudgetExceededChatFailure(BaseModel):
    """Platform-token-reservation denial. Never rerunnable (§9)."""

    code: Literal["budget_exceeded"] = "budget_exceeded"
    origin: Literal["budget"]
    support_id: Presence[str]
    can_rerun: bool


class RateLimitedChatFailure(BaseModel):
    """Transient: mapped from the runtime's `TransientExhausted(cause=
    ProviderRateLimit)` leaf."""

    code: Literal["rate_limited"] = "rate_limited"
    origin: Literal["provider_http"]
    attempts: int = Field(ge=1)
    support_id: Presence[str]
    can_rerun: bool


class TimeoutChatFailure(BaseModel):
    """Transient: mapped from the runtime's `TransientExhausted(cause=
    ProviderTimeout)` leaf."""

    code: Literal["timeout"] = "timeout"
    origin: Literal["transport"]
    attempts: int = Field(ge=1)
    support_id: Presence[str]
    can_rerun: bool


class ProviderUnavailableChatFailure(BaseModel):
    """Transient: mapped from either the runtime's `TransientExhausted(cause=
    ProviderHttpUnavailable)` (`provider_http`) or `TransientExhausted(cause=
    TransportUnavailable)` (`transport`) leaf."""

    code: Literal["provider_unavailable"] = "provider_unavailable"
    origin: Literal["provider_http", "transport"]
    attempts: int = Field(ge=1)
    support_id: Presence[str]
    can_rerun: bool


class StreamInterruptedChatFailure(BaseModel):
    """Transient: mapped from the runtime's `TransientExhausted(cause=
    ProviderStreamInterrupted)` leaf, and from crashed/interrupted-run
    recovery when provider output existed without a terminal."""

    code: Literal["stream_interrupted"] = "stream_interrupted"
    origin: Literal["provider_stream"]
    attempts: int = Field(ge=1)
    support_id: Presence[str]
    can_rerun: bool


ExpectedChatFailure = Annotated[
    RefusedChatFailure
    | IncompleteChatFailure
    | CancelledChatFailure
    | ContextTooLargeChatFailure
    | InvalidToolArgumentsChatFailure
    | BudgetExceededChatFailure
    | RateLimitedChatFailure
    | TimeoutChatFailure
    | ProviderUnavailableChatFailure
    | StreamInterruptedChatFailure,
    Field(discriminator="code"),
]
