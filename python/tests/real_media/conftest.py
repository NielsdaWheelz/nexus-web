"""Shared setup for strict real-media acceptance tests."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.config import get_settings
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.semantic_chunks import current_transcript_embedding_provider
from nexus.storage.client import get_storage_client
from nexus.storage.paths import (
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)
from tests.real_media.assertions import assert_fragment_content_contains
from tests.utils.db import DirectSessionManager

REAL_MEDIA_FIXTURES_DIR = Path(__file__).parents[1] / "fixtures" / "real_media"
FIXTURES_DIR = Path(__file__).parents[1] / "fixtures"
NON_LOCAL_STORAGE_OPT_IN = "REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE"


def ensure_real_media_prerequisites() -> None:
    settings = get_settings()
    if settings.nexus_env.value != "local":
        pytest.fail("real-media tests must run with NEXUS_ENV=local")
    if not settings.real_media_provider_fixtures:
        pytest.fail(
            "REAL_MEDIA_PROVIDER_FIXTURES must be enabled for deterministic real-media tests"
        )
    if not settings.real_media_fixture_dir:
        pytest.fail("REAL_MEDIA_FIXTURE_DIR must be set for deterministic real-media tests")
    fixture_dir = Path(settings.real_media_fixture_dir)
    if not fixture_dir.is_dir():
        pytest.fail(f"REAL_MEDIA_FIXTURE_DIR does not exist: {fixture_dir}")
    missing_r2 = [
        key
        for key in ("R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
        if not os.environ.get(key)
    ]
    if missing_r2:
        pytest.fail(f"Cloudflare R2 storage env is required: {', '.join(missing_r2)}")
    if settings.nexus_env.value == "local" and os.environ.get(NON_LOCAL_STORAGE_OPT_IN) != "1":
        endpoint_url = settings.r2_s3_api_origin or os.environ.get("R2_S3_API_ORIGIN") or ""
        if not _is_local_storage_endpoint(endpoint_url):
            pytest.fail(
                "Refusing local real-media tests against non-local R2/MinIO endpoint "
                f"{endpoint_url!r}. Set {NON_LOCAL_STORAGE_OPT_IN}=1 to opt in explicitly."
            )
    if current_transcript_embedding_provider() != "fixture":
        pytest.fail("real-media tests require deterministic fixture_hash_v1 embeddings")


def _is_local_storage_endpoint(endpoint_url: str) -> bool:
    try:
        host = urlparse(endpoint_url).hostname or ""
    except ValueError:
        return False
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0", "minio"} or host.endswith(
        ".localhost"
    )


def grant_ai_plus(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="real-media test access",
            actor_label="test",
        )


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
    assert capture_response.status_code == 202, capture_response.text
    data = capture_response.json()["data"]
    assert data["ingest_enqueued"] is True, data
    media_id = UUID(data["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    result = run_source_attempt_for_media(direct_db, media_id)
    assert result["status"] == "success", result
    return media_id


def run_web_article_source_fixture_with_dedupe_resolution(
    direct_db: DirectSessionManager,
    media_id: UUID,
    user_id: UUID,
    request_id: str,
) -> tuple[UUID, dict]:
    """Run the NASA web fixture ingest and resolve valid production dedupe.

    Web article canonical URLs are globally unique. If another test-owned row
    already owns the NASA fixture URL, production ingest attaches that canonical
    winner to the requesting user's default library and deletes the provisional
    loser. The real-media tests should exercise that contract instead of
    assuming a pristine database.
    """
    result = run_source_attempt_for_media(direct_db, media_id)
    status = result.get("status")
    if status == "success":
        return media_id, result
    if status != "deduped":
        raise AssertionError(f"URL article fixture ingest failed: {result}")

    canonical_url = result.get("canonical_url")
    if not isinstance(canonical_url, str) or not canonical_url:
        raise AssertionError(f"URL article fixture dedupe missing canonical URL: {result}")

    with direct_db.session() as session:
        winner_id = session.execute(
            text(
                """
                SELECT m.id
                FROM libraries dl
                JOIN default_library_intrinsics dli
                  ON dli.default_library_id = dl.id
                JOIN library_entries le
                  ON le.library_id = dl.id
                 AND le.media_id = dli.media_id
                JOIN media m
                  ON m.id = dli.media_id
                JOIN media_content_index_states mcis
                  ON mcis.media_id = m.id
                WHERE dl.owner_user_id = :user_id
                  AND dl.is_default = true
                  AND m.kind = 'web_article'
                  AND m.canonical_url = :canonical_url
                  AND m.processing_status = 'ready_for_reading'
                  AND mcis.status = 'ready'
                ORDER BY m.created_at ASC
                LIMIT 1
                """
            ),
            {"user_id": user_id, "canonical_url": canonical_url},
        ).scalar_one_or_none()
    if winner_id is None:
        raise AssertionError(
            f"URL article fixture deduped without an indexed default-library winner: {result}"
        )

    resolved_media_id = UUID(str(winner_id))
    register_media_cleanup(direct_db, resolved_media_id)
    register_background_job_cleanup(direct_db, resolved_media_id)
    return resolved_media_id, {
        **result,
        "deduped_media_id": str(resolved_media_id),
    }


def run_source_attempt_for_media(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> dict[str, object]:
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT payload
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            )
            .mappings()
            .one()
        )
    payload = row["payload"]
    with direct_db.session() as session:
        return run_source_attempt(
            db=session,
            media_id=UUID(payload["media_id"]),
            attempt_id=UUID(payload["attempt_id"]),
            actor_user_id=UUID(payload["actor_user_id"]),
            request_id=payload.get("request_id"),
        )


def create_nasa_captioned_video(
    auth_client,
    direct_db: DirectSessionManager,
    headers: dict[str, str],
    user_id: UUID,
) -> tuple[UUID, dict]:
    caption_bytes = (
        REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt"
    ).read_bytes()
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

    result = run_source_attempt_for_media(direct_db, media_id)
    if result["status"] == "skipped":
        assert result.get("reason") == "already_ready", result
        with direct_db.session() as session:
            result["segment_count"] = session.execute(
                text("SELECT count(*) FROM podcast_transcript_segments WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
    else:
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
            "contributors": [
                {
                    "credited_name": contributor["credited_name"],
                    "role": contributor["role"],
                    "source": contributor["source"],
                }
                for contributor in podcast["contributors"]
            ],
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

    from nexus.services.podcasts.poll import run_podcast_subscription_sync_now

    with direct_db.session() as session:
        sync_result = run_podcast_subscription_sync_now(
            session,
            user_id=user_id,
            podcast_id=podcast_id,
        )
        session.commit()
    assert sync_result.sync_status == "complete", sync_result

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

    from nexus.services.podcasts.transcription import run_podcast_transcription_now

    with direct_db.session() as session:
        transcription_result = run_podcast_transcription_now(
            session,
            media_id=media_id,
            requested_by_user_id=user_id,
            request_id="real-media-podcast-transcript-fixture",
        )
        session.commit()
    if transcription_result.status == "skipped":
        assert transcription_result.reason == "not_pending", transcription_result
        assert transcription_result.job_status == "completed", transcription_result
    else:
        assert transcription_result.status == "completed", transcription_result
        assert (transcription_result.segment_count or 0) > 0, transcription_result

    assert_fragment_content_contains(direct_db, media_id, "International Space Station")
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    return media_id, podcast_id, asdict(transcription_result)


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
    storage_path = build_upload_staging_storage_path(media_id, get_file_extension(kind))
    register_media_cleanup(direct_db, media_id)

    get_storage_client().put_object(storage_path, payload, content_type)
    confirm_response = auth_client.post(f"/media/{media_id}/ingest", headers=headers)
    assert confirm_response.status_code == 200, confirm_response.text
    assert confirm_response.json()["data"]["duplicate"] is False
    return media_id, build_storage_path(media_id, get_file_extension(kind))


def register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("media_source_attempts", "media_id", media_id)
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
