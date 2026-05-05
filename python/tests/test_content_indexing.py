"""Integration tests for shared content index validation."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.content_indexing import (
    IndexableBlock,
    SourceSnapshotSpec,
    rebuild_media_content_index,
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
        "version": 1,
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
            rebuild_media_content_index(
                db_session,
                media_id=media_id,
                source_kind="web_article",
                source_snapshot=_snapshot(text_value),
                blocks=[build_block()],
                reason="validation_test",
            )

    counts = db_session.execute(
        text(
            """
            SELECT
                (SELECT COUNT(*) FROM content_index_runs WHERE media_id = :media_id),
                (SELECT COUNT(*) FROM content_blocks WHERE media_id = :media_id),
                (SELECT COUNT(*) FROM evidence_spans WHERE media_id = :media_id),
                (SELECT COUNT(*) FROM content_chunks WHERE media_id = :media_id)
            """
        ),
        {"media_id": media_id},
    ).one()
    assert counts == (0, 0, 0, 0)


def test_rebuild_rejects_out_of_order_source_offsets(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    first_text = "Second source block."
    second_text = "First source block."

    _insert_ready_media(db_session, user_id=user_id, media_id=media_id)

    with pytest.raises(ValueError, match="sorted and non-overlapping"):
        rebuild_media_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            source_snapshot=_snapshot(first_text + second_text),
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
        rebuild_media_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            source_snapshot=_snapshot(first_text + second_text),
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


def test_embedding_failure_preserves_prior_active_ready_index_without_failed_run(
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

    old_result = rebuild_media_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        source_snapshot=_snapshot(old_text),
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
        rebuild_media_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            source_snapshot=_snapshot(new_text),
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
                mcis.active_run_id,
                mcis.latest_run_id,
                mcis.active_embedding_provider,
                mcis.active_embedding_model,
                active_run.deactivated_at
            FROM media_content_index_states mcis
            JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
            WHERE mcis.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert state[0] == "ready"
    assert state[1] == "initial"
    assert state[2] == old_result.run_id
    assert state[3] == old_result.run_id
    assert state[4] is not None
    assert state[5] is not None
    assert state[6] is None

    run_count = db_session.execute(
        text("SELECT COUNT(*) FROM content_index_runs WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    assert int(run_count) == 1, (
        "embedding failures must not persist a replacement run from inside the "
        "caller-owned transaction"
    )

    active_chunk_text = db_session.execute(
        text(
            """
            SELECT cc.chunk_text
            FROM media_content_index_states mcis
            JOIN content_chunks cc ON cc.index_run_id = mcis.active_run_id
            WHERE mcis.media_id = :media_id
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
    direct_db.register_cleanup("content_index_runs", "media_id", media_id)
    direct_db.register_cleanup("media_content_index_states", "media_id", media_id)

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
            rebuild_media_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                source_snapshot=_snapshot(text_value),
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
            visible_runs = verifier.execute(
                text("SELECT COUNT(*) FROM content_index_runs WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()

        assert int(visible_media) == 0, (
            "content-index embedding failure must not commit caller-owned media rows"
        )
        assert int(visible_runs) == 0, "content-index embedding failure must not commit index rows"
        session.rollback()


def test_older_rebuild_does_not_replace_newer_active_evidence(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.services import content_indexing as content_indexing_service

    user_id = uuid4()
    media_id = uuid4()
    older_fragment_id = uuid4()
    newer_fragment_id = uuid4()
    older_text = "Older evidence should finish without becoming active."
    newer_text = "Newer evidence should remain the active chunk."

    _insert_ready_media(db_session, user_id=user_id, media_id=media_id)

    original_build_embeddings = content_indexing_service.build_text_embeddings
    triggered_newer_run = False

    def interleaved_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
        nonlocal triggered_newer_run
        if texts == [older_text] and not triggered_newer_run:
            triggered_newer_run = True
            newer_result = rebuild_media_content_index(
                db_session,
                media_id=media_id,
                source_kind="web_article",
                source_snapshot=_snapshot(newer_text),
                blocks=[
                    _web_block(
                        media_id=media_id,
                        text_value=newer_text,
                        locator=_web_locator(newer_fragment_id, newer_text),
                    )
                ],
                reason="newer_rebuild",
            )
            db_session.execute(
                text("UPDATE content_index_runs SET started_at = :started_at WHERE id = :run_id"),
                {
                    "run_id": newer_result.run_id,
                    "started_at": datetime.now(UTC) + timedelta(seconds=10),
                },
            )
        return original_build_embeddings(texts)

    monkeypatch.setattr(
        content_indexing_service,
        "build_text_embeddings",
        interleaved_embeddings,
    )

    older_result = rebuild_media_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        source_snapshot=_snapshot(older_text),
        blocks=[
            _web_block(
                media_id=media_id,
                text_value=older_text,
                locator=_web_locator(older_fragment_id, older_text),
            )
        ],
        reason="older_rebuild",
    )

    active_row = db_session.execute(
        text(
            """
            SELECT mcis.active_run_id, active_chunk.chunk_text, older_run.deactivated_at
            FROM media_content_index_states mcis
            JOIN content_chunks active_chunk ON active_chunk.index_run_id = mcis.active_run_id
            JOIN content_index_runs older_run ON older_run.id = :older_run_id
            WHERE mcis.media_id = :media_id
            """
        ),
        {"media_id": media_id, "older_run_id": older_result.run_id},
    ).one()
    assert active_row[1] == newer_text
    assert active_row[0] != older_result.run_id
    assert active_row[2] is not None


def test_repair_ready_media_content_index_supports_ready_podcast_transcript(
    db_session: Session,
):
    user_id = uuid4()
    media_id = uuid4()
    version_id = uuid4()

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
            INSERT INTO podcast_transcript_versions (
                id, media_id, version_no, transcript_coverage, is_active, created_by_user_id
            )
            VALUES (:version_id, :media_id, 1, 'full', true, :user_id)
            """
        ),
        {"version_id": version_id, "media_id": media_id, "user_id": user_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason
            )
            VALUES (:media_id, 'ready', 'full', 'pending', :version_id, 'search')
            """
        ),
        {"media_id": media_id, "version_id": version_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO podcast_transcript_segments (
                transcript_version_id,
                media_id,
                segment_idx,
                canonical_text,
                t_start_ms,
                t_end_ms,
                speaker_label
            )
            VALUES (
                :version_id,
                :media_id,
                0,
                'Podcast transcript evidence repair.',
                0,
                1500,
                'Host'
            )
            """
        ),
        {"version_id": version_id, "media_id": media_id},
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
            SELECT cc.source_kind, es.span_text, ss.metadata
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            JOIN source_snapshots ss ON ss.id = cc.source_snapshot_id
            WHERE cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert row[0] == "transcript"
    assert row[1] == "Podcast transcript evidence repair."
    assert row[2]["transcript_version_id"] == str(version_id)


def test_legacy_pdf_repair_marks_mutable_snapshot_source(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    plain_text = "Legacy mutable PDF repair source."
    file_sha256 = _sha256("pdf-bytes")

    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, plain_text, page_count, file_sha256,
                created_by_user_id
            )
            VALUES (
                :media_id, 'pdf', 'Legacy PDF Repair', 'ready_for_reading', :plain_text, 1,
                :file_sha256, :user_id
            )
            """
        ),
        {
            "media_id": media_id,
            "plain_text": plain_text,
            "file_sha256": file_sha256,
            "user_id": user_id,
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:media_id, 'media/test/legacy.pdf', 'application/pdf', 1024)
            """
        ),
        {"media_id": media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO pdf_page_text_spans (
                media_id, page_number, start_offset, end_offset, text_extract_version
            )
            VALUES (:media_id, 1, 0, :end_offset, 1)
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
    snapshot = db_session.execute(
        text(
            """
            SELECT artifact_ref, source_version, metadata
            FROM source_snapshots
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert snapshot[0] == f"legacy_media_plain_text:{media_id}"
    assert snapshot[1] == "pdf_text_legacy_mutable_repair_v1"
    assert snapshot[2]["legacy_mutable_snapshot_repair"] is True
    assert snapshot[2]["mutable_source_tables"] == [
        "media.plain_text",
        "pdf_page_text_spans",
    ]
    assert snapshot[2]["original_pdf_storage_path"] == "media/test/legacy.pdf"


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
        media_id=media_id,
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


def _snapshot(text_value: str) -> SourceSnapshotSpec:
    return SourceSnapshotSpec(
        artifact_kind="html",
        artifact_ref="test:malformed",
        content_type="text/html",
        byte_length=len(text_value.encode("utf-8")),
        source_fingerprint=f"sha256:{_sha256(text_value)}",
        content_sha256=_sha256(text_value),
        source_version="test_source_v1",
        extractor_version="test_extractor_v1",
        parent_snapshot_id=None,
        language=None,
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
        "version": 1,
        "fragment_id": str(fragment_id),
        "fragment_idx": 0,
        "start_offset": start_offset,
        "end_offset": start_offset + len(text_value),
        "text_quote": {"exact": text_value, "prefix": "", "suffix": ""},
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
