#!/usr/bin/env python
"""Seed a complete Oracle reading backed by the bundled owned-plate fixture.

Hermetic, idempotent, no network / no Wikimedia. Used by the e2e CSP profile to
prove the oracle-plate owned-asset cutover end to end (spec §16 "E2E CSP"):

1) Ensures the bundled hermetic fixture plate exists in object storage by calling
   ``nexus.oracle.seed_objects.ensure_oracle_seed_objects`` (the same helper the
   prod boot path uses), so ``/api/oracle/plates/{id}`` can serve real bytes.
2) Ensures a minimal Oracle corpus version + one corpus image whose
   ``storage_key`` is the fixture's content-addressed key (sha256/byte_size/
   content_type taken from ``nexus.oracle.seed_objects``).
3) Ensures one ``complete`` reading owned by the E2E user, with ``image_id`` set,
   so ``/oracle/{reading_id}`` first-paints the plate ``<Image>`` without running
   the model / SSE stream.
4) Writes ``e2e/.seed/oracle-plate.json`` (reading_id + storage_key + image_id)
   for the Playwright spec to read.

Unlike ``create_reading`` (which gates on a fully built corpus via
``_ensure_corpus_seed_ready``), the read paths exercised by the spec
(``get_reading_detail`` + ``get_oracle_plate_bytes``) only dereference the
reading's ``image_id`` and the image's object, so a single seeded image suffices.
"""

from __future__ import annotations

# ruff: noqa: E402
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from supabase_auth_config import load_supabase_auth_config_or_exit

E2E_USER_EMAIL = os.getenv("E2E_USER_EMAIL", "e2e-test@nexus.local")
SUPABASE_URL, SUPABASE_AUTH_ADMIN_KEY = load_supabase_auth_config_or_exit()
for key in (
    "SUPABASE_AUTH_ADMIN_KEY",
    "SUPABASE_DATABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
):
    os.environ.pop(key, None)

from nexus.db.models import (
    OracleCorpusImage,
    OracleCorpusSetVersion,
    OracleReading,
)
from nexus.db.session import create_session_factory
from nexus.oracle.seed_objects import (
    FIXTURE_BYTES,
    FIXTURE_CONTENT_TYPE,
    FIXTURE_SHA256,
    FIXTURE_STORAGE_KEY,
    ensure_oracle_seed_objects,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.oracle import oracle_plate_path
from nexus.services.semantic_chunks import current_transcript_embedding_model
from nexus.storage.client import get_storage_client

# Deterministic identifiers keep the seed idempotent across reseeds.
CORPUS_VERSION = "oracle-e2e-owned-plate"
CORPUS_LABEL = "Oracle E2E owned-plate corpus"
PLATE_ARTIST = "E2E Engraver"
PLATE_WORK_TITLE = "The Owned Plate"
PLATE_YEAR = "1860"
PLATE_ATTRIBUTION = "E2E Engraver, The Owned Plate, hermetic test fixture."
PLATE_WIDTH = 800
PLATE_HEIGHT = 1200
READING_QUESTION = "What does the owned plate reveal?"
READING_FOLIO_THEME = "Of the Threshold"
READING_FOLIO_MOTTO = "Lux in Tenebris"
READING_FOLIO_MOTTO_GLOSS = "Light in the darkness."
READING_ARGUMENT = (
    "Of the engraved plate the app now owns, served from its own door rather "
    "than a distant repository."
)

SEED_FILE_RELATIVE = Path("e2e/.seed/oracle-plate.json")
SUPABASE_READY_ATTEMPTS = 8
SUPABASE_READY_DELAY_SECONDS = 1.5


def _fetch_e2e_user_id(supabase_url: str, service_key: str, email: str) -> UUID:
    """Lookup E2E auth user ID via Supabase admin API."""
    url = f"{supabase_url.rstrip('/')}/auth/v1/admin/users"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
    }
    with httpx.Client() as client:
        for page in range(1, 101):
            response = client.get(
                url,
                headers=headers,
                params={"page": page, "per_page": 100},
                timeout=30.0,
            )
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
    last_error: Exception | None = None
    for attempt in range(1, SUPABASE_READY_ATTEMPTS + 1):
        try:
            return _fetch_e2e_user_id(supabase_url, service_key, email)
        except PermissionError:
            raise
        except (RuntimeError, ValueError, httpx.HTTPError) as exc:
            last_error = exc
            if attempt == SUPABASE_READY_ATTEMPTS:
                break
            print(
                f"Fetch E2E auth user '{email}' failed "
                f"(attempt {attempt}/{SUPABASE_READY_ATTEMPTS}): {exc}. "
                f"Retrying in {SUPABASE_READY_DELAY_SECONDS:.1f}s..."
            )
            time.sleep(SUPABASE_READY_DELAY_SECONDS)
    raise RuntimeError(
        f"Fetch E2E auth user '{email}' failed after {SUPABASE_READY_ATTEMPTS} attempts"
    ) from last_error


def _release_stale_e2e_user_email(db: Session, user_id: UUID, email: str) -> None:
    db.execute(
        text("""
            UPDATE users
            SET email = 'stale-e2e-' || id::text || '@nexus.local'
            WHERE email = :email AND id != :user_id
        """),
        {"email": email, "user_id": user_id},
    )
    db.commit()


def _ensure_corpus_version(db: Session) -> UUID:
    version = db.scalar(
        select(OracleCorpusSetVersion).where(OracleCorpusSetVersion.version == CORPUS_VERSION)
    )
    if version is not None:
        return version.id
    version = OracleCorpusSetVersion(
        version=CORPUS_VERSION,
        label=CORPUS_LABEL,
        embedding_model=current_transcript_embedding_model(),
    )
    db.add(version)
    db.flush()
    return version.id


def _ensure_corpus_image(db: Session, *, corpus_set_version_id: UUID) -> UUID:
    image = db.scalar(
        select(OracleCorpusImage).where(
            OracleCorpusImage.corpus_set_version_id == corpus_set_version_id,
            OracleCorpusImage.storage_key == FIXTURE_STORAGE_KEY,
        )
    )
    if image is not None:
        return image.id
    image = OracleCorpusImage(
        corpus_set_version_id=corpus_set_version_id,
        source_repository="e2e-fixture",
        source_url="https://example.com/oracle-e2e-owned-plate.jpg",
        artist=PLATE_ARTIST,
        work_title=PLATE_WORK_TITLE,
        year=PLATE_YEAR,
        attribution_text=PLATE_ATTRIBUTION,
        width=PLATE_WIDTH,
        height=PLATE_HEIGHT,
        storage_key=FIXTURE_STORAGE_KEY,
        content_type=FIXTURE_CONTENT_TYPE,
        byte_size=FIXTURE_BYTES,
        sha256=FIXTURE_SHA256,
        tags=["forest", "lamp"],
    )
    db.add(image)
    db.flush()
    return image.id


def _ensure_complete_reading(
    db: Session,
    *,
    user_id: UUID,
    corpus_set_version_id: UUID,
    image_id: UUID,
) -> UUID:
    """Insert (or reuse) one complete reading pinned to the owned-plate image."""
    existing = db.scalar(
        select(OracleReading).where(
            OracleReading.user_id == user_id,
            OracleReading.question_text == READING_QUESTION,
        )
    )
    if existing is not None:
        # Keep the row pinned to the fixture image even if a prior reseed pointed
        # it elsewhere, so the spec always renders the owned plate.
        existing.image_id = image_id
        existing.status = "complete"
        if existing.completed_at is None:
            existing.completed_at = datetime.now(UTC)
        db.commit()
        return existing.id

    max_folio = db.scalar(
        select(OracleReading.folio_number)
        .where(OracleReading.user_id == user_id)
        .order_by(OracleReading.folio_number.desc())
        .limit(1)
    )
    next_folio = (max_folio or 0) + 1
    now = datetime.now(UTC)
    reading = OracleReading(
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        folio_number=next_folio,
        folio_motto=READING_FOLIO_MOTTO,
        folio_motto_gloss=READING_FOLIO_MOTTO_GLOSS,
        folio_theme=READING_FOLIO_THEME,
        argument_text=READING_ARGUMENT,
        question_text=READING_QUESTION,
        status="complete",
        prompt_version="oracle-v3",
        image_id=image_id,
        started_at=now,
        completed_at=now,
    )
    db.add(reading)
    db.commit()
    return reading.id


def _write_seed_file(*, reading_id: UUID, image_id: UUID) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    seed_path = repo_root / SEED_FILE_RELATIVE
    seed_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "reading_id": str(reading_id),
        "image_id": str(image_id),
        "storage_key": FIXTURE_STORAGE_KEY,
        "plate_route": oracle_plate_path(image_id),
    }
    seed_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote Oracle owned-plate seed: {seed_path}")


def main() -> None:
    nexus_env = os.getenv("NEXUS_ENV", "local")
    if nexus_env not in ("local", "test"):
        print(f"ERROR: seed_oracle_plate_e2e.py refuses to run in NEXUS_ENV={nexus_env}")
        sys.exit(1)

    if not os.getenv("DATABASE_URL"):
        print("ERROR: DATABASE_URL must be set")
        sys.exit(1)

    missing_r2 = [
        key
        for key in ("R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
        if not os.environ.get(key)
    ]
    if missing_r2:
        print(f"ERROR: Cloudflare R2 storage env is required: {', '.join(missing_r2)}")
        sys.exit(1)

    # Step 1: guarantee the bundled fixture plate exists in object storage.
    ensure_oracle_seed_objects(get_storage_client())

    user_id = _fetch_e2e_user_id_with_retry(
        supabase_url=SUPABASE_URL,
        service_key=SUPABASE_AUTH_ADMIN_KEY,
        email=E2E_USER_EMAIL,
    )

    session_factory = create_session_factory()
    with session_factory() as db:
        _release_stale_e2e_user_email(db, user_id, E2E_USER_EMAIL)
        ensure_user_and_default_library(db, user_id, email=E2E_USER_EMAIL)
        corpus_set_version_id = _ensure_corpus_version(db)
        image_id = _ensure_corpus_image(db, corpus_set_version_id=corpus_set_version_id)
        db.commit()
        reading_id = _ensure_complete_reading(
            db,
            user_id=user_id,
            corpus_set_version_id=corpus_set_version_id,
            image_id=image_id,
        )

    _write_seed_file(reading_id=reading_id, image_id=image_id)
    print(f"Seeded Oracle owned-plate reading for E2E: {reading_id}")


if __name__ == "__main__":
    main()
