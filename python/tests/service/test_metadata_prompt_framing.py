"""Bounded, deterministic wire framing for metadata enrichment input."""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.services.metadata_enrichment import build_enrichment_user_content
from nexus.services.native_agent_contract import METADATA_ENRICHMENT_MAX_INPUT_BYTES
from nexus.services.native_agent_operations import (
    build_metadata_enrichment_command,
    native_agent_request_fingerprint,
)


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

    source_text = "metadata source \U0001f98a " * METADATA_ENRICHMENT_MAX_INPUT_BYTES
    prompt = build_enrichment_user_content(db_session, media, source_text)

    prompt_bytes = len(prompt.encode("utf-8"))
    assert METADATA_ENRICHMENT_MAX_INPUT_BYTES - 3 <= prompt_bytes
    assert prompt_bytes <= METADATA_ENRICHMENT_MAX_INPUT_BYTES, (
        "metadata prompt exceeded wire input bound"
    )
    assert prompt.endswith("\n---")
    assert "Early extracted text:\n---\n" in prompt
    assert prompt.encode("utf-8").decode("utf-8") == prompt

    first = build_metadata_enrichment_command(
        request_id=media.id,
        input=prompt,
    )
    replay = build_enrichment_user_content(db_session, media, source_text)
    second = build_metadata_enrichment_command(
        request_id=media.id,
        input=replay,
    )
    assert replay == prompt
    assert native_agent_request_fingerprint(second) == native_agent_request_fingerprint(first)


def test_metadata_prompt_bounds_oversized_persisted_hints_without_erasing_structure(
    db_session: Session,
) -> None:
    """Risk: an old unbounded Text value can make source text erase prompt labels."""

    media = Media(
        kind=MediaKind.web_article.value,
        title="x" * (METADATA_ENRICHMENT_MAX_INPUT_BYTES * 2),
        requested_url="https://example.invalid/article",
        publisher="publisher" * METADATA_ENRICHMENT_MAX_INPUT_BYTES,
        description="description" * METADATA_ENRICHMENT_MAX_INPUT_BYTES,
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()

    prompt = build_enrichment_user_content(
        db_session,
        media,
        "source text that must not remove trusted framing",
    )

    assert len(prompt.encode("utf-8")) < METADATA_ENRICHMENT_MAX_INPUT_BYTES
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
