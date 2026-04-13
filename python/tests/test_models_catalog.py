"""Unit tests for curated model catalog metadata."""

import pytest

from nexus.services.models import get_model_catalog_metadata

pytestmark = pytest.mark.unit


def test_openai_reasoning_modes_match_responses_api():
    metadata = get_model_catalog_metadata("openai", "gpt-5.4")
    assert metadata is not None
    assert metadata[3] == ["none", "low", "medium", "high", "max"]


def test_anthropic_reasoning_modes_match_effort_support():
    metadata = get_model_catalog_metadata("anthropic", "claude-sonnet-4-6")
    assert metadata is not None
    assert metadata[3] == ["none", "low", "medium", "high", "max"]


def test_gemini_reasoning_modes_match_model_family_support():
    pro = get_model_catalog_metadata("gemini", "gemini-3.1-pro-preview")
    flash = get_model_catalog_metadata("gemini", "gemini-3-flash-preview")

    assert pro is not None
    assert flash is not None
    assert pro[3] == ["low", "high"]
    assert flash[3] == ["minimal", "low", "medium", "high"]


def test_deepseek_reasoning_modes_match_chat_vs_reasoner_split():
    chat = get_model_catalog_metadata("deepseek", "deepseek-chat")
    reasoner = get_model_catalog_metadata("deepseek", "deepseek-reasoner")

    assert chat is not None
    assert reasoner is not None
    assert chat[3] == ["none", "high"]
    assert reasoner[3] == ["high"]
