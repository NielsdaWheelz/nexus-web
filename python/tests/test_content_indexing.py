"""Integration tests for shared content index validation."""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.content_indexing import (
    IndexableBlock,
    IndexOwner,
    rebuild_content_index,
    repair_ready_media_content_index_now,
)

pytestmark = pytest.mark.integration


def test_rebuild_rejects_malformed_blocks_selectors_and_offsets_before_citations(
    db_session: Session,
):
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    text_value = "Validation should fail before durable evidence is written."
    locator = {
        "kind": "web_text",
        "fragment_id": str(fragment_id),
        "fragment_idx": 0,
        "start_offset": 0,
        "end_offset": len(text_value),
        "text_quote": {"exact": text_value, "prefix": "", "suffix": ""},
    }

    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:media_id, 'web_article', 'Malformed Index Input', 'ready_for_reading', :user_id)
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )

    cases: list[Callable[[], IndexableBlock]] = [
        lambda: _web_block(
            media_id=media_id,
            text_value=text_value,
            locator=locator,
            source_end_offset=len(text_value) + 1,
        ),
        lambda: _web_block(
            media_id=media_id,
            text_value=text_value,
            locator=locator,
            selector={key: value for key, value in locator.items() if key != "text_quote"},
        ),
        lambda: _web_block(
            media_id=media_id,
            text_value=text_value,
            locator=locator,
            block_kind="",
        ),
    ]

    for build_block in cases:
        with pytest.raises(ValueError):
            rebuild_content_index(
                db_session,
                owner=IndexOwner("media", media_id),
                source_kind="web_article",
                blocks=[build_block()],
                reason="validation_test",
            )

    counts = db_session.execute(
        text(
            """
            SELECT
                (SELECT COUNT(*) FROM content_blocks
                 WHERE owner_kind = 'media' AND owner_id = :media_id),
                (SELECT COUNT(*) FROM evidence_spans
                 WHERE owner_kind = 'media' AND owner_id = :media_id),
                (SELECT COUNT(*) FROM content_chunks
                 WHERE owner_kind = 'media' AND owner_id = :media_id)
            """
        ),
        {"media_id": media_id},
    ).one()
    assert counts == (0, 0, 0)


def test_rebuild_rejects_out_of_order_source_offsets(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    first_text = "Second source block."
    second_text = "First source block."

    _insert_ready_media(db_session, user_id=user_id, media_id=media_id)

    with pytest.raises(ValueError, match="sorted and non-overlapping"):
        rebuild_content_index(
            db_session,
            owner=IndexOwner("media", media_id),
            source_kind="web_article",
            blocks=[
                _web_block(
                    media_id=media_id,
                    text_value=first_text,
                    locator=_web_locator(fragment_id, first_text, start_offset=20),
                    block_idx=0,
                    source_start_offset=20,
                ),
                _web_block(
                    media_id=media_id,
                    text_value=second_text,
                    locator=_web_locator(fragment_id, second_text, start_offset=0),
                    block_idx=1,
                    source_start_offset=0,
                ),
            ],
            reason="validation_test",
        )


def test_rebuild_rejects_overlapping_source_offsets(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    first_text = "Overlapping source block."
    second_text = "Source overlap."

    _insert_ready_media(db_session, user_id=user_id, media_id=media_id)

    with pytest.raises(ValueError, match="sorted and non-overlapping"):
        rebuild_content_index(
            db_session,
            owner=IndexOwner("media", media_id),
            source_kind="web_article",
            blocks=[
                _web_block(
                    media_id=media_id,
                    text_value=first_text,
                    locator=_web_locator(fragment_id, first_text, start_offset=0),
                    block_idx=0,
                    source_start_offset=0,
                ),
                _web_block(
                    media_id=media_id,
                    text_value=second_text,
                    locator=_web_locator(fragment_id, second_text, start_offset=8),
                    block_idx=1,
                    source_start_offset=8,
                ),
            ],
            reason="validation_test",
        )


def test_embedding_failure_preserves_prior_current_index(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = uuid4()
    media_id = uuid4()
    old_fragment_id = uuid4()
    new_fragment_id = uuid4()
    old_text = "Old active evidence remains searchable during a failed replacement."
    new_text = "Replacement evidence should not become active when embeddings fail."

    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:media_id, 'web_article', 'Failed Replacement', 'ready_for_reading', :user_id)
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )

    rebuild_content_index(
        db_session,
        owner=IndexOwner("media", media_id),
        source_kind="web_article",
        blocks=[
            _web_block(
                media_id=media_id,
                text_value=old_text,
                locator=_web_locator(old_fragment_id, old_text),
            )
        ],
        reason="initial",
    )

    def fail_embeddings(_texts: list[str]) -> tuple[str, list[list[float]]]:
        raise RuntimeError("replacement embeddings unavailable")

    monkeypatch.setattr(
        "nexus.services.content_indexing.build_text_embeddings",
        fail_embeddings,
    )

    with pytest.raises(RuntimeError, match="replacement embeddings unavailable"):
        rebuild_content_index(
            db_session,
            owner=IndexOwner("media", media_id),
            source_kind="web_article",
            blocks=[
                _web_block(
                    media_id=media_id,
                    text_value=new_text,
                    locator=_web_locator(new_fragment_id, new_text),
                )
            ],
            reason="replacement",
        )

    state = db_session.execute(
        text(
            """
            SELECT
                mcis.status,
                mcis.status_reason,
                mcis.active_embedding_provider,
                mcis.active_embedding_model
            FROM content_index_states mcis
            WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert state[0] == "ready"
    assert state[1] == "initial"
    assert state[2] is not None
    assert state[3] is not None

    active_chunk_text = db_session.execute(
        text(
            """
            SELECT cc.chunk_text
            FROM content_chunks cc
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    assert active_chunk_text == old_text


def test_embedding_failure_does_not_commit_caller_owned_work(direct_db, monkeypatch):
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    text_value = "Caller-owned media insert must not leak on embedding failure."

    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)

    def fail_embeddings(_texts: list[str]) -> tuple[str, list[list[float]]]:
        raise RuntimeError("provider unavailable before durable writes")

    monkeypatch.setattr(
        "nexus.services.content_indexing.build_text_embeddings",
        fail_embeddings,
    )

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (
                    :media_id,
                    'web_article',
                    'Uncommitted Caller Work',
                    'ready_for_reading',
                    :user_id
                )
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )

        with pytest.raises(RuntimeError, match="provider unavailable before durable writes"):
            rebuild_content_index(
                session,
                owner=IndexOwner("media", media_id),
                source_kind="web_article",
                blocks=[
                    _web_block(
                        media_id=media_id,
                        text_value=text_value,
                        locator=_web_locator(fragment_id, text_value),
                    )
                ],
                reason="caller_transaction_test",
            )

        with direct_db.session() as verifier:
            visible_media = verifier.execute(
                text("SELECT COUNT(*) FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()

        assert int(visible_media) == 0, (
            "content-index embedding failure must not commit caller-owned media rows"
        )
        session.rollback()


def test_repair_ready_media_content_index_supports_ready_podcast_transcript(
    db_session: Session,
):
    user_id = uuid4()
    media_id = uuid4()

    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (
                :media_id,
                'podcast_episode',
                'Transcript Repair',
                'ready_for_reading',
                :user_id
            )
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                last_request_reason
            )
            VALUES (:media_id, 'ready', 'full', 'pending', 'search')
            """
        ),
        {"media_id": media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO podcast_transcript_segments (
                media_id,
                segment_idx,
                canonical_text,
                t_start_ms,
                t_end_ms,
                speaker_label
            )
            VALUES (
                :media_id,
                0,
                'Podcast transcript evidence repair.',
                0,
                1500,
                'Host'
            )
            """
        ),
        {"media_id": media_id},
    )

    result = repair_ready_media_content_index_now(
        db_session,
        media_id=media_id,
        reason="transcript_repair_test",
    )

    assert result is not None
    assert result.status == "ready"
    row = db_session.execute(
        text(
            """
            SELECT cc.source_kind, es.span_text
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert row[0] == "transcript"
    assert row[1] == "Podcast transcript evidence repair."


def test_pdf_repair_uses_current_evidence_contract(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    plain_text = "Repairable PDF text source."

    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, plain_text, page_count,
                created_by_user_id
            )
            VALUES (
                :media_id, 'pdf', 'Legacy PDF Repair', 'ready_for_reading', :plain_text, 1,
                :user_id
            )
            """
        ),
        {
            "media_id": media_id,
            "plain_text": plain_text,
            "user_id": user_id,
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO pdf_page_text_spans (
                media_id, page_number, start_offset, end_offset
            )
            VALUES (:media_id, 1, 0, :end_offset)
            """
        ),
        {"media_id": media_id, "end_offset": len(plain_text)},
    )

    result = repair_ready_media_content_index_now(
        db_session,
        media_id=media_id,
        reason="legacy_pdf_repair_test",
    )

    assert result is not None
    row = db_session.execute(
        text(
            """
            SELECT cb.block_kind, cb.metadata, es.span_text
            FROM content_blocks cb
            JOIN evidence_spans es ON es.start_block_id = cb.id
            WHERE cb.owner_kind = 'media' AND cb.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert row[0] == "pdf_text_block"
    assert row[1]["page_number"] == 1
    assert "text_extract_version" not in row[1]
    assert row[2] == plain_text


def _insert_ready_media(db_session: Session, *, user_id: UUID, media_id: UUID) -> None:
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:media_id, 'web_article', 'Offset Validation', 'ready_for_reading', :user_id)
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )


def _web_block(
    *,
    media_id: UUID,
    text_value: str,
    locator: dict[str, object],
    selector: dict[str, object] | None = None,
    block_idx: int = 0,
    source_start_offset: int = 0,
    source_end_offset: int | None = None,
    block_kind: str = "paragraph",
) -> IndexableBlock:
    return IndexableBlock(
        owner=IndexOwner("media", media_id),
        source_kind="web_article",
        block_idx=block_idx,
        block_kind=block_kind,
        canonical_text=text_value,
        extraction_confidence=None,
        source_start_offset=source_start_offset,
        source_end_offset=(
            source_end_offset
            if source_end_offset is not None
            else source_start_offset + len(text_value)
        ),
        locator=locator,
        selector=selector if selector is not None else locator,
        heading_path=(),
        metadata={},
    )


def _web_locator(
    fragment_id: UUID,
    text_value: str,
    *,
    start_offset: int = 0,
) -> dict[str, object]:
    return {
        "kind": "web_text",
        "fragment_id": str(fragment_id),
        "fragment_idx": 0,
        "start_offset": start_offset,
        "end_offset": start_offset + len(text_value),
        "text_quote": {"exact": text_value, "prefix": "", "suffix": ""},
    }
