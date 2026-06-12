"""Unit tests for curated model catalog metadata."""

import pytest

from nexus.llm_catalog import (
    MODEL_CATALOG,
    model_catalog_entry,
    require_catalog_model,
    require_model_capabilities,
)

pytestmark = pytest.mark.unit


def test_curated_catalog_contains_supported_models():
    metadata = [model_catalog_entry(model.provider, model.model_name) for model in MODEL_CATALOG]

    assert all(item is not None for item in metadata)
    assert len(metadata) == 11


def test_every_catalog_entry_supports_default_reasoning():
    """AC-2: "default" is a valid runtime-owned reasoning mode for every model."""
    missing = [
        f"{entry.provider}/{entry.model_name}"
        for entry in MODEL_CATALOG
        if "default" not in entry.reasoning_modes
    ]
    assert missing == [], f"catalog entries missing the 'default' reasoning mode: {missing}"


def test_openai_reasoning_modes_match_responses_api():
    metadata = model_catalog_entry("openai", "gpt-5.5")
    assert metadata is not None
    assert list(metadata.reasoning_modes) == [
        "default",
        "none",
        "low",
        "medium",
        "high",
        "max",
    ]


def test_anthropic_reasoning_modes_match_effort_support():
    opus = model_catalog_entry("anthropic", "claude-opus-4-8")
    sonnet = model_catalog_entry("anthropic", "claude-sonnet-4-6")

    assert opus is not None
    assert sonnet is not None
    assert list(opus.reasoning_modes) == [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]
    assert list(sonnet.reasoning_modes) == [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]


def test_gemini_reasoning_modes_match_model_family_support():
    pro = model_catalog_entry("gemini", "gemini-3.1-pro-preview")
    flash = model_catalog_entry("gemini", "gemini-3-flash-preview")

    assert pro is not None
    assert flash is not None
    assert list(pro.reasoning_modes) == [
        "default",
        "low",
        "medium",
        "high",
        "max",
    ]
    assert list(flash.reasoning_modes) == [
        "default",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]


def test_openrouter_reasoning_modes_match_forwarded_model_family():
    kimi = model_catalog_entry("openrouter", "moonshotai/kimi-k2.6")
    light = model_catalog_entry("openrouter", "openai/gpt-5.4-mini")
    sota = model_catalog_entry("openrouter", "openai/gpt-5.5")

    assert kimi is not None
    assert light is not None
    assert sota is not None
    assert list(kimi.reasoning_modes) == [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]
    assert list(light.reasoning_modes) == [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]
    assert list(sota.reasoning_modes) == [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max",
    ]


def test_cloudflare_reasoning_modes_match_workers_ai_model():
    gpt_oss = model_catalog_entry("cloudflare", "@cf/openai/gpt-oss-20b")

    assert gpt_oss is not None
    assert list(gpt_oss.reasoning_modes) == ["default", "none"]


def test_catalog_capabilities_match_provider_runtime_contract():
    openai = require_model_capabilities("openai", "gpt-5.5")
    anthropic = require_model_capabilities("anthropic", "claude-haiku-4-5-20251001")
    gemini = require_model_capabilities("gemini", "gemini-3-flash-preview")
    openrouter = require_model_capabilities("openrouter", "openai/gpt-5.4-mini")
    cloudflare = require_model_capabilities("cloudflare", "@cf/openai/gpt-oss-20b")

    assert openai.prompt_cache.mode == "keyed_ttl"
    assert openai.prompt_cache.requires_key is True
    assert anthropic.prompt_cache.mode == "turn_ttl"
    assert anthropic.prompt_cache.requires_key is False
    assert gemini.prompt_cache.mode == "none"
    assert openrouter.prompt_cache.mode == "none"
    assert cloudflare.prompt_cache.mode == "none"
    assert openai.reasoning_continuation is True
    assert anthropic.reasoning_continuation is True
    assert gemini.reasoning_continuation is True
    assert openrouter.reasoning_continuation is False
    assert cloudflare.reasoning_continuation is False
    assert cloudflare.structured_output is False


def test_require_catalog_model_returns_entry_and_defects_on_unknown():
    assert require_catalog_model("anthropic", "claude-haiku-4-5-20251001").provider == "anthropic"
    with pytest.raises(AssertionError, match="not in MODEL_CATALOG"):
        require_catalog_model("openai", "gpt-4o-mini")
