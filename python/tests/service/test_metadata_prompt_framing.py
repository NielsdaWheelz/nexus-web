"""Bounded, deterministic wire framing for metadata enrichment input."""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import request_fingerprint
from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributors import (
    MediaTarget,
    apply_observed_role_slices_in_current_transaction,
)
from nexus.services.metadata_enrichment import build_enrichment_user_content
from nexus.tasks.enrich_metadata import _metadata_generation_command

_METADATA_INPUT_MAX_BYTES = generation_policy.operation_policy(
    "metadata_enrichment"
).input_max_bytes


def test_metadata_prompt_preserves_envelope_and_delimiter_at_utf8_input_ceiling(
    db_session: Session,
) -> None:
    """Risk: byte-clamping a finished prompt can delete its trusted closing delimiter."""

    media = Media(
        kind=MediaKind.web_article.value,
        title="A canonical title",
        requested_url="https://example.invalid/article",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()

    source_text = "metadata source \U0001f98a " * _METADATA_INPUT_MAX_BYTES
    prompt = build_enrichment_user_content(db_session, media, source_text)

    prompt_bytes = len(prompt.encode("utf-8"))
    assert _METADATA_INPUT_MAX_BYTES - 3 <= prompt_bytes
    assert prompt_bytes <= _METADATA_INPUT_MAX_BYTES, "metadata prompt exceeded wire input bound"
    assert prompt.endswith("\n---")
    assert "Early extracted text:\n---\n" in prompt
    assert prompt.encode("utf-8").decode("utf-8") == prompt

    first = _metadata_generation_command(
        generation_id=media.id,
        input=prompt,
    )
    replay = build_enrichment_user_content(db_session, media, source_text)
    second = _metadata_generation_command(
        generation_id=media.id,
        input=replay,
    )
    assert replay == prompt
    assert request_fingerprint(second) == request_fingerprint(first)


def test_metadata_prompt_bounds_oversized_persisted_hints_without_erasing_structure(
    db_session: Session,
) -> None:
    """Risk: an old unbounded Text value can make source text erase prompt labels."""

    media = Media(
        kind=MediaKind.web_article.value,
        title="x" * (_METADATA_INPUT_MAX_BYTES * 2),
        requested_url="https://example.invalid/article",
        publisher="publisher" * _METADATA_INPUT_MAX_BYTES,
        description="description" * _METADATA_INPUT_MAX_BYTES,
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()

    prompt = build_enrichment_user_content(
        db_session,
        media,
        "source text that must not remove trusted framing",
    )

    assert len(prompt.encode("utf-8")) < _METADATA_INPUT_MAX_BYTES
    assert 'Known metadata:\n- kind: "web_article"\n- current_title: ' in prompt
    assert "- requested_url: " in prompt
    assert "Media-kind target:" in prompt
    assert "Early extracted text:\n---\n" in prompt
    assert "source text that must not remove trusted framing" in prompt
    assert prompt.endswith("\n---")

    metadata_block = prompt.removeprefix("Known metadata:\n").split("\n\nMedia-kind target:", 1)[0]
    for line in metadata_block.splitlines():
        _, separator, value = line.partition(": ")
        assert separator == ": "
        json.loads(value)


def test_metadata_prompt_bounds_the_author_hint_as_a_valid_json_array(
    db_session: Session,
) -> None:
    """Risk: twenty long multi-byte credits overflow the per-hint budget and the
    author hint is no longer a JSON array the model can read."""

    media = Media(
        kind=MediaKind.epub.value,
        title="A canonical title",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()
    # Realistic accented names: each renders as roughly 60 bytes of ASCII-escaped
    # JSON, so twenty of them overrun the 1 KiB per-hint bound together while
    # every single name fits it and the contributor name bound.
    names = [
        f"Author {index:02d} " + "x" * 30 + " \u00c9lodie Pr\u00e9v\u00f4t" for index in range(20)
    ]
    assert all(len(name) <= MAX_CONTRIBUTOR_NAME_CODE_POINTS for name in names)
    apply_observed_role_slices_in_current_transaction(
        db_session,
        target=MediaTarget(media.id),
        observation=build_observation(
            {"author": [RawCreditEntry(credited_name=name, raw_role=None) for name in names]}
        )[0],
        source="metadata_enrichment",
    )
    db_session.flush()

    prompt = build_enrichment_user_content(db_session, media, "bounded source")

    assert len(prompt.encode("utf-8")) < _METADATA_INPUT_MAX_BYTES
    metadata_block = prompt.removeprefix("Known metadata:\n").split("\n\nMedia-kind target:", 1)[0]
    authors_line = next(
        line for line in metadata_block.splitlines() if line.startswith("- current_authors: ")
    )
    authors = json.loads(authors_line.removeprefix("- current_authors: "))
    assert isinstance(authors, list) and authors, "author hint must stay a JSON array"
    assert len(authors_line.encode("utf-8")) <= 1_024 + len("- current_authors: ")
    assert authors[-1] == "[truncated]", "omitted authors must be marked, not silently dropped"
    assert all(name in names for name in authors[:-1])
    assert 0 < len(authors) - 1 < len(names)
