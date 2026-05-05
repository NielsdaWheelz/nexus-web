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
from tests.utils.db import DirectSessionManager

REAL_MEDIA_FIXTURES_DIR = Path(__file__).parents[1] / "fixtures" / "real_media"
FIXTURES_DIR = Path(__file__).parents[1] / "fixtures"


def ensure_real_media_prerequisites() -> None:
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("real-media tests must run with NEXUS_ENV=local, staging, or prod")
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
) -> UUID:
    caption_text = (
        REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt"
    ).read_text(encoding="utf-8")
    caption_bytes = caption_text.encode("utf-8")
    assert len(caption_bytes) == 9_910
    assert hashlib.sha256(caption_bytes).hexdigest() == (
        "1dd90aed6b9b8278540247f6c1a4f10aff195f6b1f8895d6baf12701a721d889"
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

    from nexus.services.rss_transcript_fetch import _parse_srt_transcript

    segments = _parse_srt_transcript(caption_text)
    assert len(segments) >= 20
    assert any("International Space Station" in segment["text"] for segment in segments)
    _persist_transcript_index(
        direct_db,
        media_id=media_id,
        user_id=user_id,
        title="Picturing Earth: Behind the Scenes",
        canonical_source_url=(
            "https://science.nasa.gov/earth/earth-observatory/picturing-earth-behind-the-scenes/"
        ),
        external_playback_url="https://www.youtube.com/watch?v=drrP_Iss0gA",
        segments=segments,
        reason="youtube_caption_fixture",
    )
    return media_id


def create_nasa_podcast_episode(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
    user_id: UUID,
) -> tuple[UUID, UUID]:
    transcript_text = (REAL_MEDIA_FIXTURES_DIR / "nasa-hwhap-crew4-transcript.txt").read_text(
        encoding="utf-8"
    )
    transcript_bytes = transcript_text.encode("utf-8")
    assert len(transcript_bytes) == 753
    assert hashlib.sha256(transcript_bytes).hexdigest() == (
        "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953"
    )

    from nexus.schemas.podcast import PodcastSubscribeRequest
    from nexus.services.podcasts.subscriptions import subscribe_to_podcast

    with direct_db.session() as session:
        subscribe_out = subscribe_to_podcast(
            session,
            user_id,
            PodcastSubscribeRequest(
                provider_podcast_id="nasa-hwhap-real-media",
                title="Houston We Have a Podcast",
                contributors=[
                    {
                        "credited_name": "NASA Johnson Space Center",
                        "role": "author",
                        "source": "rss",
                    }
                ],
                feed_url="https://www.nasa.gov/podcasts/houston-we-have-a-podcast/",
                website_url="https://www.nasa.gov/podcasts/houston-we-have-a-podcast/",
                image_url=None,
                description="NASA Johnson Space Center podcast.",
                auto_queue=False,
            ),
        )
        session.commit()
    podcast_id = subscribe_out.podcast_id
    register_podcast_cleanup(direct_db, podcast_id)
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

    media_id = uuid4()
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    with direct_db.session() as session:
        from nexus.services.upload import _ensure_in_default_library

        now = datetime.now(UTC)
        session.execute(
            text(
                """
                INSERT INTO media (
                    id,
                    kind,
                    title,
                    canonical_source_url,
                    external_playback_url,
                    provider,
                    provider_id,
                    processing_status,
                    created_by_user_id,
                    description,
                    language,
                    created_at,
                    updated_at
                )
                VALUES (
                    :id,
                    'podcast_episode',
                    'The Crew-4 Astronauts',
                    'https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-crew-4-astronauts/',
                    'https://www.nasa.gov/wp-content/uploads/2023/07/ep239_crew-4.mp3',
                    'podcast_index',
                    'nasa-hwhap-crew4',
                    'pending',
                    :user_id,
                    'NASA Houston We Have a Podcast episode 239.',
                    'en',
                    :now,
                    :now
                )
                """
            ),
            {"id": media_id, "user_id": user_id, "now": now},
        )
        session.execute(
            text(
                """
                INSERT INTO podcast_episodes (
                    media_id,
                    podcast_id,
                    provider_episode_id,
                    guid,
                    fallback_identity,
                    published_at,
                    duration_seconds,
                    description_text,
                    rss_transcript_url,
                    created_at
                )
                VALUES (
                    :media_id,
                    :podcast_id,
                    'nasa-hwhap-crew4',
                    'nasa-hwhap-crew4',
                    'nasa-hwhap-crew4',
                    '2022-04-15T00:00:00Z',
                    753,
                    'The Crew-4 Astronauts.',
                    'https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-crew-4-astronauts/',
                    :now
                )
                """
            ),
            {"media_id": media_id, "podcast_id": podcast_id, "now": now},
        )
        _ensure_in_default_library(session, user_id, media_id)
        session.commit()

    paragraphs = [
        paragraph.replace("\n", " ").strip()
        for paragraph in transcript_text.split("\n\n")
        if paragraph.strip()
    ]
    assert len(paragraphs) >= 4
    segments = [
        {
            "text": paragraph,
            "t_start_ms": idx * 30_000,
            "t_end_ms": (idx + 1) * 30_000,
            "speaker_label": None,
        }
        for idx, paragraph in enumerate(paragraphs)
    ]
    _persist_transcript_index(
        direct_db,
        media_id=media_id,
        user_id=user_id,
        title="The Crew-4 Astronauts",
        canonical_source_url=(
            "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-crew-4-astronauts/"
        ),
        external_playback_url="https://www.nasa.gov/wp-content/uploads/2023/07/ep239_crew-4.mp3",
        segments=segments,
        reason="podcast_transcript_fixture",
    )
    return media_id, podcast_id


def _persist_transcript_index(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    user_id: UUID,
    title: str,
    canonical_source_url: str,
    external_playback_url: str,
    segments: list[dict],
    reason: str,
) -> None:
    from nexus.services.podcasts.transcripts import (
        _create_next_transcript_version,
        _insert_transcript_fragments,
        _insert_transcript_segments_for_version,
        _rebuild_transcript_content_index_for_version,
        _set_media_transcript_state,
    )

    with direct_db.session() as session:
        now = datetime.now(UTC)
        transcript_version_id = _create_next_transcript_version(
            session,
            media_id=media_id,
            created_by_user_id=user_id,
            request_reason="episode_open",
            transcript_coverage="full",
            now=now,
        )
        _insert_transcript_fragments(
            session,
            media_id,
            segments,
            now=now,
            transcript_version_id=transcript_version_id,
        )
        _insert_transcript_segments_for_version(
            session,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=segments,
            now=now,
        )
        _rebuild_transcript_content_index_for_version(
            session,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=segments,
            reason=reason,
        )
        _set_media_transcript_state(
            session,
            media_id=media_id,
            transcript_state="ready",
            transcript_coverage="full",
            semantic_status="ready",
            active_transcript_version_id=transcript_version_id,
            last_request_reason="episode_open",
            last_error_code=None,
            now=now,
        )
        session.execute(
            text(
                """
                UPDATE media
                SET title = :title,
                    canonical_source_url = :canonical_source_url,
                    external_playback_url = :external_playback_url,
                    processing_status = 'ready_for_reading',
                    failure_stage = NULL,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    processing_completed_at = :now,
                    failed_at = NULL,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "title": title,
                "canonical_source_url": canonical_source_url,
                "external_playback_url": external_playback_url,
                "now": now,
            },
        )
        session.commit()


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
