"""Seed the strict Playwright real-media corpus.

The seed uses the same upload, capture, URL, ingest task, transcript indexing,
storage, and embedding paths exercised by the backend real-media tests. It
writes only ids, hashes, and short expected needles to e2e/.seed/real-media.json.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from nexus.app import create_app
from nexus.config import get_settings
from nexus.storage import get_storage_client
from nexus.tasks.ingest_web_article import run_ingest_sync as run_web_article_ingest_sync
from tests.real_media.conftest import (
    FIXTURES_DIR,
    REAL_MEDIA_FIXTURES_DIR,
    capture_nasa_water_article,
    create_nasa_captioned_video,
    create_nasa_podcast_episode,
    grant_ai_plus,
)
from tests.utils.db import DirectSessionManager

ROOT = Path(__file__).parents[2]
SEED_PATH = ROOT / "e2e" / ".seed" / "real-media.json"
E2E_USER_EMAIL = os.environ.get("E2E_USER_EMAIL", "e2e-test@nexus.local")


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL must be set for make seed-real-media-e2e.")

    _ensure_real_media_prerequisites()
    engine = create_engine(database_url)
    try:
        if _existing_seed_ready(engine):
            print(f"Real-media E2E seed already ready: {SEED_PATH}")
            return

        user_id = _e2e_auth_user_id(engine)
        direct_db = DirectSessionManager(engine)

        with TestClient(create_app()) as client:
            headers = _real_auth_headers()
            me_response = client.get("/me", headers=headers)
            if me_response.status_code != 200:
                raise RuntimeError(f"Real auth bootstrap failed: {me_response.text}")
            grant_ai_plus(direct_db, user_id)

            pdf_bytes = (FIXTURES_DIR / "pdf" / "attention.pdf").read_bytes()
            assert len(pdf_bytes) == 2_215_244
            pdf_sha256 = hashlib.sha256(pdf_bytes).hexdigest()
            assert pdf_sha256 == "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697"
            pdf_media_id = _upload_seed_file_media(
                client,
                headers,
                kind="pdf",
                filename="attention.pdf",
                content_type="application/pdf",
                payload=pdf_bytes,
            )
            from nexus.tasks.ingest_pdf import ingest_pdf

            if not _media_has_index_status(engine, pdf_media_id, "ready"):
                pdf_result = ingest_pdf(str(pdf_media_id), request_id="real-media-e2e-pdf")
                if pdf_result.get("status") != "success" or pdf_result.get("has_text") is not True:
                    raise RuntimeError(f"PDF seed ingest failed: {pdf_result}")

            scanned_pdf_bytes = (
                REAL_MEDIA_FIXTURES_DIR / "frz-1784-01-03-scanned.pdf"
            ).read_bytes()
            assert len(scanned_pdf_bytes) == 827_443
            scanned_pdf_sha256 = hashlib.sha256(scanned_pdf_bytes).hexdigest()
            assert (
                scanned_pdf_sha256
                == "14b6a1729b9047a3738f23b818eac6faee80ff5a2d82731c208775a3b33a0c75"
            )
            scanned_pdf_media_id = _upload_seed_file_media(
                client,
                headers,
                kind="pdf",
                filename="frz-1784-01-03-scanned.pdf",
                content_type="application/pdf",
                payload=scanned_pdf_bytes,
            )
            if not _media_has_index_status(engine, scanned_pdf_media_id, "ocr_required"):
                scanned_pdf_result = ingest_pdf(
                    str(scanned_pdf_media_id),
                    request_id="real-media-e2e-scanned-pdf",
                )
                if (
                    scanned_pdf_result.get("status") != "success"
                    or scanned_pdf_result.get("has_text") is not False
                ):
                    raise RuntimeError(f"Scanned PDF seed ingest failed: {scanned_pdf_result}")

            epub_bytes = (FIXTURES_DIR / "epub" / "moby-dick-epub3.epub").read_bytes()
            assert len(epub_bytes) == 815_946
            epub_sha256 = hashlib.sha256(epub_bytes).hexdigest()
            assert epub_sha256 == "1215d453321c51b130e41354355ad159e48154c1e1431bc1c41d6f138f8b1556"
            epub_media_id = _upload_seed_file_media(
                client,
                headers,
                kind="epub",
                filename="moby-dick-epub3.epub",
                content_type="application/epub+zip",
                payload=epub_bytes,
            )
            from nexus.tasks.ingest_epub import ingest_epub

            if not _media_has_index_status(engine, epub_media_id, "ready"):
                epub_result = ingest_epub(str(epub_media_id), request_id="real-media-e2e-epub")
                if (
                    epub_result.get("status") != "success"
                    or int(epub_result.get("chapter_count") or 0) == 0
                ):
                    raise RuntimeError(f"EPUB seed ingest failed: {epub_result}")

            web_html = (REAL_MEDIA_FIXTURES_DIR / "nasa-water-on-moon-capture.html").read_text(
                encoding="utf-8"
            )
            web_sha256 = hashlib.sha256(web_html.encode()).hexdigest()
            assert web_sha256 == "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a"
            web_media_id = capture_nasa_water_article(client, direct_db, headers)

            web_url_response = client.post(
                "/media/from_url",
                json={
                    "url": ("https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/")
                },
                headers=headers,
            )
            if web_url_response.status_code != 202:
                raise RuntimeError(f"URL article seed create failed: {web_url_response.text}")
            web_url_media_id = UUID(web_url_response.json()["data"]["media_id"])

            with direct_db.session() as session:
                web_url_result = run_web_article_ingest_sync(
                    session,
                    web_url_media_id,
                    user_id,
                    "real-media-e2e-web-url",
                )
                session.commit()
            if web_url_result.get("status") != "success":
                raise RuntimeError(f"URL article seed ingest failed: {web_url_result}")

            caption_text = (
                REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt"
            ).read_text(encoding="utf-8")
            caption_sha256 = hashlib.sha256(caption_text.encode()).hexdigest()
            assert (
                caption_sha256 == "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237"
            )
            video_media_id, video_result = create_nasa_captioned_video(
                client, direct_db, headers, user_id
            )

            podcast_text = (REAL_MEDIA_FIXTURES_DIR / "nasa-hwhap-crew4-transcript.txt").read_text(
                encoding="utf-8"
            )
            podcast_sha256 = hashlib.sha256(podcast_text.encode()).hexdigest()
            assert (
                podcast_sha256 == "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953"
            )
            podcast_media_id, podcast_id, podcast_result = create_nasa_podcast_episode(
                client, direct_db, headers, user_id
            )

        SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
        SEED_PATH.write_text(
            json.dumps(
                {
                    "seeded_at": datetime.now(UTC).isoformat(),
                    "user_email": E2E_USER_EMAIL,
                    "fixtures": {
                        "pdf": {
                            "media_id": str(pdf_media_id),
                            "media_kind": "pdf",
                            "source_url": "https://arxiv.org/abs/1706.03762",
                            "license": "arXiv-hosted paper fixture used by existing repo tests",
                            "artifact_sha256": pdf_sha256,
                            "artifact_bytes": len(pdf_bytes),
                            "query": "attention",
                            "needle": "attention",
                        },
                        "epub": {
                            "media_id": str(epub_media_id),
                            "media_kind": "epub",
                            "source_url": "https://www.gutenberg.org/ebooks/2701",
                            "license": "Project Gutenberg public-domain ebook",
                            "artifact_sha256": epub_sha256,
                            "artifact_bytes": len(epub_bytes),
                            "query": "whale",
                            "needle": "whale",
                        },
                        "scanned_pdf": {
                            "media_id": str(scanned_pdf_media_id),
                            "media_kind": "pdf",
                            "source_url": "https://zenodo.org/records/16506766",
                            "license": "Creative Commons Zero v1.0 Universal",
                            "artifact_sha256": scanned_pdf_sha256,
                            "artifact_bytes": len(scanned_pdf_bytes),
                            "query": "Freiburger",
                            "needle": "ocr_required",
                            "retrieval_status": "ocr_required",
                        },
                        "web": {
                            "media_id": str(web_media_id),
                            "media_kind": "web_article",
                            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
                            "license": "NASA public web content",
                            "artifact_sha256": web_sha256,
                            "artifact_bytes": len(web_html.encode()),
                            "query": "SOFIA",
                            "needle": "SOFIA mission",
                        },
                        "web_url": {
                            "media_id": str(web_url_media_id),
                            "media_kind": "web_article",
                            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
                            "license": "NASA public web content",
                            "artifact_sha256": web_sha256,
                            "artifact_bytes": len(web_html.encode()),
                            "query": "SOFIA",
                            "needle": "SOFIA mission",
                            "provider_fixture": web_url_result.get("provider_fixture"),
                        },
                        "video": {
                            "media_id": str(video_media_id),
                            "media_kind": "video",
                            "source_url": "https://science.nasa.gov/earth/earth-observatory/picturing-earth-behind-the-scenes/",
                            "license": "NASA public web content",
                            "artifact_sha256": caption_sha256,
                            "artifact_bytes": len(caption_text.encode()),
                            "query": "International Space Station",
                            "needle": "International Space Station",
                            "provider_fixture": video_result.get("provider_fixture"),
                        },
                        "podcast": {
                            "media_id": str(podcast_media_id),
                            "podcast_id": str(podcast_id),
                            "media_kind": "podcast_episode",
                            "source_url": "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-crew-4-astronauts/",
                            "license": "NASA public web content",
                            "artifact_sha256": podcast_sha256,
                            "artifact_bytes": len(podcast_text.encode()),
                            "query": "International Space Station",
                            "needle": "International Space Station",
                            "provider_fixture": podcast_result.get("provider_fixture"),
                        },
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"Wrote real-media E2E seed: {SEED_PATH}")
    finally:
        engine.dispose()


def _ensure_real_media_prerequisites() -> None:
    settings = get_settings()
    if settings.nexus_env.value == "test":
        raise RuntimeError("NEXUS_ENV must be local, staging, or prod for real-media seeding.")
    if not settings.real_media_provider_fixtures:
        raise RuntimeError("REAL_MEDIA_PROVIDER_FIXTURES must be enabled for real-media seeding.")
    if not settings.real_media_fixture_dir:
        raise RuntimeError("REAL_MEDIA_FIXTURE_DIR must be set for real-media seeding.")
    if not Path(settings.real_media_fixture_dir).is_dir():
        raise RuntimeError(
            f"REAL_MEDIA_FIXTURE_DIR does not exist: {settings.real_media_fixture_dir}"
        )
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
    if not settings.enable_openai:
        raise RuntimeError("ENABLE_OPENAI must be true for real-media embeddings.")
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY must be set for real-media embeddings.")

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
            raise RuntimeError(
                "Unexpected Supabase storage bucket check response: "
                f"{bucket_response.status_code} {bucket_response.text}"
            )
        create_response = client.post(
            f"{settings.supabase_url}/storage/v1/bucket",
            headers=headers,
            json={"id": settings.storage_bucket, "name": settings.storage_bucket, "public": False},
        )
    if create_response.status_code not in (200, 201, 409):
        raise RuntimeError(
            "Failed to create Supabase storage bucket "
            f"{settings.storage_bucket!r}: {create_response.status_code} {create_response.text}"
        )


def _existing_seed_ready(engine: Engine) -> bool:
    if not SEED_PATH.exists():
        return False
    try:
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        fixtures = seed["fixtures"]
        ready_media_ids = [
            fixtures[name]["media_id"]
            for name in ("pdf", "epub", "web", "web_url", "video", "podcast")
        ]
        scanned_pdf_media_id = fixtures["scanned_pdf"]["media_id"]
    except Exception:
        return False

    with engine.connect() as conn:
        for media_id in ready_media_ids:
            row = (
                conn.execute(
                    text(
                        """
                        SELECT m.processing_status, mcis.status
                        FROM media m
                        JOIN media_content_index_states mcis ON mcis.media_id = m.id
                        WHERE m.id = :media_id
                        """
                    ),
                    {"media_id": UUID(media_id)},
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return False
            if row["processing_status"] != "ready_for_reading" or row["status"] != "ready":
                return False
        scanned_pdf_row = (
            conn.execute(
                text(
                    """
                    SELECT m.processing_status, mcis.status
                    FROM media m
                    JOIN media_content_index_states mcis ON mcis.media_id = m.id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": UUID(scanned_pdf_media_id)},
            )
            .mappings()
            .one_or_none()
        )
        if scanned_pdf_row is None:
            return False
        if (
            scanned_pdf_row["processing_status"] != "ready_for_reading"
            or scanned_pdf_row["status"] != "ocr_required"
        ):
            return False
    return True


def _media_has_index_status(engine: Engine, media_id: UUID, expected_status: str) -> bool:
    with engine.connect() as conn:
        row = (
            conn.execute(
                text(
                    """
                    SELECT m.processing_status, mcis.status
                    FROM media m
                    JOIN media_content_index_states mcis ON mcis.media_id = m.id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
    return (
        row is not None
        and row["processing_status"] == "ready_for_reading"
        and row["status"] == expected_status
    )


def _e2e_auth_user_id(engine: Engine) -> UUID:
    with engine.connect() as conn:
        user_id = conn.execute(
            text("SELECT id FROM auth.users WHERE email = :email"),
            {"email": E2E_USER_EMAIL},
        ).scalar_one_or_none()
    if user_id is None:
        raise RuntimeError("E2E auth user is missing. Run e2e/seed-e2e-user.ts first.")
    return UUID(str(user_id))


def _upload_seed_file_media(
    client: TestClient,
    headers: dict[str, str],
    *,
    kind: str,
    filename: str,
    content_type: str,
    payload: bytes,
) -> UUID:
    upload_response = client.post(
        "/media/upload/init",
        json={
            "kind": kind,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": len(payload),
        },
        headers=headers,
    )
    if upload_response.status_code != 200:
        raise RuntimeError(f"Upload init failed for {filename}: {upload_response.text}")
    upload = upload_response.json()["data"]
    storage_path = upload["storage_path"]
    get_storage_client().put_object(storage_path, payload, content_type)
    confirm_response = client.post(f"/media/{upload['media_id']}/ingest", headers=headers)
    if confirm_response.status_code != 200:
        raise RuntimeError(f"Upload confirm failed for {filename}: {confirm_response.text}")
    return UUID(confirm_response.json()["data"]["media_id"])


def _real_auth_headers() -> dict[str, str]:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")

    base_url = settings.supabase_url.rstrip("/")
    admin_headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "apikey": settings.supabase_service_key,
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        link_response = client.post(
            f"{base_url}/auth/v1/admin/generate_link",
            headers=admin_headers,
            json={
                "type": "magiclink",
                "email": E2E_USER_EMAIL,
                "options": {"redirectTo": "http://localhost:3000/libraries"},
            },
        )
        if link_response.status_code not in (200, 201):
            raise RuntimeError(
                "Failed to create Supabase magic link: "
                f"{link_response.status_code} {link_response.text}"
            )
        payload = link_response.json()
        action_link = payload.get("action_link")
        if not action_link and isinstance(payload.get("properties"), dict):
            action_link = payload["properties"].get("action_link")
        if not action_link:
            raise RuntimeError(f"Supabase magic link response missing action_link: {payload}")

        next_url = str(action_link)
        for _attempt in range(8):
            response = client.get(next_url)
            location = response.headers.get("location")
            if not location:
                break
            if location.startswith("/"):
                location = f"{base_url}{location}"
            parsed = urlparse(location)
            fragment = parse_qs(parsed.fragment)
            access_token = fragment.get("access_token", [None])[0]
            if access_token:
                return {"Authorization": f"Bearer {access_token}"}
            next_url = location

    raise RuntimeError("Supabase magic link did not return an access token.")


if __name__ == "__main__":
    main()
