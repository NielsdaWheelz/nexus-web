"""Integration tests for durable evidence locator resolution."""

from __future__ import annotations

import hashlib
import json
from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Fragment
from nexus.services.content_indexing import (
    IndexableBlock,
    SourceSnapshotSpec,
    rebuild_fragment_content_index,
    rebuild_media_content_index,
    rebuild_transcript_content_index,
)
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from tests.factories import get_user_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_web_evidence_uses_snapshot_after_fragment_mutation(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    fragment_id = uuid4()

    with direct_db.session() as session:
        default_library_id = get_user_default_library(session, user_id)
        assert default_library_id is not None
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:media_id, 'web_article', 'Stale Locator Article', 'ready_for_reading', :user_id)
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text("INSERT INTO library_entries (library_id, media_id) VALUES (:lid, :mid)"),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO default_library_intrinsics (default_library_id, media_id)
                VALUES (:lid, :mid)
                """
            ),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                VALUES (:fragment_id, :media_id, 0, :text_value, '<p>Durable quote needle</p>')
                """
            ),
            {
                "fragment_id": fragment_id,
                "media_id": media_id,
                "text_value": "Durable quote needle for stale locator coverage.",
            },
        )
        fragment = session.get(Fragment, fragment_id)
        assert fragment is not None
        insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
        rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment.id}",
            fragments=[fragment],
            reason="test",
        )
        evidence_span_id = session.execute(
            text(
                """
                SELECT primary_evidence_span_id
                FROM content_chunks
                WHERE media_id = :media_id
                ORDER BY chunk_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        session.execute(
            text(
                """
                UPDATE fragments
                SET canonical_text = 'Different text now occupies the old offsets.'
                WHERE id = :fragment_id
                """
            ),
            {"fragment_id": fragment_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    resolver = response.json()["data"]["resolver"]
    assert resolver["status"] == "resolved", resolver
    assert resolver["highlight"]["kind"] == "web_text"
    assert resolver["highlight"]["text_quote"]["exact"] == (
        "Durable quote needle for stale locator coverage."
    )


def test_evidence_resolution_requires_primary_chunk_span_coherence(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    fragment_id = uuid4()
    text_value = "Coherent chunk evidence must not be replaceable by a sibling span."

    with direct_db.session() as session:
        default_library_id = get_user_default_library(session, user_id)
        assert default_library_id is not None
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:media_id, 'web_article', 'Coherence Guard Article', 'ready_for_reading', :user_id)
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text("INSERT INTO library_entries (library_id, media_id) VALUES (:lid, :mid)"),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO default_library_intrinsics (default_library_id, media_id)
                VALUES (:lid, :mid)
                """
            ),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                VALUES (:fragment_id, :media_id, 0, :text_value, '<p>Coherence guard</p>')
                """
            ),
            {"fragment_id": fragment_id, "media_id": media_id, "text_value": text_value},
        )
        fragment = session.get(Fragment, fragment_id)
        assert fragment is not None
        insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
        rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment.id}",
            fragments=[fragment],
            reason="test",
        )
        row = session.execute(
            text(
                """
                SELECT
                    cc.id,
                    cc.index_run_id,
                    cc.source_snapshot_id,
                    cc.primary_evidence_span_id,
                    cc.summary_locator,
                    ccp.block_id,
                    ccp.block_start_offset,
                    ccp.block_end_offset
                FROM content_chunks cc
                JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                WHERE cc.media_id = :media_id
                ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        mismatch_text = "Sibling span from the same run."
        mismatch_span_id = session.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    span_sha256,
                    selector,
                    citation_label,
                    resolver_kind
                )
                VALUES (
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :block_id,
                    :block_id,
                    :start_offset,
                    :end_offset,
                    :span_text,
                    :span_sha,
                    CAST(:selector AS jsonb),
                    'Sibling',
                    'web'
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "index_run_id": row[1],
                "source_snapshot_id": row[2],
                "block_id": row[5],
                "start_offset": row[6],
                "end_offset": row[7],
                "span_text": mismatch_text,
                "span_sha": _sha256(mismatch_text),
                "selector": json.dumps(row[4]),
            },
        ).scalar_one()
        session.execute(
            text(
                """
                UPDATE content_chunks
                SET primary_evidence_span_id = :mismatch_span_id
                WHERE id = :chunk_id
                """
            ),
            {"chunk_id": row[0], "mismatch_span_id": mismatch_span_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/evidence/{mismatch_span_id}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    resolver = response.json()["data"]["resolver"]
    assert resolver["status"] == "unresolved", resolver
    assert resolver["highlight"] is None


def test_web_evidence_resolves_sub_chunk_span_not_primary_chunk_span(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    fragment_id = uuid4()
    text_value = "Alpha exact citation evidence lives inside a larger chunk."
    exact = "exact citation evidence"
    start_offset = text_value.index(exact)
    end_offset = start_offset + len(exact)

    with direct_db.session() as session:
        default_library_id = get_user_default_library(session, user_id)
        assert default_library_id is not None
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:media_id, 'web_article', 'Sub Chunk Span Article', 'ready_for_reading', :user_id)
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text("INSERT INTO library_entries (library_id, media_id) VALUES (:lid, :mid)"),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO default_library_intrinsics (default_library_id, media_id)
                VALUES (:lid, :mid)
                """
            ),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                VALUES (:fragment_id, :media_id, 0, :text_value, '<p>Sub chunk span</p>')
                """
            ),
            {"fragment_id": fragment_id, "media_id": media_id, "text_value": text_value},
        )
        fragment = session.get(Fragment, fragment_id)
        assert fragment is not None
        insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
        rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment.id}",
            fragments=[fragment],
            reason="test",
        )
        row = (
            session.execute(
                text(
                    """
                SELECT
                    cc.primary_evidence_span_id,
                    cc.index_run_id,
                    cc.source_snapshot_id,
                    cb.id AS block_id,
                    cb.locator
                FROM content_chunks cc
                JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                JOIN content_blocks cb ON cb.id = ccp.block_id
                WHERE cc.media_id = :media_id
                ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                LIMIT 1
                """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        selector = dict(row["locator"])
        selector["start_offset"] = start_offset
        selector["end_offset"] = end_offset
        selector["text_quote"] = _text_quote(text_value, start_offset, end_offset)
        evidence_span_id = session.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    span_sha256,
                    selector,
                    citation_label,
                    resolver_kind
                )
                VALUES (
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :block_id,
                    :block_id,
                    :start_offset,
                    :end_offset,
                    :span_text,
                    :span_sha,
                    CAST(:selector AS jsonb),
                    'Exact',
                    'web'
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "index_run_id": row["index_run_id"],
                "source_snapshot_id": row["source_snapshot_id"],
                "block_id": row["block_id"],
                "start_offset": start_offset,
                "end_offset": end_offset,
                "span_text": exact,
                "span_sha": _sha256(exact),
                "selector": json.dumps(selector),
            },
        ).scalar_one()
        assert evidence_span_id != row["primary_evidence_span_id"]
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    resolver = data["resolver"]
    assert data["span_text"] == exact
    assert resolver["status"] == "resolved", resolver
    assert resolver["highlight"]["kind"] == "web_text"
    assert resolver["highlight"]["text_quote"]["exact"] == exact
    assert resolver["highlight"]["start_offset"] == start_offset
    assert resolver["highlight"]["end_offset"] == end_offset


def test_pdf_evidence_uses_snapshot_after_plain_text_mutation(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    plain_text = "PDF durable quote needle for stale selector coverage."
    file_sha256 = hashlib.sha256(b"pdf-bytes-v1").hexdigest()
    source_fingerprint = f"sha256:{file_sha256}"

    with direct_db.session() as session:
        default_library_id = get_user_default_library(session, user_id)
        assert default_library_id is not None
        session.execute(
            text(
                """
                INSERT INTO media (
                    id, kind, title, processing_status, created_by_user_id,
                    plain_text, page_count, file_sha256
                )
                VALUES (
                    :media_id, 'pdf', 'Stale Locator PDF', 'ready_for_reading', :user_id,
                    :plain_text, 1, :file_sha256
                )
                """
            ),
            {
                "media_id": media_id,
                "user_id": user_id,
                "plain_text": plain_text,
                "file_sha256": file_sha256,
            },
        )
        session.execute(
            text("INSERT INTO library_entries (library_id, media_id) VALUES (:lid, :mid)"),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO default_library_intrinsics (default_library_id, media_id)
                VALUES (:lid, :mid)
                """
            ),
            {"lid": default_library_id, "mid": media_id},
        )
        selector = {
            "kind": "pdf_text",
            "version": 1,
            "source_fingerprint": source_fingerprint,
            "page_number": 1,
            "physical_page_number": 1,
            "page_label": "1",
            "plain_text_start_offset": 0,
            "plain_text_end_offset": len(plain_text),
            "page_text_start_offset": 0,
            "page_text_end_offset": len(plain_text),
            "text_quote": _text_quote(plain_text, 0, len(plain_text)),
            "geometry": {
                "version": 1,
                "coordinate_space": "pdf_points",
                "page_width": 612,
                "page_height": 792,
                "page_rotation_degrees": 0,
                "page_box": "crop",
                "quads": [
                    {
                        "x1": 10,
                        "y1": 10,
                        "x2": 200,
                        "y2": 10,
                        "x3": 200,
                        "y3": 24,
                        "x4": 10,
                        "y4": 24,
                    }
                ],
            },
        }
        rebuild_media_content_index(
            session,
            media_id=media_id,
            source_kind="pdf",
            source_snapshot=SourceSnapshotSpec(
                artifact_kind="pdf_text",
                artifact_ref=f"media:{media_id}:pdf_text",
                content_type="text/plain",
                byte_length=len(plain_text.encode("utf-8")),
                source_fingerprint=source_fingerprint,
                content_sha256=_sha256(plain_text),
                source_version="test_pdf_v1",
                extractor_version="test_pdf_extractor_v1",
                parent_snapshot_id=None,
                language=None,
                metadata={"source_fingerprint": source_fingerprint},
            ),
            blocks=[
                IndexableBlock(
                    media_id=media_id,
                    source_kind="pdf",
                    block_idx=0,
                    block_kind="pdf_text_block",
                    canonical_text=plain_text,
                    extraction_confidence=None,
                    source_start_offset=0,
                    source_end_offset=len(plain_text),
                    locator=selector,
                    selector={**selector, "kind": "pdf_text_quote"},
                    heading_path=("p. 1",),
                    metadata={},
                )
            ],
            reason="test",
        )
        evidence_span_id = session.execute(
            text(
                """
                SELECT primary_evidence_span_id
                FROM content_chunks
                WHERE media_id = :media_id
                ORDER BY chunk_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        session.execute(
            text(
                """
                UPDATE media
                SET plain_text = 'Changed PDF text now occupies this media row.'
                WHERE id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    resolver = response.json()["data"]["resolver"]
    assert resolver["status"] == "resolved", resolver
    assert resolver["highlight"]["kind"] == "pdf_text"
    assert resolver["highlight"]["text_quote"]["exact"] == plain_text


def test_transcript_evidence_uses_snapshot_after_active_version_changes(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    first_version_id = uuid4()
    second_version_id = uuid4()
    first_segments = [
        {
            "text": "Alpha transcript locator evidence.",
            "t_start_ms": 1000,
            "t_end_ms": 2500,
            "speaker_label": "Host",
        }
    ]

    with direct_db.session() as session:
        default_library_id = get_user_default_library(session, user_id)
        assert default_library_id is not None
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (
                    :media_id,
                    'podcast_episode',
                    'Stale Transcript Locator',
                    'ready_for_reading',
                    :user_id
                )
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text("INSERT INTO library_entries (library_id, media_id) VALUES (:lid, :mid)"),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO default_library_intrinsics (default_library_id, media_id)
                VALUES (:lid, :mid)
                """
            ),
            {"lid": default_library_id, "mid": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_transcript_versions (
                    id, media_id, version_no, transcript_coverage, is_active,
                    created_by_user_id
                )
                VALUES (:id, :media_id, 1, 'full', true, :user_id)
                """
            ),
            {"id": first_version_id, "media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    transcript_version_id, media_id, segment_idx, canonical_text,
                    t_start_ms, t_end_ms, speaker_label
                )
                VALUES (
                    :version_id, :media_id, 0, :canonical_text, 1000, 2500, 'Host'
                )
                """
            ),
            {
                "version_id": first_version_id,
                "media_id": media_id,
                "canonical_text": first_segments[0]["text"],
            },
        )
        session.execute(
            text(
                """
                INSERT INTO media_transcript_states (
                    media_id, transcript_state, transcript_coverage, semantic_status,
                    active_transcript_version_id, last_request_reason
                )
                VALUES (:media_id, 'ready', 'full', 'ready', :version_id, 'search')
                """
            ),
            {"media_id": media_id, "version_id": first_version_id},
        )
        rebuild_transcript_content_index(
            session,
            media_id=media_id,
            transcript_version_id=first_version_id,
            transcript_segments=first_segments,
            reason="test",
        )
        evidence_span_id = session.execute(
            text(
                """
                SELECT primary_evidence_span_id
                FROM content_chunks
                WHERE media_id = :media_id
                ORDER BY chunk_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        session.execute(
            text(
                """
                UPDATE podcast_transcript_versions
                SET is_active = false
                WHERE id = :version_id
                """
            ),
            {"version_id": first_version_id},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_transcript_versions (
                    id, media_id, version_no, transcript_coverage, is_active,
                    created_by_user_id
                )
                VALUES (:id, :media_id, 2, 'full', true, :user_id)
                """
            ),
            {"id": second_version_id, "media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    transcript_version_id, media_id, segment_idx, canonical_text,
                    t_start_ms, t_end_ms, speaker_label
                )
                VALUES (
                    :version_id, :media_id, 0, 'Beta replacement transcript.', 1000, 2500, 'Host'
                )
                """
            ),
            {"version_id": second_version_id, "media_id": media_id},
        )
        session.execute(
            text(
                """
                UPDATE media_transcript_states
                SET active_transcript_version_id = :version_id,
                    updated_at = now()
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id, "version_id": second_version_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_versions", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
    direct_db.register_cleanup("media_transcript_states", "media_id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    resolver = response.json()["data"]["resolver"]
    assert resolver["status"] == "resolved", resolver
    assert resolver["highlight"]["kind"] == "transcript_time_text"
    assert resolver["highlight"]["text_quote"]["exact"] == first_segments[0]["text"]


def _text_quote(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - 64) : start_offset],
        "suffix": text_value[end_offset : end_offset + 64],
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
