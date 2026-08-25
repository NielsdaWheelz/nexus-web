"""Product-facing Codex generation schemas.

The browser chooses one of three fixed chat profiles. Runtime target, effort,
provider, privacy, and retry facts are deliberately absent from this contract.
"""

from __future__ import annotations

from typing import Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.services import generation_policy

ChatProfileId = Literal["fast", "balanced", "deep"]
_PROFILE_ORDER: tuple[ChatProfileId, ChatProfileId, ChatProfileId] = (
    "fast",
    "balanced",
    "deep",
)
_PROFILE_LABELS = {"fast": "Fast", "balanced": "Balanced", "deep": "Deep"}
_MODEL_LABELS = {
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-sol": "GPT-5.6 Sol",
}
_EFFORT_LABELS = {"low": "Low", "medium": "Medium", "high": "High"}


class LlmProfileOut(BaseModel):
    id: ChatProfileId
    label: str
    description: str
    model_label: str
    effort_label: str

    model_config = ConfigDict(extra="forbid", frozen=True)


class LlmProfilesOut(BaseModel):
    """The exact three-option response for ``GET /llm-profiles``."""

    default_profile_id: Literal["balanced"]
    profiles: tuple[LlmProfileOut, LlmProfileOut, LlmProfileOut]

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="after")
    def _exact_profile_order(self) -> LlmProfilesOut:
        profile_ids = tuple(profile.id for profile in self.profiles)
        if profile_ids != _PROFILE_ORDER or len(set(profile_ids)) != len(profile_ids):
            raise ValueError("profiles must be exactly fast, balanced, deep in order")
        return self

    @classmethod
    def from_profiles(cls) -> LlmProfilesOut:
        profile_ids = cast(tuple[ChatProfileId, ...], generation_policy.CHAT_PROFILES)
        if profile_ids != _PROFILE_ORDER:
            raise AssertionError("generation policy profile order drifted")
        profiles = (
            _profile_out(profile_ids[0]),
            _profile_out(profile_ids[1]),
            _profile_out(profile_ids[2]),
        )
        return cls(
            default_profile_id="balanced",
            profiles=profiles,
        )


def _profile_out(profile_id: ChatProfileId) -> LlmProfileOut:
    policy = generation_policy.chat_policy(profile_id)
    try:
        label = _PROFILE_LABELS[profile_id]
        model_label = _MODEL_LABELS[policy.model]
        effort_label = _EFFORT_LABELS[policy.effort]
    except KeyError as error:
        raise AssertionError(f"unpresentable shipped chat policy {profile_id!r}") from error
    return LlmProfileOut(
        id=profile_id,
        label=label,
        description={
            "fast": "Quick responses for everyday questions.",
            "balanced": "The default profile: strong general-purpose reasoning.",
            "deep": "Slower, deeper reasoning for hard problems.",
        }[profile_id],
        model_label=model_label,
        effort_label=effort_label,
    )


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
    "CancelledChatFailure",
    "ContextTooLargeChatFailure",
    "ExpectedChatFailure",
    "ExpectedChatFailureBase",
    "IncompleteChatFailure",
    "InvalidOutputChatFailure",
    "LlmProfileOut",
    "LlmProfilesOut",
    "OperatorDefectChatFailure",
]
