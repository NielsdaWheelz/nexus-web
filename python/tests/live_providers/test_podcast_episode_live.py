"""Live podcast discovery, RSS, audio, transcription, and indexing provider gate."""

from __future__ import annotations

import os
from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.config import get_settings
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_media_ready,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    grant_ai_plus,
    register_background_job_cleanup,
    register_media_cleanup,
    register_podcast_cleanup,
    write_trace,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
    pytest.mark.live_provider,
]


def test_live_podcast_episode_transcribes_and_indexes_real_episode(
    auth_client, direct_db, tmp_path
):
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider gate must run with NEXUS_ENV=local, staging, or prod")
    if not settings.enable_openai or not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY and ENABLE_OPENAI=true are required for live podcast ingest")
    if (
        not settings.podcast_index_api_key
        or settings.podcast_index_api_key == "test-podcast-index-key"
    ):
        pytest.fail("PODCAST_INDEX_API_KEY must be a real provider key for live podcast ingest")
    if (
        not settings.podcast_index_api_secret
        or settings.podcast_index_api_secret == "test-podcast-index-secret"
    ):
        pytest.fail(
            "PODCAST_INDEX_API_SECRET must be a real provider secret for live podcast ingest"
        )
    if not settings.deepgram_api_key:
        pytest.fail("DEEPGRAM_API_KEY must be set for live podcast transcription")

    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)
    grant_ai_plus(direct_db, user_id)

    discover_response = auth_client.get(
        "/podcasts/discover",
        params={"q": "Houston We Have a Podcast", "limit": 10},
        headers=headers,
    )
    assert discover_response.status_code == 200, discover_response.text
    candidates = discover_response.json()["data"]
    podcast = next(
        (
            candidate
            for candidate in candidates
            if "Houston We Have a Podcast" in candidate["title"]
        ),
        None,
    )
    assert podcast is not None, candidates

    subscribe_response = auth_client.post(
        "/podcasts/subscriptions",
        json={
            "provider_podcast_id": podcast["provider_podcast_id"],
            "title": podcast["title"],
            "contributors": podcast["contributors"],
            "feed_url": podcast["feed_url"],
            "website_url": podcast["website_url"],
            "image_url": podcast["image_url"],
            "description": podcast["description"],
            "auto_queue": False,
        },
        headers=headers,
    )
    assert subscribe_response.status_code == 200, subscribe_response.text
    podcast_id = UUID(subscribe_response.json()["data"]["podcast_id"])
    register_podcast_cleanup(direct_db, podcast_id)

    from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now

    with direct_db.session() as session:
        sync_result = run_podcast_subscription_sync_now(
            session,
            user_id=user_id,
            podcast_id=podcast_id,
            request_id="live-provider-podcast-sync",
        )
        session.commit()

    assert sync_result["sync_status"] == "complete", sync_result

    with direct_db.session() as session:
        episode_rows = (
            session.execute(
                text(
                    """
                    SELECT pe.media_id, pe.duration_seconds
                    FROM podcast_episodes pe
                    JOIN media m ON m.id = pe.media_id
                    WHERE pe.podcast_id = :podcast_id
                      AND m.external_playback_url IS NOT NULL
                    ORDER BY COALESCE(pe.duration_seconds, 999999) ASC,
                             pe.published_at DESC NULLS LAST,
                             pe.media_id ASC
                    """
                ),
                {"podcast_id": podcast_id},
            )
            .mappings()
            .all()
        )
        job_ids = (
            session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'podcast_id' = :podcast_id
                    """
                ),
                {"podcast_id": str(podcast_id)},
            )
            .scalars()
            .all()
        )
    assert episode_rows, sync_result
    for episode in episode_rows:
        register_media_cleanup(direct_db, episode["media_id"])
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)

    media_id = episode_rows[0]["media_id"]
    transcript_request = auth_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open"},
        headers=headers,
    )
    assert transcript_request.status_code in {200, 202}, transcript_request.text

    from nexus.tasks.podcast_transcribe_episode import run_podcast_transcribe_now

    with direct_db.session() as session:
        transcription_result = run_podcast_transcribe_now(
            session,
            media_id=media_id,
            requested_by_user_id=user_id,
            request_id="live-provider-podcast-transcribe",
        )
        session.commit()

    assert transcription_result["status"] == "completed", transcription_result
    register_background_job_cleanup(direct_db, media_id)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "transcript", "transcript")
    search_trace = assert_search_and_resolver(auth_client, headers, media_id, "NASA", "transcript")
    write_trace(
        tmp_path,
        "live-podcast-hwhap-trace.json",
        {
            "podcast_title": podcast["title"],
            "podcast_id": str(podcast_id),
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "transcription": transcription_result,
        },
    )
