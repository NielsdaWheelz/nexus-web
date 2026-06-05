"""Integration tests for YouTube video transcript ingestion."""

import importlib
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _youtube_ingest_module():
    return importlib.import_module("nexus.services.youtube_video_ingest")


def _register_youtube_media_cleanup(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> None:
    with direct_db.session() as session:
        job_ids = [
            row[0]
            for row in session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchall()
        ]
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)
    direct_db.register_cleanup("media_source_attempts", "media_id", media_id)
    direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_versions", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def _run_latest_source_attempt(direct_db: DirectSessionManager, media_id: UUID) -> dict[str, object]:
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT id, created_by_user_id
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        return run_source_attempt(
            db=session,
            media_id=media_id,
            attempt_id=row[0],
            actor_user_id=row[1],
            request_id="test-youtube-source-attempt",
        )


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

        _register_youtube_media_cleanup(direct_db, media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_transcript",
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

        from nexus.services.youtube_video_ingest import run_youtube_video_ingest

        with direct_db.session() as session:
            result = run_youtube_video_ingest(session, media_id, user_id)

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

        _register_youtube_media_cleanup(direct_db, media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_transcript",
            lambda _provider_id: {
                "status": "failed",
                "error_code": "E_TRANSCRIPT_UNAVAILABLE",
                "error_message": "Transcript unavailable",
            },
        )

        result = _run_latest_source_attempt(direct_db, media_id)

        assert result["status"] == "failed"
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE"

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

        _register_youtube_media_cleanup(direct_db, media_id)

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_metadata",
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
            "fetch_youtube_transcript",
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

        from nexus.services.youtube_video_ingest import run_youtube_video_ingest

        with direct_db.session() as session:
            result = run_youtube_video_ingest(session, media_id, user_id)

        assert result["status"] == "success"

        with direct_db.session() as session:
            job_rows = [
                row
                for row in session.execute(
                    text(
                        """
                        SELECT id, payload
                        FROM background_jobs
                        WHERE kind = 'enrich_metadata'
                          AND payload->>'media_id' = :media_id
                        """
                    ),
                    {"media_id": str(media_id)},
                ).fetchall()
            ]
        for job_id, _payload in job_rows:
            direct_db.register_cleanup("background_jobs", "id", job_id)

        assert job_rows, "expected YouTube ingest to enqueue metadata enrichment"
        for _job_id, payload in job_rows:
            assert "force" not in payload, (
                "automatic YouTube metadata enrichment must use the structured-overwrite "
                f"job payload, got {payload!r}"
            )

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

        _register_youtube_media_cleanup(direct_db, media_id)

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
            "fetch_youtube_transcript",
            _fake_transcript,
        )

        from nexus.services.youtube_video_ingest import run_youtube_video_ingest

        with direct_db.session() as session:
            first = run_youtube_video_ingest(session, media_id, user_id)
            second = run_youtube_video_ingest(session, media_id, user_id)

        assert first["status"] == "success"
        assert second["status"] == "skipped"
        assert second["reason"] == "already_ready"
        assert calls["count"] == 1, f"expected one transcript fetch, got {calls['count']}"

    def test_reingest_replace_strategy_deletes_anchored_highlight_and_replaces_fragments(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        # Characterization test pinning the destructive `fragment_strategy="replace"`
        # side of write_transcript_version (the YouTube-only branch in
        # nexus/services/transcripts/versions.py): a YouTube re-ingest deletes the
        # media's pre-existing highlights (via the highlight_fragment_anchors join)
        # and replaces its fragments wholesale. The "preserve_anchors" counterpart is
        # pinned in test_podcasts.py
        # (test_retranscription_creates_new_version_without_deleting_old_highlight_anchor).
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        first_segments = [
            {
                "t_start_ms": 0,
                "t_end_ms": 1200,
                "text": "alpha transcript line",
                "speaker_label": "SpeakerA",
            },
            {
                "t_start_ms": 1300,
                "t_end_ms": 2400,
                "text": "alpha follow up",
                "speaker_label": None,
            },
        ]
        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_transcript",
            lambda _provider_id: {"status": "completed", "segments": first_segments},
        )

        from nexus.services.youtube_video_ingest import run_youtube_video_ingest

        with direct_db.session() as session:
            first = run_youtube_video_ingest(session, media_id, user_id)
        assert first["status"] == "success"

        # Seed a highlight anchored to one of the first transcript's fragments. The
        # POST creates the highlight + its highlight_fragment_anchors row, which is the
        # exact join the "replace" branch deletes through.
        fragments_v1_response = auth_client.get(
            f"/media/{media_id}/fragments", headers=auth_headers(user_id)
        )
        assert fragments_v1_response.status_code == 200
        fragments_v1 = fragments_v1_response.json()["data"]
        assert len(fragments_v1) == 2
        first_fragment_id = UUID(fragments_v1[0]["id"])

        highlight_response = auth_client.post(
            f"/fragments/{first_fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert highlight_response.status_code == 201, (
            f"expected highlight create 201, got {highlight_response.status_code}: "
            f"{highlight_response.text}"
        )
        highlight_id = UUID(highlight_response.json()["data"]["id"])
        direct_db.register_cleanup("highlights", "fragment_anchor_fragment_id", first_fragment_id)

        # A YouTube source refresh resets the media back to active processing,
        # which defeats the already_ready skip guard so the second run
        # re-transcribes through write_transcript_version.
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE media
                    SET processing_status = 'pending', updated_at = :now
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id, "now": datetime.now(UTC)},
            )
            session.commit()

        second_segments = [
            {
                "t_start_ms": 5000,
                "t_end_ms": 6200,
                "text": "beta transcript line",
                "speaker_label": "SpeakerB",
            },
            {
                "t_start_ms": 6300,
                "t_end_ms": 7600,
                "text": "beta follow up",
                "speaker_label": None,
            },
        ]
        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_transcript",
            lambda _provider_id: {"status": "completed", "segments": second_segments},
        )

        with direct_db.session() as session:
            second = run_youtube_video_ingest(session, media_id, user_id)
        assert second["status"] == "success"

        # The pre-existing highlight anchored to a now-deleted fragment is GONE.
        highlight_detail = auth_client.get(
            f"/highlights/{highlight_id}", headers=auth_headers(user_id)
        )
        assert highlight_detail.status_code == 404, (
            "expected the re-ingest 'replace' strategy to delete the anchored highlight, "
            f"got {highlight_detail.status_code}: {highlight_detail.text}"
        )

        # The fragments were replaced wholesale by the new transcript's segments: the
        # original fragment id is gone and only the beta segments remain.
        fragments_v2_response = auth_client.get(
            f"/media/{media_id}/fragments", headers=auth_headers(user_id)
        )
        assert fragments_v2_response.status_code == 200
        fragments_v2 = fragments_v2_response.json()["data"]
        assert len(fragments_v2) == 2
        assert {row["canonical_text"] for row in fragments_v2} == {
            "beta transcript line",
            "beta follow up",
        }
        assert all("alpha" not in row["canonical_text"] for row in fragments_v2)
        fragment_v2_ids = {UUID(row["id"]) for row in fragments_v2}
        assert first_fragment_id not in fragment_v2_ids

        with direct_db.session() as session:
            anchor_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM highlight_fragment_anchors
                    WHERE highlight_id = :highlight_id
                    """
                ),
                {"highlight_id": highlight_id},
            ).scalar()
            old_fragment_count = session.execute(
                text("SELECT COUNT(*) FROM fragments WHERE id = :fragment_id"),
                {"fragment_id": first_fragment_id},
            ).scalar()
        assert anchor_count == 0
        assert old_fragment_count == 0
