"""Shared setup for strict real-media acceptance tests."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import text

from nexus.config import get_settings
from nexus.storage import get_storage_client
from tests.real_media.assertions import assert_fragment_content_contains
from tests.utils.db import DirectSessionManager

REAL_MEDIA_FIXTURES_DIR = Path(__file__).parents[1] / "fixtures" / "real_media"
FIXTURES_DIR = Path(__file__).parents[1] / "fixtures"


def ensure_real_media_prerequisites() -> None:
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("real-media tests must run with NEXUS_ENV=local, staging, or prod")
    if not settings.real_media_provider_fixtures:
        pytest.fail(
            "REAL_MEDIA_PROVIDER_FIXTURES must be enabled for deterministic real-media tests"
        )
    if not settings.real_media_fixture_dir:
        pytest.fail("REAL_MEDIA_FIXTURE_DIR must be set for deterministic real-media tests")
    fixture_dir = Path(settings.real_media_fixture_dir)
    if not fixture_dir.is_dir():
        pytest.fail(f"REAL_MEDIA_FIXTURE_DIR does not exist: {fixture_dir}")
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


def grant_ai_plus(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_accounts", "user_id", user_id)
    with direct_db.session() as session:
        now = datetime.now(UTC)
        session.execute(
            text(
                """
                INSERT INTO billing_accounts (
                    id,
                    user_id,
                    plan_tier,
                    subscription_status,
                    current_period_start,
                    current_period_end,
                    created_at,
                    updated_at
                )
                VALUES (
                    :id,
                    :user_id,
                    'ai_plus',
                    'active',
                    :current_period_start,
                    :current_period_end,
                    :now,
                    :now
                )
                ON CONFLICT (user_id) DO UPDATE
                SET plan_tier = 'ai_plus',
                    subscription_status = 'active',
                    current_period_start = EXCLUDED.current_period_start,
                    current_period_end = EXCLUDED.current_period_end,
                    updated_at = EXCLUDED.updated_at
                """
            ),
            {
                "id": uuid4(),
                "user_id": user_id,
                "current_period_start": now - timedelta(days=1),
                "current_period_end": now + timedelta(days=30),
                "now": now,
            },
        )
        session.commit()


def capture_nasa_water_article(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
) -> UUID:
    html = (REAL_MEDIA_FIXTURES_DIR / "nasa-water-on-moon-capture.html").read_text(encoding="utf-8")
    html_bytes = html.encode("utf-8")
    assert len(html_bytes) == 1_019
    assert hashlib.sha256(html_bytes).hexdigest() == (
        "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a"
    )

    session_response = auth_client.post("/auth/extension-sessions", headers=headers)
    assert session_response.status_code == 201, session_response.text
    session_id = UUID(session_response.json()["data"]["id"])
    token = session_response.json()["data"]["token"]
    direct_db.register_cleanup("extension_sessions", "id", session_id)

    capture_response = auth_client.post(
        "/media/capture/article",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "title": "There's Water on the Moon?",
            "byline": "Molly Wasser",
            "excerpt": "NASA Science captured article fixture.",
            "site_name": "NASA Science",
            "published_time": "2020-11-05T00:00:00Z",
            "content_html": html,
        },
    )
    assert capture_response.status_code == 201, capture_response.text
    media_id = UUID(capture_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    return media_id


def create_nasa_captioned_video(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
    user_id: UUID,
) -> tuple[UUID, dict]:
    caption_text = (
        REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt"
    ).read_text(encoding="utf-8")
    caption_bytes = caption_text.encode("utf-8")
    assert len(caption_bytes) == 9_805
    assert hashlib.sha256(caption_bytes).hexdigest() == (
        "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237"
    )

    create_response = auth_client.post(
        "/media/from_url",
        json={"url": "https://www.youtube.com/watch?v=drrP_Iss0gA"},
        headers=headers,
    )
    assert create_response.status_code == 202, create_response.text
    media_id = UUID(create_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)

    from nexus.tasks.ingest_youtube_video import run_ingest_sync

    with direct_db.session() as session:
        result = run_ingest_sync(
            session,
            media_id,
            user_id,
            request_id="real-media-youtube-caption-fixture",
        )
        session.commit()
    assert result["status"] == "success", result
    assert result["segment_count"] >= 20, result
    return media_id, result


def create_nasa_podcast_episode(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
    user_id: UUID,
) -> tuple[UUID, UUID, dict]:
    grant_ai_plus(direct_db, user_id)

    transcript_text = (REAL_MEDIA_FIXTURES_DIR / "nasa-hwhap-crew4-transcript.txt").read_text(
        encoding="utf-8"
    )
    transcript_bytes = transcript_text.encode("utf-8")
    assert len(transcript_bytes) == 753
    assert hashlib.sha256(transcript_bytes).hexdigest() == (
        "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953"
    )

    discover_response = auth_client.get(
        "/podcasts/discover",
        params={"q": "Houston We Have a Podcast", "limit": 5},
        headers=headers,
    )
    assert discover_response.status_code == 200, discover_response.text
    podcast = next(
        (
            row
            for row in discover_response.json()["data"]
            if row["provider_podcast_id"] == "nasa-hwhap-real-media"
        ),
        None,
    )
    assert podcast is not None, discover_response.json()

    subscribe_response = auth_client.post(
        "/podcasts/subscriptions",
        headers=headers,
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
    )
    assert subscribe_response.status_code == 200, subscribe_response.text
    podcast_id = UUID(subscribe_response.json()["data"]["podcast_id"])
    register_podcast_cleanup(direct_db, podcast_id)

    sync_response = auth_client.post(
        f"/podcasts/subscriptions/{podcast_id}/sync",
        headers=headers,
    )
    assert sync_response.status_code == 202, sync_response.text

    with direct_db.session() as session:
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
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)

    from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now

    with direct_db.session() as session:
        sync_result = run_podcast_subscription_sync_now(
            session,
            user_id=user_id,
            podcast_id=podcast_id,
            request_id="real-media-podcast-sync-fixture",
        )
        session.commit()
    assert sync_result["sync_status"] == "complete", sync_result

    episodes_response = auth_client.get(f"/podcasts/{podcast_id}/episodes", headers=headers)
    assert episodes_response.status_code == 200, episodes_response.text
    episode = next(
        (
            row
            for row in episodes_response.json()["data"]
            if row["title"] == "The Crew-4 Astronauts"
        ),
        None,
    )
    assert episode is not None, episodes_response.json()
    media_id = UUID(episode["id"])

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
            request_id="real-media-podcast-transcript-fixture",
        )
        session.commit()
    assert transcription_result["status"] == "completed", transcription_result
    assert transcription_result["segment_count"] > 0, transcription_result

    assert_fragment_content_contains(direct_db, media_id, "International Space Station")
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    return media_id, podcast_id, transcription_result


def upload_file_media(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
    *,
    kind: str,
    filename: str,
    content_type: str,
    payload: bytes,
) -> tuple[UUID, str]:
    upload_response = auth_client.post(
        "/media/upload/init",
        json={
            "kind": kind,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": len(payload),
        },
        headers=headers,
    )
    assert upload_response.status_code == 200, upload_response.text
    upload = upload_response.json()["data"]
    media_id = UUID(upload["media_id"])
    storage_path = upload["storage_path"]
    register_media_cleanup(direct_db, media_id)

    get_storage_client().put_object(storage_path, payload, content_type)
    confirm_response = auth_client.post(f"/media/{media_id}/ingest", headers=headers)
    assert confirm_response.status_code == 200, confirm_response.text
    assert confirm_response.json()["data"]["duplicate"] is False
    return media_id, storage_path


def register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("user_media_deletions", "media_id", media_id)
    direct_db.register_cleanup("reader_media_state", "media_id", media_id)
    direct_db.register_cleanup("playback_queue_items", "media_id", media_id)
    direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
    direct_db.register_cleanup("media_file", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
    direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
    direct_db.register_cleanup("epub_resources", "media_id", media_id)
    direct_db.register_cleanup("epub_fragment_sources", "media_id", media_id)
    direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)
    direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
    direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
    direct_db.register_cleanup("podcast_episode_chapters", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_request_audits", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_versions", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcription_jobs", "media_id", media_id)
    direct_db.register_cleanup("podcast_episodes", "media_id", media_id)


def register_podcast_cleanup(direct_db: DirectSessionManager, podcast_id: UUID) -> None:
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
    direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
    direct_db.register_cleanup("podcast_episodes", "podcast_id", podcast_id)


def register_background_job_cleanup(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> None:
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


def write_trace(tmp_path: Path, name: str, payload: dict) -> None:
    (tmp_path / name).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
