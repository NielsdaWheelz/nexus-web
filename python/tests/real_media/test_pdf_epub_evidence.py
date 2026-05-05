"""Strict real-media evidence acceptance for uploaded PDF and EPUB files."""

from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from sqlalchemy import text

from nexus.config import get_settings
from nexus.storage import get_storage_client
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]

FIXTURES_DIR = Path(__file__).parents[1] / "fixtures"


def test_real_pdf_upload_ingest_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
):
    _ensure_media_bucket()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)

    pdf_bytes = (FIXTURES_DIR / "pdf" / "attention.pdf").read_bytes()
    upload_response = auth_client.post(
        "/media/upload/init",
        json={
            "kind": "pdf",
            "filename": "attention.pdf",
            "content_type": "application/pdf",
            "size_bytes": len(pdf_bytes),
        },
        headers=headers,
    )
    assert upload_response.status_code == 200, upload_response.text
    upload = upload_response.json()["data"]
    storage_path = upload["storage_path"]
    media_id = UUID(upload["media_id"])
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("media", "id", media_id)

    storage = get_storage_client()
    try:
        storage.put_object(storage_path, pdf_bytes, "application/pdf")
        confirm_response = auth_client.post(f"/media/{media_id}/ingest", headers=headers)
        assert confirm_response.status_code == 200, confirm_response.text
        assert confirm_response.json()["data"]["duplicate"] is False

        from nexus.tasks.ingest_pdf import ingest_pdf

        result = ingest_pdf(str(media_id), request_id="real-media-pdf")
        assert result["status"] == "success"
        assert result["has_text"] is True

        _register_background_job_cleanup(direct_db, media_id)
        _assert_media_ready(auth_client, headers, media_id)
        _assert_complete_evidence_trace(direct_db, media_id, "pdf", "pdf")
        _assert_search_and_resolver(auth_client, headers, media_id, "attention", "pdf")
    finally:
        storage.delete_object(storage_path)


def test_real_epub_upload_ingest_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
):
    _ensure_media_bucket()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)

    epub_bytes = (FIXTURES_DIR / "epub" / "moby-dick-epub3.epub").read_bytes()
    upload_response = auth_client.post(
        "/media/upload/init",
        json={
            "kind": "epub",
            "filename": "moby-dick-epub3.epub",
            "content_type": "application/epub+zip",
            "size_bytes": len(epub_bytes),
        },
        headers=headers,
    )
    assert upload_response.status_code == 200, upload_response.text
    upload = upload_response.json()["data"]
    storage_path = upload["storage_path"]
    media_id = UUID(upload["media_id"])
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("media", "id", media_id)

    storage = get_storage_client()
    try:
        storage.put_object(storage_path, epub_bytes, "application/epub+zip")
        confirm_response = auth_client.post(f"/media/{media_id}/ingest", headers=headers)
        assert confirm_response.status_code == 200, confirm_response.text
        assert confirm_response.json()["data"]["duplicate"] is False

        from nexus.tasks.ingest_epub import ingest_epub

        result = ingest_epub(str(media_id), request_id="real-media-epub")
        assert result["status"] == "success"
        assert result["chapter_count"] > 0

        _register_background_job_cleanup(direct_db, media_id)
        _assert_media_ready(auth_client, headers, media_id)
        _assert_complete_evidence_trace(direct_db, media_id, "epub", "epub")
        _assert_search_and_resolver(auth_client, headers, media_id, "whale", "epub")
    finally:
        storage.delete_object(storage_path)


def _ensure_media_bucket() -> None:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_key:
        pytest.fail("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for real-media tests")
    if not settings.enable_openai:
        pytest.fail("ENABLE_OPENAI must be true for real-media embedding tests")
    if not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY must be set for real-media embedding tests")

    headers = {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
    }
    with httpx.Client(timeout=30.0) as client:
        bucket_response = client.get(
            f"{settings.supabase_url}/storage/v1/bucket/{settings.storage_bucket}",
            headers=headers,
        )
        if bucket_response.status_code == 200:
            return
        if bucket_response.status_code not in (400, 404):
            pytest.fail(
                "Unexpected Supabase storage bucket check response: "
                f"{bucket_response.status_code} {bucket_response.text}"
            )
        create_response = client.post(
            f"{settings.supabase_url}/storage/v1/bucket",
            headers=headers,
            json={"id": settings.storage_bucket, "name": settings.storage_bucket, "public": False},
        )
    if create_response.status_code not in (200, 201, 409):
        pytest.fail(
            "Failed to create Supabase storage bucket "
            f"{settings.storage_bucket!r}: {create_response.status_code} {create_response.text}"
        )


def _assert_media_ready(auth_client, headers: dict[str, str], media_id: UUID) -> None:
    response = auth_client.get(f"/media/{media_id}", headers=headers)
    assert response.status_code == 200, response.text
    media = response.json()["data"]
    assert media["processing_status"] == "ready_for_reading"
    assert media["retrieval_status"] == "ready"
    assert media["capabilities"]["can_read"] is True
    assert media["capabilities"]["can_search"] is True
    assert media["capabilities"]["can_quote"] is True


def _assert_complete_evidence_trace(
    direct_db: DirectSessionManager,
    media_id: UUID,
    source_kind: str,
    resolver_kind: str,
) -> None:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.status,
                        mcis.active_run_id,
                        cir.state,
                        cir.embedding_provider,
                        cir.embedding_model,
                        (
                            SELECT count(*)
                            FROM source_snapshots ss
                            WHERE ss.media_id = :media_id
                              AND ss.index_run_id = mcis.active_run_id
                        ) AS snapshot_count,
                        (
                            SELECT count(*)
                            FROM content_blocks cb
                            WHERE cb.media_id = :media_id
                              AND cb.index_run_id = mcis.active_run_id
                        ) AS block_count,
                        (
                            SELECT count(*)
                            FROM content_chunks cc
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                              AND cc.source_kind = :source_kind
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans es
                            WHERE es.media_id = :media_id
                              AND es.index_run_id = mcis.active_run_id
                              AND es.resolver_kind = :resolver_kind
                        ) AS evidence_count,
                        (
                            SELECT count(DISTINCT ce.chunk_id)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                        ) AS embedding_count
                    FROM media_content_index_states mcis
                    JOIN content_index_runs cir ON cir.id = mcis.active_run_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "source_kind": source_kind,
                    "resolver_kind": resolver_kind,
                },
            )
            .mappings()
            .one()
        )
        assert row["status"] == "ready"
        assert row["state"] == "ready"
        assert row["embedding_provider"] != "test"
        assert str(row["embedding_model"]).startswith("openai_")
        assert row["snapshot_count"] > 0
        assert row["block_count"] > 0
        assert row["chunk_count"] > 0
        assert row["evidence_count"] == row["chunk_count"]
        assert row["embedding_count"] == row["chunk_count"]

        chunks = (
            session.execute(
                text(
                    """
                    SELECT
                        cc.id,
                        cc.chunk_text,
                        string_agg(
                            ccp.separator_before ||
                            substr(
                                cb.canonical_text,
                                ccp.block_start_offset + 1,
                                ccp.block_end_offset - ccp.block_start_offset
                            ),
                            ''
                            ORDER BY ccp.part_idx
                        ) AS reconstructed
                    FROM content_chunks cc
                    JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                    JOIN content_blocks cb ON cb.id = ccp.block_id
                    WHERE cc.media_id = :media_id
                      AND cc.index_run_id = :active_run_id
                    GROUP BY cc.id, cc.chunk_text
                    ORDER BY cc.chunk_idx
                    """
                ),
                {"media_id": media_id, "active_run_id": row["active_run_id"]},
            )
            .mappings()
            .all()
        )
        assert chunks
        for chunk in chunks:
            assert chunk["reconstructed"] == chunk["chunk_text"], (
                f"chunk parts did not reconstruct chunk {chunk['id']}"
            )


def _assert_search_and_resolver(
    auth_client,
    headers: dict[str, str],
    media_id: UUID,
    query: str,
    resolver_kind: str,
) -> None:
    search_response = auth_client.get(
        "/search",
        params={
            "q": query,
            "scope": f"media:{media_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=headers,
    )
    assert search_response.status_code == 200, search_response.text
    matches = [
        result
        for result in search_response.json()["results"]
        if result["type"] == "content_chunk" and result["source"]["media_id"] == str(media_id)
    ]
    assert matches, f"search did not return indexed content_chunk for {media_id}"

    result = matches[0]
    assert result["context_ref"]["type"] == "content_chunk"
    assert result["context_ref"]["evidence_span_ids"]
    assert result["evidence_span_ids"] == result["context_ref"]["evidence_span_ids"]
    assert result["resolver"]["kind"] == resolver_kind
    assert result["deep_link"].startswith(f"/media/{media_id}?")

    evidence_span_id = result["evidence_span_ids"][0]
    resolver_response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=headers,
    )
    assert resolver_response.status_code == 200, resolver_response.text
    resolved = resolver_response.json()["data"]
    assert resolved["media_id"] == str(media_id)
    assert resolved["resolver"]["kind"] == resolver_kind
    assert resolved["resolver"]["status"] in {"resolved", "no_geometry"}
    assert query.casefold() in resolved["span_text"].casefold()

    legacy_response = auth_client.get(
        "/search",
        params={"q": query, "types": "fragment,transcript_chunk"},
        headers=headers,
    )
    assert legacy_response.status_code == 400
    assert legacy_response.json()["error"]["code"] == "E_INVALID_REQUEST"


def _register_background_job_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    with direct_db.session() as session:
        job_ids = (
            session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(media_id)},
            )
            .scalars()
            .all()
        )
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)
