"""Unit tests for curated model catalog metadata."""

import pytest

from nexus.llm_catalog import MODEL_CATALOG, model_catalog_entry, require_catalog_model

pytestmark = pytest.mark.unit


def test_curated_catalog_contains_supported_models():
    metadata = [model_catalog_entry(model.provider, model.model_name) for model in MODEL_CATALOG]

    assert all(item is not None for item in metadata)
    assert len(metadata) == 9


def test_every_catalog_entry_supports_default_reasoning():
    """AC-2: "default" (provider default) is a valid reasoning mode for every model."""
    missing = [
        f"{entry.provider}/{entry.model_name}"
        for entry in MODEL_CATALOG
        if "default" not in entry.reasoning_modes
    ]
    assert missing == [], f"catalog entries missing the 'default' reasoning mode: {missing}"


def test_openai_reasoning_modes_match_responses_api():
    metadata = model_catalog_entry("openai", "gpt-5.5")
    assert metadata is not None
    assert list(metadata.reasoning_modes) == ["default", "none", "low", "medium", "high", "max"]


def test_anthropic_reasoning_modes_match_effort_support():
    opus = model_catalog_entry("anthropic", "claude-opus-4-7")
    sonnet = model_catalog_entry("anthropic", "claude-sonnet-4-6")

    assert opus is not None
    assert sonnet is not None
    assert list(opus.reasoning_modes) == ["default", "none", "low", "medium", "high", "max"]
    assert list(sonnet.reasoning_modes) == ["default", "none", "low", "medium", "high", "max"]


def test_gemini_reasoning_modes_match_model_family_support():
    pro = model_catalog_entry("gemini", "gemini-3.1-pro-preview")
    flash = model_catalog_entry("gemini", "gemini-3-flash-preview")

    assert pro is not None
    assert flash is not None
    assert list(pro.reasoning_modes) == ["default", "low", "high"]
    assert list(flash.reasoning_modes) == ["default", "minimal", "low", "medium", "high"]


def test_deepseek_reasoning_modes_match_pro_vs_flash_split():
    flash = model_catalog_entry("deepseek", "deepseek-v4-flash")
    pro = model_catalog_entry("deepseek", "deepseek-v4-pro")

    assert flash is not None
    assert pro is not None
    assert list(flash.reasoning_modes) == ["default", "none", "high"]
    assert list(pro.reasoning_modes) == ["default", "high"]


def test_require_catalog_model_returns_entry_and_defects_on_unknown():
    assert require_catalog_model("anthropic", "claude-haiku-4-5-20251001").provider == "anthropic"
    with pytest.raises(AssertionError, match="not in MODEL_CATALOG"):
        require_catalog_model("openai", "gpt-4o-mini")
