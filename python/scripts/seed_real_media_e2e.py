"""Seed the strict Playwright real-media corpus.

The seed uses the same upload, capture, URL, ingest task, transcript indexing,
storage, and embedding paths exercised by the backend real-media tests. It
writes only ids, hashes, and short expected needles to e2e/.seed/real-media.json.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import NotRequired, TypedDict
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from supabase_auth_config import load_supabase_auth_config

from nexus.app import create_app
from nexus.config import get_settings
from nexus.services.semantic_chunks import current_transcript_embedding_provider
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_staging_storage_path, get_file_extension
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
NON_LOCAL_STORAGE_OPT_IN = "REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE"


class ExpectedSeedFixture(TypedDict):
    path: Path
    sha256: str
    query: str
    needle: str
    kind: str
    index_status: str
    storage: bool
    content_type: NotRequired[str]
    size_bytes: NotRequired[int]


EXPECTED_SEED_FIXTURES: dict[str, ExpectedSeedFixture] = {
    "pdf": {
        "path": FIXTURES_DIR / "pdf" / "attention.pdf",
        "sha256": "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
        "query": "attention",
        "needle": "attention",
        "kind": "pdf",
        "index_status": "ready",
        "storage": True,
        "content_type": "application/pdf",
        "size_bytes": 2_215_244,
    },
    "epub": {
        "path": FIXTURES_DIR / "epub" / "moby-dick-epub3.epub",
        "sha256": "1215d453321c51b130e41354355ad159e48154c1e1431bc1c41d6f138f8b1556",
        "query": "whale",
        "needle": "whale",
        "kind": "epub",
        "index_status": "ready",
        "storage": True,
        "content_type": "application/epub+zip",
        "size_bytes": 815_946,
    },
    "scanned_pdf": {
        "path": REAL_MEDIA_FIXTURES_DIR / "frz-1784-01-03-scanned.pdf",
        "sha256": "14b6a1729b9047a3738f23b818eac6faee80ff5a2d82731c208775a3b33a0c75",
        "query": "Freiburger",
        "needle": "ocr_required",
        "kind": "pdf",
        "index_status": "ocr_required",
        "storage": True,
        "content_type": "application/pdf",
        "size_bytes": 827_443,
    },
    "web": {
        "path": REAL_MEDIA_FIXTURES_DIR / "nasa-water-on-moon-capture.html",
        "sha256": "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a",
        "query": "SOFIA",
        "needle": "SOFIA mission",
        "kind": "web_article",
        "index_status": "ready",
        "storage": False,
    },
    "web_url": {
        "path": REAL_MEDIA_FIXTURES_DIR / "nasa-water-on-moon-capture.html",
        "sha256": "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a",
        "query": "SOFIA",
        "needle": "SOFIA mission",
        "kind": "web_article",
        "index_status": "ready",
        "storage": False,
    },
    "video": {
        "path": REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt",
        "sha256": "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237",
        "query": "International Space Station",
        "needle": "International Space Station",
        "kind": "video",
        "index_status": "ready",
        "storage": False,
    },
    "podcast": {
        "path": REAL_MEDIA_FIXTURES_DIR / "nasa-hwhap-crew4-transcript.txt",
        "sha256": "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953",
        "query": "International Space Station",
        "needle": "International Space Station",
        "kind": "podcast_episode",
        "index_status": "ready",
        "storage": False,
    },
}


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL must be set for make seed-real-media-e2e.")

    supabase_url, supabase_auth_admin_key = load_supabase_auth_config()
    for key in (
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SERVICE_ROLE_KEY",
    ):
        os.environ.pop(key, None)
    _ensure_real_media_prerequisites()

    user_id = _fetch_e2e_user_id_with_retry(
        supabase_url,
        supabase_auth_admin_key,
        E2E_USER_EMAIL,
    )

    engine = create_engine(database_url)
    try:
        _release_stale_e2e_user_email(engine, user_id, E2E_USER_EMAIL)
        direct_db = DirectSessionManager(engine)

        with TestClient(create_app()) as client:
            headers = _real_auth_headers(supabase_url, supabase_auth_admin_key)
            default_library_id = _ensure_e2e_viewer(client, headers, user_id)
            grant_ai_plus(direct_db, user_id)

            if _existing_seed_ready(engine, user_id, default_library_id):
                print(f"Real-media E2E seed already ready: {SEED_PATH}")
                return
            SEED_PATH.unlink(missing_ok=True)

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

            web_bytes = (REAL_MEDIA_FIXTURES_DIR / "nasa-water-on-moon-capture.html").read_bytes()
            web_sha256 = hashlib.sha256(web_bytes).hexdigest()
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
            if web_url_result.get("status") == "deduped":
                canonical_url = web_url_result.get("canonical_url")
                if not isinstance(canonical_url, str) or not canonical_url:
                    raise RuntimeError(f"URL article seed dedupe missing URL: {web_url_result}")
                with engine.connect() as conn:
                    existing_web_url_media_id = conn.execute(
                        text(
                            """
                            SELECT m.id
                            FROM media m
                            JOIN media_content_index_states mcis ON mcis.media_id = m.id
                            WHERE m.kind = 'web_article'
                              AND m.created_by_user_id = :user_id
                              AND m.canonical_url = :canonical_url
                              AND m.processing_status = 'ready_for_reading'
                              AND mcis.status = 'ready'
                              AND EXISTS (
                                  SELECT 1
                                  FROM library_entries le
                                  WHERE le.library_id = :default_library_id
                                    AND le.media_id = m.id
                              )
                              AND EXISTS (
                                  SELECT 1
                                  FROM default_library_intrinsics dli
                                  WHERE dli.default_library_id = :default_library_id
                                    AND dli.media_id = m.id
                              )
                            LIMIT 1
                            """
                        ),
                        {
                            "canonical_url": canonical_url,
                            "user_id": user_id,
                            "default_library_id": default_library_id,
                        },
                    ).scalar_one_or_none()
                if existing_web_url_media_id is None:
                    raise RuntimeError(
                        "URL article seed deduped to media outside the E2E user/default-library "
                        f"contract: {web_url_result}"
                    )
                web_url_media_id = UUID(str(existing_web_url_media_id))
            elif web_url_result.get("status") != "success":
                raise RuntimeError(f"URL article seed ingest failed: {web_url_result}")

            caption_bytes = (
                REAL_MEDIA_FIXTURES_DIR / "nasa-picturing-earth-behind-scenes-captions.srt"
            ).read_bytes()
            caption_sha256 = hashlib.sha256(caption_bytes).hexdigest()
            assert (
                caption_sha256 == "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237"
            )
            video_media_id, _video_result = create_nasa_captioned_video(
                client, direct_db, headers, user_id
            )

            podcast_bytes = (
                REAL_MEDIA_FIXTURES_DIR / "nasa-hwhap-crew4-transcript.txt"
            ).read_bytes()
            podcast_sha256 = hashlib.sha256(podcast_bytes).hexdigest()
            assert (
                podcast_sha256 == "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953"
            )
            podcast_media_id, _podcast_id, _podcast_result = create_nasa_podcast_episode(
                client, direct_db, headers, user_id
            )

        SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
        SEED_PATH.write_text(
            json.dumps(
                {
                    "fixtures": {
                        "pdf": {
                            "media_id": str(pdf_media_id),
                            "artifact_sha256": pdf_sha256,
                            "query": "attention",
                            "needle": "attention",
                        },
                        "epub": {
                            "media_id": str(epub_media_id),
                            "artifact_sha256": epub_sha256,
                            "query": "whale",
                            "needle": "whale",
                        },
                        "scanned_pdf": {
                            "media_id": str(scanned_pdf_media_id),
                            "artifact_sha256": scanned_pdf_sha256,
                            "query": "Freiburger",
                            "needle": "ocr_required",
                        },
                        "web": {
                            "media_id": str(web_media_id),
                            "artifact_sha256": web_sha256,
                            "query": "SOFIA",
                            "needle": "SOFIA mission",
                        },
                        "web_url": {
                            "media_id": str(web_url_media_id),
                            "artifact_sha256": web_sha256,
                            "query": "SOFIA",
                            "needle": "SOFIA mission",
                        },
                        "video": {
                            "media_id": str(video_media_id),
                            "artifact_sha256": caption_sha256,
                            "query": "International Space Station",
                            "needle": "International Space Station",
                        },
                        "podcast": {
                            "media_id": str(podcast_media_id),
                            "artifact_sha256": podcast_sha256,
                            "query": "International Space Station",
                            "needle": "International Space Station",
                        },
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        if not _existing_seed_ready(engine, user_id, default_library_id):
            raise RuntimeError("Real-media E2E seed wrote but readiness verification failed.")
        print(f"Wrote real-media E2E seed: {SEED_PATH}")
    finally:
        engine.dispose()


def _ensure_real_media_prerequisites() -> None:
    settings = get_settings()
    if settings.nexus_env.value == "test":
        raise RuntimeError("NEXUS_ENV must be local for real-media seeding.")
    if not settings.real_media_provider_fixtures:
        raise RuntimeError("REAL_MEDIA_PROVIDER_FIXTURES must be enabled for real-media seeding.")
    if not settings.real_media_fixture_dir:
        raise RuntimeError("REAL_MEDIA_FIXTURE_DIR must be set for real-media seeding.")
    if not Path(settings.real_media_fixture_dir).is_dir():
        raise RuntimeError(
            f"REAL_MEDIA_FIXTURE_DIR does not exist: {settings.real_media_fixture_dir}"
        )
    missing_r2 = [
        key
        for key in ("R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
        if not os.environ.get(key)
    ]
    if missing_r2:
        raise RuntimeError(f"Cloudflare R2 storage env is required: {', '.join(missing_r2)}")
    if settings.nexus_env.value == "local" and os.environ.get(NON_LOCAL_STORAGE_OPT_IN) != "1":
        endpoint_url = settings.r2_endpoint_url or os.environ.get("R2_ENDPOINT_URL") or ""
        if not _is_local_storage_endpoint(endpoint_url):
            raise RuntimeError(
                "Refusing local real-media seeding against non-local R2/MinIO endpoint "
                f"{endpoint_url!r}. Set {NON_LOCAL_STORAGE_OPT_IN}=1 to opt in explicitly."
            )
    if current_transcript_embedding_provider() != "fixture":
        raise RuntimeError("Real-media seeding requires deterministic fixture_hash_v1 embeddings.")


def _existing_seed_ready(engine: Engine, user_id: UUID, default_library_id: UUID) -> bool:
    if not SEED_PATH.exists():
        return False
    try:
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        if set(seed) != {"fixtures"}:
            return False
        fixtures = seed["fixtures"]
        if set(fixtures) != set(EXPECTED_SEED_FIXTURES):
            return False
        media_ids: dict[str, UUID] = {}
        for name, fixture in fixtures.items():
            if set(fixture) != {"media_id", "artifact_sha256", "query", "needle"}:
                return False
            expected = EXPECTED_SEED_FIXTURES[name]
            if fixture["artifact_sha256"] != expected["sha256"]:
                return False
            if fixture["query"] != expected["query"] or fixture["needle"] != expected["needle"]:
                return False
            expected_hash = hashlib.sha256(Path(expected["path"]).read_bytes()).hexdigest()
            if expected_hash != expected["sha256"]:
                raise RuntimeError(f"Fixture hash changed for {expected['path']}")
            media_ids[name] = UUID(str(fixture["media_id"]))
        if len(set(media_ids.values())) != len(media_ids):
            return False
    except RuntimeError:
        raise
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return False

    try:
        storage_client = get_storage_client()
        with engine.connect() as conn:
            user_row = (
                conn.execute(
                    text(
                        """
                        SELECT
                            EXISTS(
                                SELECT 1
                                FROM users u
                                WHERE u.id = :user_id
                            ) AS user_exists,
                            EXISTS(
                                SELECT 1
                                FROM libraries l
                                JOIN memberships ms
                                  ON ms.library_id = l.id
                                 AND ms.user_id = :user_id
                                 AND ms.role = 'admin'
                                WHERE l.id = :default_library_id
                                  AND l.owner_user_id = :user_id
                                  AND l.is_default = true
                            ) AS default_library_ready
                        """
                    ),
                    {"user_id": user_id, "default_library_id": default_library_id},
                )
                .mappings()
                .one()
            )
            if not user_row["user_exists"] or not user_row["default_library_ready"]:
                return False

            for name, media_id in media_ids.items():
                expected = EXPECTED_SEED_FIXTURES[name]
                row = (
                    conn.execute(
                        text(
                            """
                            SELECT
                                m.kind,
                                m.created_by_user_id,
                                m.processing_status,
                                m.file_sha256,
                                mf.storage_path,
                                mf.content_type,
                                mf.size_bytes,
                                mcis.status,
                                mcis.active_run_id,
                                mcis.latest_run_id,
                                active_run.state AS active_run_state,
                                active_run.deactivated_at AS active_run_deactivated_at,
                                latest_run.state AS latest_run_state,
                                EXISTS(
                                    SELECT 1
                                    FROM library_entries le
                                    WHERE le.library_id = :default_library_id
                                      AND le.media_id = m.id
                                ) AS has_default_library_entry,
                                EXISTS(
                                    SELECT 1
                                    FROM default_library_intrinsics dli
                                    WHERE dli.default_library_id = :default_library_id
                                      AND dli.media_id = m.id
                                ) AS has_default_intrinsic,
                                (
                                    SELECT count(*)
                                    FROM source_snapshots ss
                                    WHERE ss.media_id = m.id
                                      AND ss.index_run_id = mcis.latest_run_id
                                ) AS source_snapshot_count,
                                (
                                    SELECT count(*)
                                    FROM content_chunks cc
                                    WHERE cc.media_id = m.id
                                      AND cc.index_run_id = mcis.active_run_id
                                ) AS chunk_count,
                                (
                                    SELECT count(*)
                                    FROM evidence_spans es
                                    WHERE es.media_id = m.id
                                      AND es.index_run_id = mcis.active_run_id
                                ) AS evidence_count,
                                (
                                    SELECT count(*)
                                    FROM content_embeddings ce
                                    JOIN content_chunks cc ON cc.id = ce.chunk_id
                                    WHERE cc.media_id = m.id
                                      AND cc.index_run_id = mcis.active_run_id
                                ) AS embedding_count,
                                (
                                    SELECT count(*)
                                    FROM content_chunks cc
                                    WHERE cc.media_id = m.id
                                      AND cc.index_run_id = mcis.active_run_id
                                      AND cc.chunk_text ILIKE :needle
                                ) AS needle_chunk_count
                            FROM media m
                            LEFT JOIN media_file mf ON mf.media_id = m.id
                            LEFT JOIN media_content_index_states mcis ON mcis.media_id = m.id
                            LEFT JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                            LEFT JOIN content_index_runs latest_run ON latest_run.id = mcis.latest_run_id
                            WHERE m.id = :media_id
                            """
                        ),
                        {
                            "media_id": media_id,
                            "user_id": user_id,
                            "default_library_id": default_library_id,
                            "needle": f"%{expected['needle']}%",
                        },
                    )
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    return False
                if row["kind"] != expected["kind"]:
                    return False
                if row["created_by_user_id"] != user_id:
                    return False
                if not row["has_default_library_entry"] or not row["has_default_intrinsic"]:
                    return False
                if row["processing_status"] != "ready_for_reading":
                    return False
                if row["status"] != expected["index_status"]:
                    return False
                if row["latest_run_id"] is None or int(row["source_snapshot_count"] or 0) == 0:
                    return False

                if expected["index_status"] == "ready":
                    if row["active_run_id"] is None or row["active_run_id"] != row["latest_run_id"]:
                        return False
                    if row["active_run_state"] != "ready" or row["active_run_deactivated_at"]:
                        return False
                    if int(row["chunk_count"] or 0) == 0:
                        return False
                    if int(row["evidence_count"] or 0) == 0:
                        return False
                    if int(row["embedding_count"] or 0) == 0:
                        return False
                    if int(row["needle_chunk_count"] or 0) == 0:
                        return False
                elif expected["index_status"] == "ocr_required":
                    if row["latest_run_state"] != "ocr_required":
                        return False
                    if row["active_run_id"] is not None:
                        return False
                    if int(row["chunk_count"] or 0) != 0:
                        return False
                    if int(row["evidence_count"] or 0) != 0:
                        return False

                if expected["storage"]:
                    expected_content_type = expected.get("content_type")
                    expected_size_bytes = expected.get("size_bytes")
                    if expected_content_type is None or expected_size_bytes is None:
                        return False
                    if not row["storage_path"]:
                        return False
                    if row["file_sha256"] != expected["sha256"]:
                        return False
                    if row["content_type"] != expected_content_type:
                        return False
                    if int(row["size_bytes"] or 0) != expected_size_bytes:
                        return False
                    metadata = storage_client.head_object(str(row["storage_path"]))
                    if metadata is None:
                        return False
                    if metadata.size_bytes != expected_size_bytes:
                        return False
                    if metadata.content_type != expected_content_type:
                        return False
                elif row["storage_path"] is not None:
                    return False
    except Exception:
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


def _fetch_e2e_user_id(supabase_url: str, service_key: str, email: str) -> UUID:
    url = f"{supabase_url.rstrip('/')}/auth/v1/admin/users"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
    }
    with httpx.Client(timeout=30.0) as client:
        for page in range(1, 101):
            response = client.get(url, headers=headers, params={"page": page, "per_page": 100})
            if response.status_code in (401, 403):
                raise PermissionError(
                    "Supabase admin auth rejected while listing users: "
                    f"{response.status_code} {response.text}"
                )
            if response.status_code != 200:
                raise RuntimeError(
                    f"Failed to list auth users: {response.status_code} {response.text}"
                )

            users = response.json().get("users", [])
            for user in users:
                if user.get("email") == email:
                    return UUID(user["id"])
            if len(users) < 100:
                break

    raise RuntimeError(f"E2E auth user not found for {email}. Run e2e/seed-e2e-user.ts first.")


def _fetch_e2e_user_id_with_retry(supabase_url: str, service_key: str, email: str) -> UUID:
    user_id: UUID | None = None
    last_error: Exception | None = None
    # justify-polling: Supabase Auth user creation happens in the preceding
    # Node seed process; the admin list endpoint can lag briefly.
    for attempt in range(1, 9):
        try:
            user_id = _fetch_e2e_user_id(supabase_url, service_key, email)
            break
        except (RuntimeError, ValueError, httpx.HTTPError) as exc:
            last_error = exc
            if attempt == 8:
                break
            print(
                f"Fetch E2E auth user '{email}' failed "
                f"(attempt {attempt}/8): {exc}. Retrying in 1.5s..."
            )
            time.sleep(1.5)
    if user_id is None:
        raise RuntimeError(f"Fetch E2E auth user '{email}' failed after 8 attempts") from last_error
    return user_id


def _ensure_e2e_viewer(
    client: TestClient,
    headers: dict[str, str],
    expected_user_id: UUID,
) -> UUID:
    me_response = client.get("/me", headers=headers)
    if me_response.status_code != 200:
        raise RuntimeError(f"Real auth bootstrap failed: {me_response.text}")
    data = me_response.json()["data"]
    user_id = UUID(str(data["user_id"]))
    if user_id != expected_user_id:
        raise RuntimeError(
            f"Real auth bootstrap resolved user {user_id}, expected {expected_user_id}."
        )
    return UUID(str(data["default_library_id"]))


def _release_stale_e2e_user_email(engine: Engine, user_id: UUID, email: str) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""
                UPDATE users
                SET email = 'stale-e2e-' || id::text || '@nexus.local'
                WHERE email = :email AND id != :user_id
            """),
            {"email": email, "user_id": user_id},
        )


def _is_local_storage_endpoint(endpoint_url: str) -> bool:
    try:
        host = urlparse(endpoint_url).hostname or ""
    except ValueError:
        return False
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0", "minio"} or host.endswith(
        ".localhost"
    )


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
    storage_path = build_upload_staging_storage_path(
        UUID(upload["media_id"]),
        get_file_extension(kind),
    )
    get_storage_client().put_object(storage_path, payload, content_type)
    confirm_response = client.post(f"/media/{upload['media_id']}/ingest", headers=headers)
    if confirm_response.status_code != 200:
        raise RuntimeError(f"Upload confirm failed for {filename}: {confirm_response.text}")
    return UUID(confirm_response.json()["data"]["media_id"])


def _real_auth_headers(supabase_url: str, supabase_auth_admin_key: str) -> dict[str, str]:
    base_url = supabase_url.rstrip("/")
    app_base_url = (
        os.environ.get("APP_PUBLIC_URL") or f"http://localhost:{os.environ.get('WEB_PORT', '3000')}"
    )
    admin_headers = {
        "Authorization": f"Bearer {supabase_auth_admin_key}",
        "apikey": supabase_auth_admin_key,
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        link_response = client.post(
            f"{base_url}/auth/v1/admin/generate_link",
            headers=admin_headers,
            json={
                "type": "magiclink",
                "email": E2E_USER_EMAIL,
                "options": {"redirectTo": f"{app_base_url.rstrip('/')}/libraries"},
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
