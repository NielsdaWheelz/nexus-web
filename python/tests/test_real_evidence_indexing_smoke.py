"""Real-stack evidence indexing smoke tests.

Exercises readable media, shared evidence artifacts, search, and evidence
resolution for web, EPUB, PDF, and transcript sources.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Iterable
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from nexus.services.content_indexing import (
    deactivate_media_content_index,
    rebuild_fragment_content_index,
)
from nexus.services.media import create_captured_web_article
from nexus.services.upload import _ensure_in_default_library
from nexus.storage.client import FakeStorageClient
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = [pytest.mark.integration, pytest.mark.slow]

FIXTURES_DIR = Path(__file__).parent / "fixtures"
EVAL_FIXTURE = FIXTURES_DIR / "evidence_indexing_smoke_eval.json"


@pytest.fixture(scope="module")
def evidence_eval() -> dict[str, dict[str, str]]:
    return json.loads(EVAL_FIXTURE.read_text())


def test_real_content_sources_are_readable_searchable_and_resolve_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
    evidence_eval: dict[str, dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    media_ids = {
        "web": _create_web_article(direct_db, user_id, evidence_eval["web"]),
        "epub": _ingest_epub(direct_db, engine, user_id, evidence_eval["epub"]),
        "pdf": _ingest_pdf(direct_db, engine, user_id, evidence_eval["pdf"]),
        "transcript": _ingest_youtube_transcript(
            auth_client,
            direct_db,
            user_id,
            evidence_eval["transcript"],
            monkeypatch,
        ),
        "podcast": _ingest_podcast_transcript(
            direct_db,
            user_id,
            evidence_eval["podcast"],
            monkeypatch,
        ),
    }

    _register_background_job_cleanup(direct_db, media_ids.values())

    for source_name, media_id in media_ids.items():
        expected = evidence_eval[source_name]
        _assert_ready_detail(auth_client, user_id, media_id, source_name)
        _assert_content_index_artifacts(
            direct_db,
            media_id,
            expected_source_kind=expected["expected_source_kind"],
            source_name=source_name,
        )
        evidence_span_id = _assert_search_finds_indexed_chunk(
            auth_client,
            user_id,
            media_id,
            query=expected["query"],
            source_name=source_name,
        )
        _assert_evidence_resolves(
            auth_client,
            user_id,
            media_id,
            evidence_span_id,
            expected_resolver_kind=expected["expected_resolver_kind"],
            source_name=source_name,
        )


def test_failed_replacement_preserves_prior_active_index_searchability(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = _create_web_article(
        direct_db,
        user_id,
        {"title": "Failed Index Visibility", "needle": "old failure readiness needle"},
    )

    def fail_embeddings(_texts):
        raise RuntimeError("embedding provider refused the fixture")

    monkeypatch.setattr("nexus.services.content_indexing.build_text_embeddings", fail_embeddings)
    with direct_db.session() as session:
        ready_row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.active_run_id,
                        cir.source_version,
                        cir.extractor_version,
                        cir.chunker_version,
                        cir.embedding_provider,
                        cir.embedding_model,
                        cir.embedding_version,
                        cir.embedding_config_hash
                    FROM media_content_index_states mcis
                    JOIN content_index_runs cir ON cir.id = mcis.active_run_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        old_active_run_id = ready_row["active_run_id"]
        replacement_text = "new replacement search needle after failed indexing"
        fragment_row = session.execute(
            text(
                """
                SELECT id, idx
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        session.execute(
            text(
                """
                UPDATE fragments
                SET canonical_text = :replacement_text,
                    html_sanitized = :replacement_html
                WHERE id = :fragment_id
                """
            ),
            {
                "fragment_id": fragment_row[0],
                "replacement_text": replacement_text,
                "replacement_html": f"<p>{replacement_text}</p>",
            },
        )
        session.execute(
            text("DELETE FROM fragment_blocks WHERE fragment_id = :fragment_id"),
            {"fragment_id": fragment_row[0]},
        )
        session.execute(
            text(
                """
                INSERT INTO fragment_blocks (fragment_id, block_idx, start_offset, end_offset)
                VALUES (:fragment_id, 0, 0, :replacement_len)
                """
            ),
            {"fragment_id": fragment_row[0], "replacement_len": len(replacement_text)},
        )
        replacement_fragment = session.execute(
            text(
                """
                SELECT id, idx, canonical_text
                FROM fragments
                WHERE id = :fragment_id
                """
            ),
            {"fragment_id": fragment_row[0]},
        ).one()
        with pytest.raises(RuntimeError, match="embedding provider refused"):
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                artifact_ref=f"fragments:{fragment_row[0]}",
                fragments=[replacement_fragment],
                reason="replacement_test",
            )
        session.commit()

    with direct_db.session() as session:
        state_row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.status,
                        mcis.active_run_id,
                        mcis.latest_run_id,
                        latest_run.state AS latest_run_state,
                        old_run.deactivated_at AS old_deactivated_at
                    FROM media_content_index_states mcis
                    JOIN content_index_runs latest_run ON latest_run.id = mcis.latest_run_id
                    JOIN content_index_runs old_run ON old_run.id = :old_active_run_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {"media_id": media_id, "old_active_run_id": old_active_run_id},
            )
            .mappings()
            .one()
        )
    assert state_row["status"] == "ready"
    assert state_row["active_run_id"] == old_active_run_id
    assert state_row["latest_run_id"] is not None
    assert state_row["latest_run_state"] == "failed"
    assert state_row["old_deactivated_at"] is None

    response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
    assert response.status_code == 200
    media = response.json()["data"]
    assert media["retrieval_status"] == "ready"
    assert (
        media["retrieval_status_reason"]
        == "Content embedding failed: embedding provider refused the fixture"
    )
    assert media["capabilities"]["can_read"] is True
    assert media["capabilities"]["can_quote"] is True
    assert media["capabilities"]["can_search"] is True

    search_response = auth_client.get(
        "/search?q=old+failure+readiness+needle&types=content_chunk",
        headers=auth_headers(user_id),
    )
    assert search_response.status_code == 200
    matching_rows = [
        row
        for row in search_response.json()["results"]
        if row["type"] == "content_chunk" and row["source"]["media_id"] == str(media_id)
    ]
    assert matching_rows, "the prior active index remains searchable until replacement passes"


def test_embedding_failure_before_artifact_inserts_records_latest_failed_run(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.services.content_indexing import rebuild_fragment_content_index

    user_id = create_test_user_id()
    media_id = uuid4()
    fragment_id = uuid4()

    observed_indexing_state: dict[str, object] = {}

    def fail_embeddings(_texts):
        with direct_db.session() as check_session:
            row = (
                check_session.execute(
                    text(
                        """
                        SELECT mcis.status,
                               mcis.active_run_id,
                               mcis.latest_run_id,
                               cir.state
                        FROM media_content_index_states mcis
                        JOIN content_index_runs cir ON cir.id = mcis.latest_run_id
                        WHERE mcis.media_id = :media_id
                        """
                    ),
                    {"media_id": media_id},
                )
                .mappings()
                .one()
            )
        observed_indexing_state.update(row)
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr("nexus.services.content_indexing.build_text_embeddings", fail_embeddings)
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'web_article', 'Embedding Failure', 'ready_for_reading', :user_id)
                """
            ),
            {"id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:id, :media_id, 0, '<p>failure text</p>', 'failure text')
                """
            ),
            {"id": fragment_id, "media_id": media_id},
        )
        fragment = session.execute(
            text("SELECT id, idx, canonical_text FROM fragments WHERE id = :id"),
            {"id": fragment_id},
        ).one()
        with pytest.raises(RuntimeError):
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                artifact_ref=f"fragments:{fragment_id}",
                fragments=[fragment],
                reason="test_embedding_failure",
            )
        session.commit()

    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT mcis.status,
                           mcis.active_run_id,
                           mcis.latest_run_id,
                           cir.state,
                           cir.failure_code,
                           cir.failure_message
                    FROM media_content_index_states mcis
                    JOIN content_index_runs cir ON cir.id = mcis.latest_run_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )

    assert row["status"] == "failed"
    assert row["active_run_id"] is None
    assert row["latest_run_id"] is not None
    assert row["state"] == "failed"
    assert row["failure_code"] == "E_INGEST_FAILED"
    assert "provider unavailable" in row["failure_message"]
    assert observed_indexing_state["status"] == "indexing"
    assert observed_indexing_state["active_run_id"] is None
    assert observed_indexing_state["latest_run_id"] == row["latest_run_id"]
    assert observed_indexing_state["state"] == "indexing"

    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def test_captured_web_article_survives_content_index_failure(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = create_test_user_id()

    def fail_embeddings(_texts):
        raise RuntimeError("capture embedding provider unavailable")

    monkeypatch.setattr("nexus.services.content_indexing.build_text_embeddings", fail_embeddings)
    with direct_db.session() as session:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(session, user_id)
        result = create_captured_web_article(
            session,
            viewer_id=user_id,
            url=f"https://example.com/captured/{uuid4()}",
            content_html="<article><p>captured failure evidence text</p></article>",
            title="Captured Failure",
            byline=None,
            excerpt=None,
            site_name=None,
        )
        media_id = result.media_id

    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT m.processing_status,
                           m.failure_stage,
                           m.last_error_code,
                           mcis.status,
                           cir.state,
                           count(f.id) AS fragment_count
                    FROM media m
                    JOIN media_content_index_states mcis ON mcis.media_id = m.id
                    JOIN content_index_runs cir ON cir.id = mcis.latest_run_id
                    LEFT JOIN fragments f ON f.media_id = m.id
                    WHERE m.id = :media_id
                    GROUP BY m.id, mcis.status, cir.state
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )

    assert row["processing_status"] == "ready_for_reading"
    assert row["failure_stage"] == "embed"
    assert row["last_error_code"] == "E_INGEST_FAILED"
    assert row["status"] == "failed"
    assert row["state"] == "failed"
    assert row["fragment_count"] == 1

    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def test_deactivating_content_index_clears_active_embedding_metadata(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = _create_web_article(
        direct_db,
        user_id,
        {"title": "Deactivated Index Metadata", "needle": "deactivation metadata needle"},
    )

    with direct_db.session() as session:
        ready_row = (
            session.execute(
                text(
                    """
                    SELECT
                        active_run_id,
                        active_embedding_provider,
                        active_embedding_model,
                        active_embedding_version,
                        active_embedding_config_hash
                    FROM media_content_index_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        assert ready_row["active_run_id"] is not None
        assert ready_row["active_embedding_provider"] is not None
        assert ready_row["active_embedding_model"] is not None
        assert ready_row["active_embedding_version"] is not None
        assert ready_row["active_embedding_config_hash"] is not None

        deactivate_media_content_index(session, media_id=media_id, reason="test_deactivate")
        session.commit()

    with direct_db.session() as session:
        deactivated_row = (
            session.execute(
                text(
                    """
                    SELECT
                        status,
                        active_run_id,
                        active_embedding_provider,
                        active_embedding_model,
                        active_embedding_version,
                        active_embedding_config_hash
                    FROM media_content_index_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )

    assert deactivated_row["status"] == "pending"
    assert deactivated_row["active_run_id"] is None
    assert deactivated_row["active_embedding_provider"] is None
    assert deactivated_row["active_embedding_model"] is None
    assert deactivated_row["active_embedding_version"] is None
    assert deactivated_row["active_embedding_config_hash"] is None


def _create_web_article(
    direct_db: DirectSessionManager,
    user_id: UUID,
    fixture: dict[str, str],
) -> UUID:
    html = f"""
    <article>
      <h1>{fixture["title"]}</h1>
      <p>The {fixture["needle"]} smoke article exercises shared web evidence.</p>
      <p>It gives search and resolver tests a deterministic source paragraph.</p>
    </article>
    """
    with direct_db.session() as session:
        result = create_captured_web_article(
            session,
            viewer_id=user_id,
            url=f"https://example.com/smoke/{uuid4()}",
            content_html=html,
            title=fixture["title"],
            byline="Nexus Tests",
            excerpt="Smoke evidence web article.",
            site_name="Nexus Smoke",
        )
        media_id = result.media_id

    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _ingest_epub(
    direct_db: DirectSessionManager,
    engine: Engine,
    user_id: UUID,
    fixture: dict[str, str],
) -> UUID:
    epub_bytes = (FIXTURES_DIR / "epub" / fixture["fixture"]).read_bytes()
    storage = FakeStorageClient()
    media_id = uuid4()
    storage_path = f"media/{media_id}/original.epub"

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'epub', :title, 'extracting', :user_id)
                """
            ),
            {"id": media_id, "title": fixture["fixture"], "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                VALUES (:media_id, :storage_path, 'application/epub+zip', :size_bytes)
                """
            ),
            {
                "media_id": media_id,
                "storage_path": storage_path,
                "size_bytes": len(epub_bytes),
            },
        )
        session.commit()

    storage.put_object(storage_path, epub_bytes, "application/epub+zip")
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with (
        patch("nexus.tasks.ingest_epub.get_session_factory", return_value=SessionLocal),
        patch("nexus.tasks.ingest_epub.get_storage_client", return_value=storage),
    ):
        from nexus.tasks.ingest_epub import ingest_epub

        result = ingest_epub(str(media_id))

    assert result["status"] == "success", f"epub: ingest failed with {result}"

    with direct_db.session() as session:
        _ensure_in_default_library(session, user_id, media_id)
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("epub_resources", "media_id", media_id)
    direct_db.register_cleanup("epub_fragment_sources", "media_id", media_id)
    return media_id


def _ingest_pdf(
    direct_db: DirectSessionManager,
    engine: Engine,
    user_id: UUID,
    fixture: dict[str, str],
) -> UUID:
    pdf_bytes = (FIXTURES_DIR / "pdf" / fixture["fixture"]).read_bytes()
    storage = FakeStorageClient()
    media_id = uuid4()
    storage_path = f"media/{media_id}/original.pdf"

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'pdf', :title, 'extracting', :user_id)
                """
            ),
            {"id": media_id, "title": fixture["fixture"], "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                VALUES (:media_id, :storage_path, 'application/pdf', :size_bytes)
                """
            ),
            {
                "media_id": media_id,
                "storage_path": storage_path,
                "size_bytes": len(pdf_bytes),
            },
        )
        session.commit()

    storage.put_object(storage_path, pdf_bytes, "application/pdf")
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with (
        patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=SessionLocal),
        patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
    ):
        from nexus.tasks.ingest_pdf import ingest_pdf

        result = ingest_pdf(str(media_id))

    assert result["status"] == "success", f"pdf: ingest failed with {result}"

    with direct_db.session() as session:
        _ensure_in_default_library(session, user_id, media_id)
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _ingest_youtube_transcript(
    auth_client,
    direct_db: DirectSessionManager,
    user_id: UUID,
    fixture: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> UUID:
    segments = [
        {
            "t_start_ms": 0,
            "t_end_ms": 1300,
            "text": f"The {fixture['needle']} source segment opens the smoke transcript.",
            "speaker_label": "Host",
        },
        {
            "t_start_ms": 1300,
            "t_end_ms": 2600,
            "text": "A second segment keeps timestamp ordering visible.",
            "speaker_label": "Guest",
        },
    ]

    response = auth_client.post(
        "/media/from_url",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
        headers=auth_headers(user_id),
    )
    assert response.status_code == 202, (
        f"transcript: expected media creation, got {response.status_code}: {response.text}"
    )
    media_id = UUID(response.json()["data"]["media_id"])

    youtube_ingest = importlib.import_module("nexus.tasks.ingest_youtube_video")

    monkeypatch.setattr(
        youtube_ingest,
        "_fetch_youtube_metadata",
        lambda _provider_id: {
            "title": "Smoke Evidence Transcript",
            "description": "Transcript smoke fixture.",
            "author": "Nexus Channel",
            "published_date": "2026-04-01T12:00:00Z",
            "language": "en-US",
        },
    )
    monkeypatch.setattr(
        youtube_ingest,
        "_fetch_youtube_transcript",
        lambda _provider_id: {"status": "completed", "segments": segments},
    )

    with direct_db.session() as session:
        result = youtube_ingest.run_ingest_sync(session, media_id, user_id)
        assert result["status"] == "success", f"transcript: ingest failed with {result}"
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _ingest_podcast_transcript(
    direct_db: DirectSessionManager,
    user_id: UUID,
    fixture: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> UUID:
    segments = [
        {
            "t_start_ms": 0,
            "t_end_ms": 1500,
            "text": f"The {fixture['needle']} source segment opens the smoke podcast.",
            "speaker_label": "Host",
        },
        {
            "t_start_ms": 1500,
            "t_end_ms": 3000,
            "text": "A second podcast segment keeps retrieval scoped to transcript chunks.",
            "speaker_label": "Guest",
        },
    ]
    media_id = uuid4()

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (
                    id,
                    kind,
                    title,
                    processing_status,
                    external_playback_url,
                    canonical_source_url,
                    created_by_user_id
                )
                VALUES (
                    :id,
                    'podcast_episode',
                    'Smoke Evidence Podcast',
                    'pending',
                    'https://example.com/smoke-podcast.mp3',
                    'https://example.com/smoke-podcast',
                    :user_id
                )
                """
            ),
            {"id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_transcription_jobs (
                    media_id,
                    requested_by_user_id,
                    request_reason,
                    status
                )
                VALUES (:media_id, :user_id, 'episode_open', 'pending')
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        _ensure_in_default_library(session, user_id, media_id)
        session.commit()

    podcast_transcripts = importlib.import_module("nexus.services.podcasts.transcripts")
    monkeypatch.setattr(
        podcast_transcripts,
        "_transcribe_podcast_audio",
        lambda _audio_url: {"status": "completed", "segments": segments},
    )
    monkeypatch.setattr(
        podcast_transcripts,
        "_start_transcription_job_heartbeat",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        podcast_transcripts,
        "_stop_transcription_job_heartbeat",
        lambda _heartbeat: None,
    )

    with direct_db.session() as session:
        result = podcast_transcripts.run_podcast_transcription_now(
            session,
            media_id=media_id,
            requested_by_user_id=user_id,
        )
        session.commit()

    assert result["status"] == "completed", f"podcast: transcription failed with {result}"
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _assert_ready_detail(auth_client, user_id: UUID, media_id: UUID, source_name: str) -> None:
    response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"{source_name}: expected readable media detail, got {response.status_code}: "
        f"{response.text}"
    )
    media = response.json()["data"]
    assert media["processing_status"] == "ready_for_reading", (
        f"{source_name}: expected ready_for_reading, got {media['processing_status']}"
    )
    assert media["capabilities"]["can_read"] is True, (
        f"{source_name}: expected can_read capability in {media['capabilities']}"
    )
    assert media["capabilities"]["can_search"] is True, (
        f"{source_name}: expected can_search capability in {media['capabilities']}"
    )


def _assert_content_index_artifacts(
    direct_db: DirectSessionManager,
    media_id: UUID,
    *,
    expected_source_kind: str,
    source_name: str,
) -> None:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                SELECT
                    mcis.status,
                    ss.artifact_kind,
                    ss.content_type,
                    COUNT(DISTINCT cb.id) AS block_count,
                    COUNT(DISTINCT cc.id) AS chunk_count,
                    COUNT(DISTINCT es.id) AS evidence_count,
                    COUNT(DISTINCT ce.chunk_id) AS embedding_count
                FROM media_content_index_states mcis
                JOIN source_snapshots ss ON ss.index_run_id = mcis.active_run_id
                JOIN content_blocks cb ON cb.source_snapshot_id = ss.id
                JOIN content_chunks cc ON cc.source_snapshot_id = ss.id
                JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                JOIN content_embeddings ce ON ce.chunk_id = cc.id
                WHERE mcis.media_id = :media_id
                  AND ss.source_kind = :source_kind
                  AND cc.source_kind = :source_kind
                GROUP BY mcis.status, ss.artifact_kind, ss.content_type
                """
                ),
                {"media_id": media_id, "source_kind": expected_source_kind},
            )
            .mappings()
            .first()
        )

    assert row is not None, f"{source_name}: missing active shared evidence artifacts"
    assert row["status"] == "ready", f"{source_name}: expected ready index state, got {row}"
    assert row["block_count"] > 0, f"{source_name}: expected content blocks, got {row}"
    assert row["chunk_count"] > 0, f"{source_name}: expected content chunks, got {row}"
    assert row["evidence_count"] == row["chunk_count"], (
        f"{source_name}: expected one primary evidence span per chunk, got {row}"
    )
    assert row["embedding_count"] == row["chunk_count"], (
        f"{source_name}: expected deterministic test embeddings for every chunk, got {row}"
    )


def _assert_search_finds_indexed_chunk(
    auth_client,
    user_id: UUID,
    media_id: UUID,
    *,
    query: str,
    source_name: str,
) -> UUID:
    response = auth_client.get(
        f"/search?q={query.replace(' ', '+')}&types=content_chunk",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, (
        f"{source_name}: expected search success, got {response.status_code}: {response.text}"
    )
    rows = [
        row
        for row in response.json()["results"]
        if row["type"] == "content_chunk" and row["source"]["media_id"] == str(media_id)
    ]
    assert rows, f"{source_name}: expected content_chunk search hit for {media_id}"
    evidence_span_ids = rows[0]["evidence_span_ids"]
    assert evidence_span_ids, f"{source_name}: search hit missing evidence_span_ids: {rows[0]}"
    return UUID(evidence_span_ids[0])


def _assert_evidence_resolves(
    auth_client,
    user_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
    *,
    expected_resolver_kind: str,
    source_name: str,
) -> None:
    response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, (
        f"{source_name}: expected evidence resolution, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["media_id"] == str(media_id), f"{source_name}: wrong evidence media: {data}"
    assert data["resolver"]["kind"] == expected_resolver_kind, (
        f"{source_name}: expected resolver {expected_resolver_kind}, got {data['resolver']}"
    )
    assert data["resolver"]["status"] in {"resolved", "no_geometry"}, (
        f"{source_name}: expected usable resolver status, got {data['resolver']}"
    )
    assert data["span_text"].strip(), f"{source_name}: evidence span text is empty"


def _register_background_job_cleanup(
    direct_db: DirectSessionManager,
    media_ids: Iterable[UUID],
) -> None:
    with direct_db.session() as session:
        for media_id in media_ids:
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
