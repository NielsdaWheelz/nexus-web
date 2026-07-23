"""Nexus product LLM profile registry.

`provider_runtime.CATALOG` owns exact model contracts (context limits,
reasoning levels, cache mechanics, certification). This module owns only
product labels, display order, operation eligibility, and the mapping from a
profile to its certified runtime target. See
`docs/cutovers/llm-provider-runtime-hard-cutover.md` §4 for the authoritative
profile table and background policy this module reproduces.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from provider_runtime import CATALOG, DirectCertification, ProviderTarget, ReasoningLevel

type BackgroundLlmOperation = Literal[
    "oracle",
    "media_summary",
    "metadata_enrichment",
    "synapse",
    "dawn_write",
    "dossier_media",
    "dossier_conversation",
    "dossier_library",
    "dossier_podcast",
    "dossier_contributor",
    "dossier_page",
    "dossier_note",
]
type LlmOperation = BackgroundLlmOperation | Literal["chat"]


@dataclass(frozen=True, slots=True)
class ReasoningOption:
    id: ReasoningLevel
    label: str


@dataclass(frozen=True, slots=True)
class LlmProfile:
    id: str
    label: str
    description: str
    provider_label: str
    model_label: str
    target: ProviderTarget
    reasoning_options: tuple[ReasoningOption, ...]
    default_reasoning_option_id: ReasoningLevel
    privacy_notice: str


_REASONING_LABELS: dict[ReasoningLevel, str] = {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
}


def _reasoning_options(*ids: ReasoningLevel) -> tuple[ReasoningOption, ...]:
    return tuple(ReasoningOption(id=level, label=_REASONING_LABELS[level]) for level in ids)


_GPT_56_REASONING = ("none", "low", "medium", "high", "xhigh", "max")
_CLAUDE_REASONING = ("low", "medium", "high", "xhigh", "max")
_STANDARD_RETENTION = (
    "Standard provider retention. Nexus does not send this profile's requests "
    "or responses to a third party for model training."
)
_FABLE_RETENTION = (
    "Anthropic retains Fable 5 requests and responses for 30 days as a "
    "condition of access to this model; it is not eligible for zero-data-"
    "retention. Nexus does not send this profile's requests or responses to a "
    "third party for model training."
)

PROFILES: tuple[LlmProfile, ...] = (
    LlmProfile(
        id="fast",
        label="Fast · Luna",
        description="Quick, low-cost responses for everyday questions.",
        provider_label="OpenAI",
        model_label="GPT-5.6 Luna",
        target=ProviderTarget(provider="openai", model="gpt-5.6-luna"),
        reasoning_options=_reasoning_options(*_GPT_56_REASONING),
        default_reasoning_option_id="low",
        privacy_notice=_STANDARD_RETENTION,
    ),
    LlmProfile(
        id="balanced",
        label="Balanced · Terra",
        description="The default profile: strong general-purpose reasoning.",
        provider_label="OpenAI",
        model_label="GPT-5.6 Terra",
        target=ProviderTarget(provider="openai", model="gpt-5.6-terra"),
        reasoning_options=_reasoning_options(*_GPT_56_REASONING),
        default_reasoning_option_id="medium",
        privacy_notice=_STANDARD_RETENTION,
    ),
    LlmProfile(
        id="deep",
        label="Deep · Sol",
        description="Slower, deeper reasoning for hard problems.",
        provider_label="OpenAI",
        model_label="GPT-5.6 Sol",
        target=ProviderTarget(provider="openai", model="gpt-5.6-sol"),
        reasoning_options=_reasoning_options(*_GPT_56_REASONING),
        default_reasoning_option_id="high",
        privacy_notice=_STANDARD_RETENTION,
    ),
    LlmProfile(
        id="claude",
        label="Claude · Sonnet 5",
        description="Anthropic's flagship model.",
        provider_label="Anthropic",
        model_label="Claude Sonnet 5",
        target=ProviderTarget(provider="anthropic", model="claude-sonnet-5"),
        reasoning_options=_reasoning_options(*_CLAUDE_REASONING),
        default_reasoning_option_id="medium",
        privacy_notice=_STANDARD_RETENTION,
    ),
    LlmProfile(
        id="fable",
        label="Claude · Fable 5",
        description="Anthropic's creative-writing model.",
        provider_label="Anthropic",
        model_label="Claude Fable 5",
        target=ProviderTarget(provider="anthropic", model="claude-fable-5"),
        reasoning_options=_reasoning_options(*_CLAUDE_REASONING),
        default_reasoning_option_id="high",
        privacy_notice=_FABLE_RETENTION,
    ),
    LlmProfile(
        id="gemini",
        label="Gemini · 3.5 Flash",
        description="Google's fast multimodal model.",
        provider_label="Google",
        model_label="Gemini 3.5 Flash",
        target=ProviderTarget(provider="gemini", model="gemini-3.5-flash"),
        reasoning_options=_reasoning_options("minimal", "low", "medium", "high"),
        default_reasoning_option_id="medium",
        privacy_notice=_STANDARD_RETENTION,
    ),
    LlmProfile(
        id="kimi",
        label="Kimi · K3",
        description="Moonshot's Kimi K3 model.",
        provider_label="Moonshot",
        model_label="Kimi K3",
        target=ProviderTarget(provider="moonshot", model="kimi-k3"),
        reasoning_options=_reasoning_options("low", "high", "max"),
        default_reasoning_option_id="high",
        privacy_notice=_STANDARD_RETENTION,
    ),
)

DEFAULT_PROFILE_ID = "balanced"

_PROFILES_BY_ID: dict[str, LlmProfile] = {profile.id: profile for profile in PROFILES}

OPERATION_PROFILES: dict[BackgroundLlmOperation, str] = {
    "oracle": "fast",
    "media_summary": "fast",
    "metadata_enrichment": "fast",
    "synapse": "fast",
    "dawn_write": "balanced",
    # Universal dossier generation (CONTRACTS.md A4): one operation per subject
    # binding. This maps each operation to its LLM *profile* only -- the
    # reasoning override (Library/Podcast/Contributor run balanced at "high",
    # not balanced's own "medium" default) is a `DossierBinding.reasoning`
    # field applied in the dossier_build job, not a second profile here.
    "dossier_media": "balanced",
    "dossier_conversation": "balanced",
    "dossier_library": "balanced",
    "dossier_podcast": "balanced",
    "dossier_contributor": "balanced",
    "dossier_page": "fast",
    "dossier_note": "fast",
}


def profile(profile_id: str) -> LlmProfile | None:
    """Look up a profile by id; `None` for an unknown or retired id."""
    return _PROFILES_BY_ID.get(profile_id)


def reasoning_level(target: LlmProfile, reasoning_option_id: str) -> ReasoningLevel | None:
    """Validate `reasoning_option_id` against a profile's offered options."""
    for option in target.reasoning_options:
        if option.id == reasoning_option_id:
            return option.id
    return None


def operation_profile(operation: BackgroundLlmOperation) -> LlmProfile:
    """The profile a background operation always runs on. Total over `OPERATION_PROFILES`."""
    profile_id = OPERATION_PROFILES[operation]
    resolved = profile(profile_id)
    if resolved is None:
        # justify-defect: OPERATION_PROFILES is validated against PROFILES at
        # startup by validate_profiles(); an unresolved id here means startup
        # validation did not run.
        raise AssertionError(f"operation {operation!r} maps to unknown profile {profile_id!r}")
    return resolved


def validate_profiles() -> None:
    """Fail fast on any drift between the product portfolio and the runtime catalog.

    Called at app and worker startup, and by the unit test. Raises
    `AssertionError` with a descriptive message on any violation.
    """
    if DEFAULT_PROFILE_ID not in _PROFILES_BY_ID:
        raise AssertionError(f"DEFAULT_PROFILE_ID {DEFAULT_PROFILE_ID!r} is not a known profile id")

    for background_operation, profile_id in OPERATION_PROFILES.items():
        if profile_id not in _PROFILES_BY_ID:
            raise AssertionError(
                f"OPERATION_PROFILES[{background_operation!r}] = {profile_id!r} "
                "is not a known profile id"
            )

    for entry in PROFILES:
        contract = CATALOG.chat_contract(entry.target)
        if not isinstance(contract.certification, DirectCertification):
            raise AssertionError(
                f"profile {entry.id!r} targets {entry.target.provider}/{entry.target.model}, "
                f"which is not DirectCertification-certified ({contract.certification!r})"
            )

        option_ids = {option.id for option in entry.reasoning_options}
        unsupported = option_ids - set(contract.reasoning.levels)
        if unsupported:
            raise AssertionError(
                f"profile {entry.id!r} offers reasoning options {sorted(unsupported)} "
                f"not supported by {entry.target.provider}/{entry.target.model} "
                f"(supported: {sorted(contract.reasoning.levels)})"
            )

        if entry.default_reasoning_option_id not in option_ids:
            raise AssertionError(
                f"profile {entry.id!r} default_reasoning_option_id "
                f"{entry.default_reasoning_option_id!r} is not among its own reasoning_options "
                f"{sorted(option_ids)}"
            )
