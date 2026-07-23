"""Unit tests for the Nexus LLM product profile registry."""

import typing
from dataclasses import replace

import pytest
from provider_runtime import CATALOG, DirectCertification, ProviderTarget

import nexus.services.llm_profiles as llm_profiles
from nexus.services.llm_profiles import (
    DEFAULT_PROFILE_ID,
    OPERATION_PROFILES,
    PROFILES,
    BackgroundLlmOperation,
    ReasoningOption,
    operation_profile,
    profile,
    reasoning_level,
    validate_profiles,
)

pytestmark = pytest.mark.unit


def test_validate_profiles_passes_for_the_real_catalog():
    validate_profiles()


def test_profile_display_order_matches_final_product_portfolio_table():
    # docs/cutovers/llm-provider-runtime-hard-cutover.md §4
    assert [entry.id for entry in PROFILES] == [
        "fast",
        "balanced",
        "deep",
        "claude",
        "fable",
        "gemini",
        "kimi",
    ]


def test_default_profile_is_balanced():
    assert DEFAULT_PROFILE_ID == "balanced"
    assert profile(DEFAULT_PROFILE_ID) is not None


def test_operation_profiles_is_total_over_background_llm_operation():
    all_operations = typing.get_args(BackgroundLlmOperation.__value__)

    assert set(OPERATION_PROFILES.keys()) == set(all_operations), (
        f"OPERATION_PROFILES must cover every BackgroundLlmOperation. "
        f"Missing: {set(all_operations) - set(OPERATION_PROFILES.keys())}, "
        f"extra: {set(OPERATION_PROFILES.keys()) - set(all_operations)}"
    )


def test_chat_is_not_a_background_operation_profile():
    assert "chat" not in OPERATION_PROFILES


def test_background_policy_matches_final_product_portfolio_table():
    # docs/cutovers/llm-provider-runtime-hard-cutover.md §4 background policy
    assert OPERATION_PROFILES == {
        "oracle": "fast",
        "media_summary": "fast",
        "metadata_enrichment": "fast",
        "synapse": "fast",
        "dawn_write": "balanced",
        "dossier_media": "balanced",
        "dossier_conversation": "balanced",
        "dossier_library": "balanced",
        "dossier_podcast": "balanced",
        "dossier_contributor": "balanced",
        "dossier_page": "fast",
        "dossier_note": "fast",
    }


def test_profile_resolves_known_id_and_returns_none_for_unknown_id():
    resolved = profile("balanced")
    assert resolved is not None
    assert resolved.id == "balanced"

    assert profile("does-not-exist") is None


def test_reasoning_level_resolves_valid_option_and_rejects_invalid_option():
    balanced = profile("balanced")
    assert balanced is not None

    assert reasoning_level(balanced, "medium") == "medium"
    assert reasoning_level(balanced, "not-a-level") is None

    gemini = profile("gemini")
    assert gemini is not None
    # "xhigh" is not offered by the gemini profile even though other profiles offer it.
    assert reasoning_level(gemini, "xhigh") is None


def test_operation_profile_resolves_every_background_operation():
    for background_operation in typing.get_args(BackgroundLlmOperation.__value__):
        resolved = operation_profile(background_operation)
        assert resolved.id == OPERATION_PROFILES[background_operation]


def test_validate_profiles_raises_on_reasoning_option_outside_the_catalog_contract(monkeypatch):
    gemini = profile("gemini")
    assert gemini is not None
    # gemini's real catalog contract offers only minimal/low/medium/high; "xhigh" is not.
    broken = replace(
        gemini,
        reasoning_options=(
            *gemini.reasoning_options,
            ReasoningOption(id="xhigh", label="Extra high"),
        ),
    )
    monkeypatch.setattr(llm_profiles, "PROFILES", (broken,))

    with pytest.raises(AssertionError, match="not supported"):
        validate_profiles()


def test_validate_profiles_raises_on_non_direct_certification_target(monkeypatch):
    balanced = profile("balanced")
    assert balanced is not None
    # The OpenRouter Kimi row exists in CATALOG but is OperatorUncertified, not
    # DirectCertification (it is an operator-only row per §4, never product-facing).
    broken = replace(
        balanced,
        target=ProviderTarget(provider="openrouter", model="moonshotai/kimi-k3-20260715"),
    )
    contract = CATALOG.chat_contract(broken.target)
    assert not isinstance(contract.certification, DirectCertification)
    monkeypatch.setattr(llm_profiles, "PROFILES", (broken,))

    with pytest.raises(AssertionError, match="DirectCertification"):
        validate_profiles()
