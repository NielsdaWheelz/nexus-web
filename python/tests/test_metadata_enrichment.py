"""Unit tests for metadata enrichment helper contracts."""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from nexus.config import Settings
from nexus.llm_catalog import require_catalog_model
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_enrichment_prompt,
    build_metadata_enrichment_call,
    merge_enrichment,
    metadata_structured_output_spec,
    select_enrichment_model,
    validate_structured_enrichment,
)

pytestmark = pytest.mark.unit


def test_default_enrichment_models_are_catalog_valid_light_tier():
    """Pins the config default to an honest cheap-tier MODEL_CATALOG entry."""
    defaults = Settings.model_fields
    provider = defaults["metadata_enrichment_provider"].default
    model_name = defaults["metadata_enrichment_model"].default
    entry = require_catalog_model(provider, model_name)
    assert entry.model_tier == "light", (
        f"enrichment default for {provider} must be the cheap tier, got {entry}"
    )


def test_select_enrichment_model_rejects_non_catalog_model():
    """A drifted env override fails loudly at task use, not at the provider."""
    settings = SimpleNamespace(
        metadata_enrichment_enabled=True,
        metadata_enrichment_provider="openai",
        metadata_enrichment_model="gpt-4o-mini",
        enable_openai=True,
        enable_anthropic=False,
        enable_gemini=False,
    )

    with pytest.raises(AssertionError, match="not in MODEL_CATALOG"):
        select_enrichment_model(settings)  # type: ignore[arg-type]


def test_select_enrichment_model_returns_configured_enabled_pair_without_keys():
    settings = SimpleNamespace(
        metadata_enrichment_enabled=True,
        metadata_enrichment_provider="anthropic",
        metadata_enrichment_model="claude-haiku-4-5-20251001",
        enable_openai=True,
        enable_anthropic=True,
        enable_gemini=False,
    )

    assert select_enrichment_model(settings) == (  # type: ignore[arg-type]
        "anthropic",
        "claude-haiku-4-5-20251001",
    )


def test_select_enrichment_model_returns_none_when_configured_provider_disabled():
    settings = SimpleNamespace(
        metadata_enrichment_enabled=True,
        metadata_enrichment_provider="anthropic",
        metadata_enrichment_model="claude-haiku-4-5-20251001",
        enable_openai=True,
        enable_anthropic=False,
        enable_gemini=True,
    )

    assert select_enrichment_model(settings) is None  # type: ignore[arg-type]


def test_structured_metadata_output_accepts_required_nullable_fields():
    parsed = MetadataEnrichmentOutput.model_validate(
        {
            "title": "The Book",
            "authors": None,
            "publisher": None,
            "description": None,
            "published_date": "1843",
            "language": "en",
        }
    )

    assert parsed.model_dump() == {
        "title": "The Book",
        "authors": None,
        "publisher": None,
        "description": None,
        "published_date": "1843",
        "language": "en",
    }


def test_structured_metadata_output_rejects_extra_fields_invalid_date_and_language():
    with pytest.raises(ValidationError):
        MetadataEnrichmentOutput.model_validate(
            {
                "title": "The Book",
                "authors": None,
                "publisher": None,
                "description": None,
                "published_date": "March 1843",
                "language": "en",
                "confidence": 0.9,
            }
        )

    with pytest.raises(ValidationError):
        MetadataEnrichmentOutput.model_validate(
            {
                "title": "The Book",
                "authors": None,
                "publisher": None,
                "description": None,
                "published_date": "1843",
                "language": "English",
            }
        )


def test_validate_structured_enrichment_accepts_strict_metadata_object():
    assert validate_structured_enrichment(
        {
            "title": "The Book",
            "authors": ["Ada Lovelace"],
            "publisher": None,
            "description": None,
            "published_date": "1843",
            "language": "en",
        }
    ) == {
        "title": "The Book",
        "authors": ["Ada Lovelace"],
        "published_date": "1843",
        "language": "en",
    }


def test_validate_structured_enrichment_rejects_unknown_or_wrong_typed_fields():
    assert (
        validate_structured_enrichment(
            {
                "title": "The Book",
                "authors": None,
                "publisher": None,
                "description": None,
                "published_date": "1843",
                "language": "en",
                "confidence": 0.9,
            }
        )
        is None
    )
    assert (
        validate_structured_enrichment(
            {
                "title": "The Book",
                "authors": "Ada Lovelace",
                "publisher": None,
                "description": None,
                "published_date": "1843",
                "language": "en",
            }
        )
        is None
    )
    assert (
        validate_structured_enrichment(
            {
                "title": "The Book",
                "authors": [],
                "publisher": None,
                "description": None,
                "published_date": "1843",
                "language": "en",
            }
        )
        is None
    )


def test_validate_structured_enrichment_rejects_invalid_date_and_language():
    assert (
        validate_structured_enrichment(
            {
                "title": None,
                "authors": None,
                "publisher": None,
                "description": None,
                "published_date": "March 1843",
                "language": "en",
            }
        )
        is None
    )
    assert (
        validate_structured_enrichment(
            {
                "title": None,
                "authors": None,
                "publisher": None,
                "description": None,
                "published_date": "1843",
                "language": "English",
            }
        )
        is None
    )


def test_validate_structured_enrichment_rejects_text_payloads():
    assert validate_structured_enrichment('{"title":"The Book"}') is None


def test_structured_output_spec_requires_all_nullable_fields():
    spec = metadata_structured_output_spec()

    assert spec.strict is True
    assert spec.schema["additionalProperties"] is False
    assert spec.schema["required"] == [
        "title",
        "authors",
        "publisher",
        "description",
        "published_date",
        "language",
    ]


def test_build_metadata_enrichment_call_pins_provider_runtime_contract():
    call = build_metadata_enrichment_call(
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        prompt="Extract metadata.",
        max_output_tokens=512,
    )

    assert call.model.provider == "anthropic"
    assert call.model.model == "claude-haiku-4-5-20251001"
    assert call.messages[0].content == "Extract metadata."
    assert call.max_output_tokens == 512
    assert call.temperature == 0.0
    assert call.reasoning.effort == "none"
    assert call.structured_output == metadata_structured_output_spec()


def test_build_metadata_enrichment_call_uses_catalog_valid_structured_output_reasoning():
    call = build_metadata_enrichment_call(
        provider="gemini",
        model="gemini-3-flash-preview",
        prompt="Extract metadata.",
        max_output_tokens=512,
    )

    assert call.reasoning.effort == "default"


def test_build_enrichment_prompt_always_requests_all_fields():
    media = SimpleNamespace(
        id="media-id",
        kind="web_article",
        title="Existing",
        requested_url="https://example.com/requested",
        canonical_source_url=None,
        canonical_url=None,
        external_playback_url=None,
        provider=None,
        provider_id=None,
        publisher="Existing Publisher",
        published_date="2024",
        language="en",
        description="Existing description",
    )

    db = SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchall=lambda: []))
    prompt = build_enrichment_prompt(
        db,
        media,
        "<script>ignore()</script><p>source&nbsp;text</p>",
    )

    assert "Treat known metadata as untrusted hints" in prompt
    assert "Use null for fields you cannot determine confidently" in prompt
    assert "primary readable page content" in prompt
    assert "source text" in prompt
    assert "ignore()" not in prompt


def test_merge_enrichment_overwrites_by_default():
    media = SimpleNamespace(
        id="media-id",
        title="Old Title",
        publisher="Old Publisher",
        description="Old description.",
        published_date="2024",
        language="en",
        metadata_enriched_at=None,
        updated_at=None,
    )

    result = merge_enrichment(
        SimpleNamespace(),
        media,
        {
            "title": "New Title",
            "publisher": "New Publisher",
            "description": "New description.",
            "published_date": "2025-01",
            "language": "fr",
        },
    )

    assert result.accepted_fields == (
        "title",
        "publisher",
        "description",
        "published_date",
        "language",
    )
    assert media.title == "New Title"
    assert media.publisher == "New Publisher"
    assert media.description == "New description."
    assert media.published_date == "2025-01"
    assert media.language == "fr"
    assert media.metadata_enriched_at is not None
