"""Integration tests for YouTube video acquisition and explicit Transcribe.

Acquisition publishes playable Media with metadata enrichment and performs no
transcript work; captions materialize only through the explicit Transcribe
command (``POST /media/{id}/transcript/request``) with origin ``Imported``.
"""

import importlib
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.helpers import auth_headers, create_test_user_id
from tests.support.source_jobs import (
    run_queued_source_attempt,
    run_queued_transcript_semantic_reindex,
)
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
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def _run_latest_source_attempt(
    direct_db: DirectSessionManager, media_id: UUID
) -> dict[str, object]:
    with direct_db.session() as session:
        return run_queued_source_attempt(
            session,
            media_id=media_id,
            request_id="test-youtube-source-attempt",
        )


def _assert_no_transcript_artifacts(direct_db: DirectSessionManager, media_id: UUID) -> None:
    """Acquisition must leave transcript state NotRequested (absent) and empty."""
    with direct_db.session() as session:
        counts = session.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM media_transcript_states WHERE media_id = :media_id),
                    (SELECT COUNT(*) FROM podcast_transcript_segments WHERE media_id = :media_id),
                    (SELECT COUNT(*) FROM fragments WHERE media_id = :media_id)
                """
            ),
            {"media_id": media_id},
        ).one()
    assert counts == (0, 0, 0), (
        "acquisition must not create any transcript state, segments, or fragments; "
        f"found media_transcript_states/segments/fragments = {tuple(counts)}"
    )


def _request_youtube_captions(auth_client, user_id: UUID, media_id: UUID) -> dict[str, object]:
    """Drive the explicit Transcribe command that imports YouTube captions."""
    response = auth_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open"},
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, (
        f"expected explicit Transcribe to import captions synchronously, got "
        f"{response.status_code}: {response.text}"
    )
    return response.json()["data"]


class TestIngestYoutubeVideo:
    def test_acquisition_publishes_playable_media_without_transcript(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Absent YouTube Data API metadata must not fail acquisition: the video is
        # still published as playable Media.
        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_metadata",
            lambda _provider_id: None,
        )

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        result = _run_latest_source_attempt(direct_db, media_id)
        assert result["status"] == "success"
        assert result["metadata_enrichment"] is False

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media = media_response.json()["data"]
        # Playable-only: no transcript state was started during acquisition.
        assert media["processing_status"] == "ready_for_reading"
        assert media["last_error_code"] is None
        assert media["transcript_state"] is None
        assert media["transcript_origin"] == {"kind": "Absent"}
        caps = media["capabilities"]
        assert caps["can_play"] is True
        assert caps["can_read"] is False
        assert caps["can_highlight"] is False
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

        _assert_no_transcript_artifacts(direct_db, media_id)

    def test_acquisition_persists_metadata_and_enqueues_enrichment(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

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

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        result = _run_latest_source_attempt(direct_db, media_id)

        assert result["status"] == "success"
        assert result["metadata_enrichment"] is True

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

        assert job_rows, "expected YouTube acquisition to enqueue metadata enrichment"
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

        # Enriched metadata is still transcript-free; captions require Transcribe.
        assert media["transcript_state"] is None
        assert media["transcript_origin"] == {"kind": "Absent"}
        _assert_no_transcript_artifacts(direct_db, media_id)

    def test_acquisition_is_idempotent_and_leaves_media_playable(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_metadata",
            lambda _provider_id: None,
        )

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/shorts/dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        first = _run_latest_source_attempt(direct_db, media_id)
        duplicate_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/shorts/dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )

        assert first["status"] == "success"
        assert duplicate_response.status_code == 202
        assert UUID(duplicate_response.json()["data"]["media_id"]) == media_id
        # The dedupe short-circuit does not enqueue a second source attempt.
        assert duplicate_response.json()["data"]["ingest_enqueued"] is False
        _assert_no_transcript_artifacts(direct_db, media_id)

    def test_explicit_transcribe_imports_youtube_captions_with_imported_origin(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_metadata",
            lambda _provider_id: None,
        )

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        result = _run_latest_source_attempt(direct_db, media_id)
        assert result["status"] == "success"
        # Acquisition alone leaves no transcript.
        _assert_no_transcript_artifacts(direct_db, media_id)

        # Explicit Transcribe imports the public captions. It is the ONLY path that
        # materializes a YouTube transcript, with origin `Imported`.
        monkeypatch.setattr(
            "nexus.services.podcasts.transcription.fetch_youtube_transcript",
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

        transcribe = _request_youtube_captions(auth_client, user_id, media_id)
        assert transcribe["transcript_state"] == "ready"
        assert transcribe["transcript_coverage"] == "full"
        assert transcribe["request_enqueued"] is False

        with direct_db.session() as session:
            semantic_result = run_queued_transcript_semantic_reindex(
                session,
                media_id=media_id,
            )
        assert semantic_result["status"] == "completed"

        with direct_db.session() as session:
            transcript_row = session.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage, transcript_origin
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
        assert transcript_row == ("ready", "full", "Imported")

        fragments_response = auth_client.get(
            f"/media/{media_id}/fragments", headers=auth_headers(user_id)
        )
        assert fragments_response.status_code == 200, (
            f"expected imported captions to be readable, got {fragments_response.status_code}: "
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
        assert media["transcript_state"] == "ready"
        assert media["transcript_origin"] == {"kind": "Present", "value": "Imported"}
        assert media["retrieval_status"] == "ready"
        caps = media["capabilities"]
        assert caps["can_play"] is True
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_quote"] is True
        assert caps["can_search"] is True

    def test_reingest_transcribe_preserves_highlight_and_replaces_fragments(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        # Highlight Durability (invariant 9): re-running the explicit Transcribe
        # command replaces the media's fragments wholesale through
        # `write_current_transcript` but never deletes highlights. The pre-existing
        # highlight survives with a stale locator cache; because the new
        # transcript's text no longer contains the authored quote, media-wide reads
        # return it as visibly unresolved (null locator) rather than deleting it or
        # painting it at a wrong location.
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            _youtube_ingest_module(),
            "fetch_youtube_metadata",
            lambda _provider_id: None,
        )

        create_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert create_response.status_code == 202
        media_id = UUID(create_response.json()["data"]["media_id"])

        _register_youtube_media_cleanup(direct_db, media_id)

        result = _run_latest_source_attempt(direct_db, media_id)
        assert result["status"] == "success"

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
            "nexus.services.podcasts.transcription.fetch_youtube_transcript",
            lambda _provider_id: {"status": "completed", "segments": first_segments},
        )
        _request_youtube_captions(auth_client, user_id, media_id)

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
            "nexus.services.podcasts.transcription.fetch_youtube_transcript",
            lambda _provider_id: {"status": "completed", "segments": second_segments},
        )
        _request_youtube_captions(auth_client, user_id, media_id)

        # The pre-existing highlight SURVIVES the fragment replacement.
        highlight_detail = auth_client.get(
            f"/highlights/{highlight_id}", headers=auth_headers(user_id)
        )
        assert highlight_detail.status_code == 200, (
            "expected the highlight to survive the re-transcribe fragment replacement, "
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
        # The anchor row survives as a stale locator cache; only the fragment
        # (a replaceable index row) is gone.
        assert anchor_count == 1
        assert old_fragment_count == 0

        # The quote no longer exists in the beta transcript, so the media-wide
        # read reports the surviving highlight as unresolved: no locator, never
        # a wrong location.
        media_highlights = auth_client.get(
            f"/media/{media_id}/highlights", headers=auth_headers(user_id)
        )
        assert media_highlights.status_code == 200, media_highlights.text
        rows = media_highlights.json()["data"]["highlights"]
        assert [row["id"] for row in rows] == [str(highlight_id)]
        anchor = rows[0]["anchor"]
        assert anchor["type"] == "fragment_offsets"
        assert anchor["fragment_id"] is None
        assert anchor["start_offset"] is None
        assert anchor["end_offset"] is None
