"""Unit tests for metadata enrichment helper contracts."""

from types import SimpleNamespace

import pytest
from provider_runtime import StrictJsonOutput, SystemMessage, UserMessage
from pydantic import ValidationError

from nexus.db.models import Media
from nexus.services.contributor_taxonomy import NOT_OBSERVED, ObservedRoleSlices
from nexus.services.llm_profiles import operation_profile
from nexus.services.metadata_enrichment import (
    METADATA_ENRICHMENT_OPERATION,
    MetadataEnrichmentOutput,
    build_enrichment_user_content,
    build_metadata_enrichment_intent,
    merge_enrichment,
    validate_structured_enrichment,
)
from tests.factories import create_test_media_in_library, get_user_default_library

# ---------------------------------------------------------------------------
# Provider/model selection — DROPPED (no successor in this module)
# ---------------------------------------------------------------------------
#
# Pre-cutover, this module owned catalog-pinning + per-call provider fallback:
# `MODEL_CATALOG` / `require_catalog_model` / `select_enrichment_model`. All of
# it is gone (`nexus.llm_catalog` deleted whole). `metadata_enrichment` is now
# pinned to a single fixed profile ("fast") via the one `OPERATION_PROFILES`
# table in `nexus.services.llm_profiles`; there is no per-call fallback chain,
# and "is this profile's target a real, certified, cheap-tier model" is now
# `llm_profiles.validate_profiles()`'s job (its own startup check + unit test),
# not this module's. The following pre-cutover tests have no successor and
# were dropped outright:
#   - test_default_enrichment_models_are_catalog_valid_light_tier
#   - test_select_enrichment_model_rejects_non_catalog_model
#   - test_select_enrichment_model_returns_configured_enabled_pair_without_keys
#   - test_select_enrichment_model_returns_none_when_configured_provider_disabled
#
# No file-level `pytestmark` here (unlike the pre-cutover file): one test below
# is DB-backed (`build_enrichment_user_content` now reads the real
# contributor_credits relation) and is marked `integration` individually; every
# other test in this file is pure-function/no-DB.


def test_metadata_enrichment_operation_is_pinned_to_the_fast_profile():
    """Closest surviving analog of the old "cheap tier" pin: the operation
    always resolves to the fixed "fast" profile, with no per-call selection."""
    profile = operation_profile(METADATA_ENRICHMENT_OPERATION)
    assert profile.id == "fast"


# ---------------------------------------------------------------------------
# MetadataEnrichmentOutput / validate_structured_enrichment — unchanged
# ---------------------------------------------------------------------------


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


def _enrichment_payload(**overrides: object) -> dict:
    payload: dict[str, object] = {
        "title": None,
        "authors": None,
        "publisher": None,
        "description": None,
        "published_date": None,
        "language": None,
    }
    payload.update(overrides)
    return payload


def test_structured_metadata_title_length_cap_255_accepted_256_rejected():
    # Cap relocated from a JSON-schema maxLength into _non_empty_string (§ Value
    # constraints kept out of the emitted JSON schema); title has no other
    # format validator, so the boundary is exercised end-to-end through the model.
    parsed = MetadataEnrichmentOutput.model_validate(_enrichment_payload(title="x" * 255))
    assert parsed.title == "x" * 255

    with pytest.raises(ValidationError, match="at most 255 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(title="x" * 256))


def test_structured_metadata_publisher_length_cap_255_accepted_256_rejected():
    parsed = MetadataEnrichmentOutput.model_validate(_enrichment_payload(publisher="x" * 255))
    assert parsed.publisher == "x" * 255

    with pytest.raises(ValidationError, match="at most 255 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(publisher="x" * 256))


def test_structured_metadata_description_length_cap_2000_accepted_2001_rejected():
    parsed = MetadataEnrichmentOutput.model_validate(_enrichment_payload(description="x" * 2000))
    assert parsed.description == "x" * 2000

    with pytest.raises(ValidationError, match="at most 2000 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(description="x" * 2001))


def test_structured_metadata_published_date_over_cap_is_rejected_by_length_check():
    # published_date's cap is 64 chars, but every value the format validator
    # (_valid_partial_iso_date, YYYY / YYYY-MM / YYYY-MM-DD) accepts is at most
    # 10 chars — no string can be both 64 chars long and format-valid, so the
    # accept side of this boundary can never be exercised end-to-end through the
    # model. A too-long value is still caught by the length check, which runs
    # (and raises) before the format validator ever sees it.
    with pytest.raises(ValidationError, match="at most 64 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(published_date="1" * 65))


def test_structured_metadata_published_date_length_validator_accepts_64_in_isolation():
    # _non_empty_string is the sole owner of the published_date length cap; call
    # it directly (duck-typed ValidationInfo — only .field_name is read) to prove
    # the cap itself accepts exactly 64 chars, isolated from the format validator
    # that runs after it and would reject a non-date-shaped 64-char string.
    info = SimpleNamespace(field_name="published_date")
    value = "1" * 64
    assert MetadataEnrichmentOutput._non_empty_string(value, info) == value


def test_structured_metadata_language_over_cap_is_rejected_by_length_check():
    # Same interplay as published_date: language's format validator only accepts
    # exactly 2 lowercase letters, so no 32-char string can pass both checks. The
    # over-cap (33 chars) value is still rejected by the length check first.
    with pytest.raises(ValidationError, match="at most 32 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(language="a" * 33))


def test_structured_metadata_language_length_validator_accepts_32_in_isolation():
    info = SimpleNamespace(field_name="language")
    value = "a" * 32
    assert MetadataEnrichmentOutput._non_empty_string(value, info) == value


def test_structured_metadata_authors_count_cap_20_accepted_21_rejected():
    parsed = MetadataEnrichmentOutput.model_validate(
        _enrichment_payload(authors=[f"Author {i}" for i in range(20)])
    )
    assert parsed.authors is not None and len(parsed.authors) == 20

    with pytest.raises(ValidationError, match="at most 20 entries"):
        MetadataEnrichmentOutput.model_validate(
            _enrichment_payload(authors=[f"Author {i}" for i in range(21)])
        )


def test_structured_metadata_author_name_length_cap_255_accepted_256_rejected():
    parsed = MetadataEnrichmentOutput.model_validate(_enrichment_payload(authors=["x" * 255]))
    assert parsed.authors == ["x" * 255]

    with pytest.raises(ValidationError, match="at most 255 characters"):
        MetadataEnrichmentOutput.model_validate(_enrichment_payload(authors=["x" * 256]))


# ---------------------------------------------------------------------------
# build_metadata_enrichment_intent — replaces build_metadata_enrichment_call /
# metadata_structured_output_spec (both deleted: the provider_runtime "Call"
# object and hand-rolled structured-output spec no longer exist — an owner now
# builds one typed `GenerateIntent` and hands it to `execute_generation`).
# ---------------------------------------------------------------------------


def test_build_metadata_enrichment_intent_shape():
    intent = build_metadata_enrichment_intent(
        user_content="Known metadata:\n- kind: web_article",
        max_output_tokens=512,
    )

    profile = operation_profile(METADATA_ENRICHMENT_OPERATION)
    assert intent.target == profile.target
    assert intent.reasoning == profile.default_reasoning_option_id
    assert intent.max_output_tokens == 512
    assert intent.tools == ()
    assert intent.tool_choice == "none"

    system_text = "\n".join(
        block.text
        for message in intent.messages
        if isinstance(message, SystemMessage)
        for block in message.blocks
    )
    # The invariant rules block moved out of the per-call prompt string into
    # the intent's Stable system block; this is where "untrusted hints" /
    # "use null" now live (previously asserted on build_enrichment_prompt's
    # return value directly).
    assert "Treat known metadata as untrusted hints" in system_text
    assert "Use null for fields you cannot determine confidently" in system_text

    user_text = "\n".join(
        block.text
        for message in intent.messages
        if isinstance(message, UserMessage)
        for block in message.blocks
    )
    assert user_text == "Known metadata:\n- kind: web_article"

    assert isinstance(intent.output, StrictJsonOutput)
    assert intent.output.name == "media_metadata_enrichment"
    # ObjectNode is a *closed* object by construction (docstring: "required ==
    # all property names and additionalProperties: false are implied by
    # construction, not stored") — there is no dict to index into any more;
    # the property set is the full nullable-field contract.
    assert set(intent.output.schema.root.properties) == {
        "title",
        "authors",
        "publisher",
        "description",
        "published_date",
        "language",
    }


# ---------------------------------------------------------------------------
# build_enrichment_user_content — replaces build_enrichment_prompt.
#
# The per-media dynamic block now also renders `current_authors` via
# get_current_author_names(db, media), which reads the real
# contributor_credits relation — a SimpleNamespace stub db (as the old test
# used) can no longer stand in, so this test uses a real media row + db_session.
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_build_enrichment_user_content_always_requests_all_fields(db_session, bootstrapped_user):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Existing"
    )
    media = db_session.get(Media, media_id)
    assert media is not None
    media.requested_url = "https://example.com/requested"
    media.publisher = "Existing Publisher"
    media.published_date = "2024"
    media.language = "en"
    media.description = "Existing description"

    content = build_enrichment_user_content(
        db_session,
        media,
        "<script>ignore()</script><p>source&nbsp;text</p>",
    )

    assert "primary readable page content" in content
    assert "source text" in content
    assert "ignore()" not in content
    assert "Existing Publisher" in content
    assert "2024" in content
    assert "requested_url" in content


# ---------------------------------------------------------------------------
# merge_enrichment — unchanged
# ---------------------------------------------------------------------------


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
    # No authors in the payload: nothing to observe, nothing written.
    assert result.author_observation is NOT_OBSERVED


def _author_merge_media() -> SimpleNamespace:
    return SimpleNamespace(
        id="media-id",
        title="Old Title",
        publisher=None,
        description=None,
        published_date=None,
        language=None,
        metadata_enriched_at=None,
        updated_at=None,
    )


def test_merge_enrichment_builds_author_observation_without_writing():
    # merge_enrichment no longer writes credits (spec 2.4): it returns a typed
    # observation the caller applies on a fresh session. Passing a bare
    # SimpleNamespace as the db proves the author branch touches no database.
    media = _author_merge_media()

    result = merge_enrichment(
        SimpleNamespace(),
        media,
        {"authors": ["Jane Doe", "  Ada  Lovelace  "]},
    )

    assert "authors" in result.accepted_fields
    assert isinstance(result.author_observation, ObservedRoleSlices)
    assert result.author_observation.managed_roles == frozenset({"author"})
    assert [credit.credited_name for credit in result.author_observation.credits] == [
        "Jane Doe",
        "Ada Lovelace",
    ]
    assert all(credit.role == "author" for credit in result.author_observation.credits)
    # An accepted author fact still stamps the enrichment timestamp.
    assert media.metadata_enriched_at is not None


def test_merge_enrichment_absent_authors_is_not_observed():
    media = _author_merge_media()

    result = merge_enrichment(SimpleNamespace(), media, {"title": "New Title"})

    assert "authors" not in result.accepted_fields
    assert result.author_observation is NOT_OBSERVED


def test_merge_enrichment_empty_author_list_is_not_observed():
    # An empty parse can never assert "no authors" for an automatic source (D-5);
    # it maps to NOT_OBSERVED so prior credits are preserved downstream.
    media = _author_merge_media()

    result = merge_enrichment(SimpleNamespace(), media, {"authors": []})

    assert "authors" not in result.accepted_fields
    assert result.author_observation is NOT_OBSERVED


def test_merge_enrichment_does_not_consult_media_author_pin():
    # The pin is enforced by the facade, not here — merge_enrichment must not
    # special-case it. The media object has no authors_manually_managed attribute,
    # so any pin read would raise AttributeError.
    media = _author_merge_media()

    result = merge_enrichment(SimpleNamespace(), media, {"authors": ["Solo Author"]})

    assert isinstance(result.author_observation, ObservedRoleSlices)
