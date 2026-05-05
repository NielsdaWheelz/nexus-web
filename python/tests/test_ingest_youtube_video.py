"""Integration tests for YouTube video transcript ingestion."""

import importlib
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _youtube_ingest_module():
    return importlib.import_module("nexus.tasks.ingest_youtube_video")


class TestIngestYoutubeVideo:
    def test_transcript_success_persists_ordered_fragments_and_marks_readable(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "_fetch_youtube_transcript",
            lambda _provider_id: {
                "status": "completed",
                "segments": [
                    {
                        "t_start_ms": 4500,
                        "t_end_ms": 5100,
                        "text": "   second   segment ",
                        "speaker_label": "",
                    },
                    {
                        "t_start_ms": 1200,
                        "t_end_ms": 2000,
                        "text": "first segment",
                        "speaker_label": "Host",
                    },
                ],
            },
        )

        from nexus.tasks.ingest_youtube_video import run_ingest_sync

        with direct_db.session() as session:
            result = run_ingest_sync(session, media_id, user_id)

        assert result["status"] == "success"

        fragments_response = auth_client.get(
            f"/media/{media_id}/fragments", headers=auth_headers(user_id)
        )
        assert fragments_response.status_code == 200, (
            f"expected transcript fragments to be readable, got {fragments_response.status_code}: "
            f"{fragments_response.text}"
        )
        fragments = fragments_response.json()["data"]
        assert len(fragments) == 2
        assert fragments[0]["canonical_text"] == "first segment"
        assert fragments[1]["canonical_text"] == "second segment"
        assert [frag["t_start_ms"] for frag in fragments] == [1200, 4500]

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media = media_response.json()["data"]
        assert media["processing_status"] == "ready_for_reading"
        assert media["retrieval_status"] == "ready"
        assert media["last_error_code"] is None
        caps = media["capabilities"]
        assert caps["can_play"] is True
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_quote"] is True
        assert caps["can_search"] is True

        with direct_db.session() as session:
            artifact_counts = session.execute(
                text(
                    """
                    SELECT
                        (SELECT COUNT(*) FROM podcast_transcript_versions WHERE media_id = :media_id),
                        (SELECT COUNT(*) FROM podcast_transcript_segments WHERE media_id = :media_id),
                        (SELECT COUNT(*) FROM content_chunks WHERE media_id = :media_id),
                        (SELECT COUNT(*) FROM evidence_spans WHERE media_id = :media_id)
                    """
                ),
                {"media_id": media_id},
            ).one()
        assert artifact_counts[0] == 1
        assert artifact_counts[1] == 2
        assert artifact_counts[2] > 0
        assert artifact_counts[3] == artifact_counts[2]

    def test_transcript_unavailable_is_playback_only_and_terminal(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://youtu.be/dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "_fetch_youtube_transcript",
            lambda _provider_id: {
                "status": "failed",
                "error_code": "E_TRANSCRIPT_UNAVAILABLE",
                "error_message": "Transcript unavailable",
            },
        )

        from nexus.tasks.ingest_youtube_video import run_ingest_sync

        with direct_db.session() as session:
            result = run_ingest_sync(session, media_id, user_id)

        assert result["status"] == "failed"

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media = media_response.json()["data"]
        assert media["processing_status"] == "failed"
        assert media["last_error_code"] == "E_TRANSCRIPT_UNAVAILABLE"
        caps = media["capabilities"]
        assert caps["can_play"] is True
        assert caps["can_read"] is False
        assert caps["can_highlight"] is False
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_transcript_success_persists_source_metadata_and_enqueues_enrichment(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "_fetch_youtube_metadata",
            lambda _provider_id: {
                "title": "Systems Thinking Video",
                "description": "A concise systems lecture.",
                "author": "Nexus Channel",
                "published_date": "2026-04-01T12:00:00Z",
                "language": "en-US",
            },
        )
        monkeypatch.setattr(
            _youtube_ingest_module(),
            "_fetch_youtube_transcript",
            lambda _provider_id: {
                "status": "completed",
                "segments": [
                    {
                        "t_start_ms": 0,
                        "t_end_ms": 900,
                        "text": "systems lecture transcript",
                        "speaker_label": None,
                    }
                ],
            },
        )

        from nexus.tasks.ingest_youtube_video import run_ingest_sync

        with direct_db.session() as session:
            result = run_ingest_sync(session, media_id, user_id)

        assert result["status"] == "success"

        with direct_db.session() as session:
            job_ids = [
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT id
                        FROM background_jobs
                        WHERE kind = 'enrich_metadata'
                          AND payload->>'media_id' = :media_id
                        """
                    ),
                    {"media_id": str(media_id)},
                ).fetchall()
            ]
        for job_id in job_ids:
            direct_db.register_cleanup("background_jobs", "id", job_id)

        assert job_ids, "expected YouTube ingest to enqueue metadata enrichment"

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media = media_response.json()["data"]

        assert media["title"] == "Systems Thinking Video"
        assert media["description"] == "A concise systems lecture."
        assert media["publisher"] == "Nexus Channel"
        assert media["published_date"] == "2026-04-01T12:00:00Z"
        assert media["language"] == "en-US"
        assert [credit["credited_name"] for credit in media["contributors"]] == ["Nexus Channel"]

    def test_ingest_is_idempotent_after_success_and_does_not_refetch_transcript(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/shorts/dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        calls = {"count": 0}

        def _fake_transcript(_provider_id: str):
            calls["count"] += 1
            return {
                "status": "completed",
                "segments": [
                    {
                        "t_start_ms": 0,
                        "t_end_ms": 900,
                        "text": "single segment",
                        "speaker_label": None,
                    }
                ],
            }

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "_fetch_youtube_transcript",
            _fake_transcript,
        )

        from nexus.tasks.ingest_youtube_video import run_ingest_sync

        with direct_db.session() as session:
            first = run_ingest_sync(session, media_id, user_id)
            second = run_ingest_sync(session, media_id, user_id)

        assert first["status"] == "success"
        assert second["status"] == "skipped"
        assert second["reason"] == "already_ready"
        assert calls["count"] == 1, f"expected one transcript fetch, got {calls['count']}"
