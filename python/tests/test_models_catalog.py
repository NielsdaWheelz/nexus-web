"""Unit tests for curated model catalog metadata."""

import pytest

from nexus.services.models import get_model_catalog_metadata

pytestmark = pytest.mark.unit


def test_curated_catalog_contains_only_hard_cutover_models():
    catalog = {
        "openai": ["gpt-5.5", "gpt-5.4-mini"],
        "anthropic": [
            "claude-opus-4-7",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001",
        ],
        "gemini": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
        "deepseek": ["deepseek-v4-pro", "deepseek-v4-flash"],
    }

    metadata = [
        get_model_catalog_metadata(provider, model_name)
        for provider, model_names in catalog.items()
        for model_name in model_names
    ]

    assert all(item is not None for item in metadata)
    assert len(metadata) == 9


def test_openai_reasoning_modes_match_responses_api():
    metadata = get_model_catalog_metadata("openai", "gpt-5.5")
    assert metadata is not None
    assert metadata[3] == ["default", "none", "low", "medium", "high", "max"]


def test_anthropic_reasoning_modes_match_effort_support():
    opus = get_model_catalog_metadata("anthropic", "claude-opus-4-7")
    sonnet = get_model_catalog_metadata("anthropic", "claude-sonnet-4-6")

    assert opus is not None
    assert sonnet is not None
    assert opus[3] == ["none", "low", "medium", "high", "max"]
    assert sonnet[3] == ["none", "low", "medium", "high", "max"]


def test_gemini_reasoning_modes_match_model_family_support():
    pro = get_model_catalog_metadata("gemini", "gemini-3.1-pro-preview")
    flash = get_model_catalog_metadata("gemini", "gemini-3-flash-preview")

    assert pro is not None
    assert flash is not None
    assert pro[3] == ["low", "high"]
    assert flash[3] == ["minimal", "low", "medium", "high"]


def test_deepseek_reasoning_modes_match_pro_vs_flash_split():
    flash = get_model_catalog_metadata("deepseek", "deepseek-v4-flash")
    pro = get_model_catalog_metadata("deepseek", "deepseek-v4-pro")

    assert flash is not None
    assert pro is not None
    assert flash[3] == ["none", "high"]
    assert pro[3] == ["high"]


def test_stale_model_names_are_not_curated():
    stale_models = [
        ("openai", "gpt-5.4"),
        ("anthropic", "claude-opus-4-6"),
        ("anthropic", "claude-haiku-4-5-20250901"),
        ("gemini", "gemini-3.1-pro-experimental"),
        ("gemini", "gemini-3-flash-experimental"),
        ("deepseek", "deepseek-chat"),
        ("deepseek", "deepseek-reasoner"),
    ]

    for provider, model_name in stale_models:
        assert get_model_catalog_metadata(provider, model_name) is None
