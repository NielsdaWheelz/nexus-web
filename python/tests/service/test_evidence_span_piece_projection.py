"""Exact span validation keeps source continuity and rejects stale block bytes."""

from uuid import uuid4

from sqlalchemy.orm import Session

from nexus.db.models import ContentBlock, EvidenceSpan, Fragment, Media
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.locator_resolver import resolve_evidence_span
from tests.testkit.auth import UserRecord


def test_span_piece_projection_preserves_unicode_and_rejects_changed_or_missing_blocks(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id, fragment_id, span_id = uuid4(), uuid4(), uuid4()
    middle = "é" * 16_000
    body = "skipA🧠" + middle + "Ztail"
    exact = "A🧠" + middle + "Z"
    db_session.add(
        Media(
            id=media_id,
            kind="web_article",
            title="Exact source",
            created_by_user_id=test_user.id,
            processing_status="ready_for_reading",
        )
    )
    db_session.flush()
    db_session.add(
        Fragment(
            id=fragment_id,
            media_id=media_id,
            idx=0,
            canonical_text=body,
            html_sanitized="<p>" + body + "</p>",
        )
    )
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    selector = {
        "kind": "web_text",
        "fragment_id": str(fragment_id),
        "start_offset": 4,
        "end_offset": 4 + len(exact),
        "text_quote": {"exact": exact, "prefix": "skip", "suffix": "tail"},
    }
    blocks = []
    position = 0
    for index, content in enumerate(("skipA🧠", middle, "Ztail"), 10):
        block = ContentBlock(
            id=uuid4(),
            owner_kind="media",
            owner_id=media_id,
            block_idx=index,
            block_kind="paragraph",
            canonical_text=content,
            source_start_offset=position,
            source_end_offset=position + len(content),
            heading_path=[],
            locator=selector,
            selector=selector,
            metadata_json={},
        )
        position += len(content)
        blocks.append(block)
        db_session.add(block)
    db_session.flush()
    span = EvidenceSpan(
        id=span_id,
        owner_kind="media",
        owner_id=media_id,
        start_block_id=blocks[0].id,
        end_block_id=blocks[2].id,
        start_block_offset=4,
        end_block_offset=1,
        span_text=exact,
        selector=selector,
        citation_label="source",
        resolver_kind="web",
    )
    db_session.add(span)
    db_session.flush()

    def status() -> str:
        db_session.flush()
        return resolve_evidence_span(db_session, viewer_id=test_user.id, evidence_span_id=span_id)[
            "resolver"
        ]["status"]

    assert status() == "resolved"
    blocks[1].canonical_text = "x" + middle[1:]
    assert status() == "unresolved"
    blocks[1].canonical_text = middle
    blocks[1].block_idx = 99
    assert status() == "unresolved"
    blocks[1].block_idx = 11
    span.end_block_offset = 99
    assert status() == "unresolved"
    span.end_block_offset = 1
    assert status() == "resolved"
