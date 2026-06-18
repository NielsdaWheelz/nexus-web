"""Seed or repair the Oracle Corpus library, media, anchors, and plates.

Ensures the Oracle Corpus system library, accepts each manifest work's media through the
shared durable source-ingest path, attaches it to the corpus library, upserts passage
anchors, seeds public-domain plates into R2, then (with ``--drain``) runs pending ingest
jobs inline before resolving anchors against the indexed text. Exits non-zero unless the
corpus is ready. Idempotent: re-running updates the current intended state.

Needs the R2 storage env (R2_S3_API_ORIGIN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
R2_BUCKET) to seed plates.

Run:
  cd python
  uv run python ../scripts/oracle/seed_corpus_library.py --owner-user <user-id> --drain
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.jobs.worker import JobWorker
from nexus.services import oracle_corpus, oracle_plates
from nexus.services.image_validation import fetch_validated_image
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.storage.paths import ext_for_content_type

MANIFEST_DIR = Path(__file__).resolve().parent
WORKS_PATH = MANIFEST_DIR / "manifest_works.json"
PLATES_PATH = MANIFEST_DIR / "manifest_plates.json"
PLATE_FETCH_MAX_ATTEMPTS = 6
PLATE_FETCH_RETRY_BASE_SECONDS = 10.0
PLATE_FETCH_RETRY_MAX_SECONDS = 60.0
PLATE_FETCH_SUCCESS_DELAY_SECONDS = 2.0
_RETRYABLE_PLATE_FETCH_STATUSES = ("status 429", "status 502", "status 503", "status 504")


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Oracle Corpus library.")
    parser.add_argument("--owner-user", required=True, type=UUID, help="bootstrap/owner user id")
    parser.add_argument(
        "--drain",
        action="store_true",
        help="run pending ingest jobs inline before resolving anchors",
    )
    args = parser.parse_args()

    works = [
        oracle_corpus.OracleCorpusManifestWork.model_validate(entry)
        for entry in json.loads(WORKS_PATH.read_text())
    ]
    plates: list[dict[str, Any]] = (
        json.loads(PLATES_PATH.read_text()) if PLATES_PATH.exists() else []
    )
    session_factory = get_session_factory()

    storage_client = get_storage_client()

    with session_factory() as db:
        library_id = oracle_corpus.ensure_oracle_corpus_library(db, owner_user_id=args.owner_user)
        db.commit()
        for work in works:
            result = oracle_corpus.ensure_oracle_corpus_media(
                db, owner_user_id=args.owner_user, library_id=library_id, work=work
            )
            db.commit()
            print(
                f"  work {result.work_key}: media {result.media_id} "
                f"({'created' if result.created_media else 'reused'}), "
                f"{result.anchor_count} anchors"
            )

    if plates:
        with httpx.Client(timeout=30.0, headers={"User-Agent": "nexus-oracle-seed"}) as client:
            with session_factory() as db:
                _seed_plates(db, client, storage_client, plates)
                db.commit()

    if args.drain:
        print("draining ingest jobs...")
        worker = JobWorker(
            session_factory=session_factory,
            worker_id="oracle-seed-drain",
            allowed_kinds=("ingest_media_source",),
        )
        while worker.run_once():
            pass

    with session_factory() as db:
        resolution = oracle_corpus.resolve_oracle_passage_anchors(db)
        db.commit()
        print(
            f"anchors: {resolution.resolved}/{resolution.total} resolved, {resolution.failed} failed"
        )
        readiness = oracle_corpus.get_oracle_corpus_readiness(db)
        plate_storage = oracle_plates.validate_oracle_plate_storage_objects(
            db, storage_client=storage_client
        )

    _print_readiness(readiness)
    print(f"plate objects: {plate_storage.valid}/{plate_storage.total} valid")
    for invalid in plate_storage.invalid:
        print(f"  invalid plate object: {invalid}")
    return 0 if readiness.status == "ready" and plate_storage.ready else 1


def _seed_plates(
    db: Any, client: httpx.Client, storage: StorageClientBase, manifest: list[dict[str, Any]]
) -> None:
    """Download, validate, upload, and upsert each plate (no embeddings)."""
    for entry in manifest:
        resolved = entry["resolved_source_url"]
        validated = _fetch_plate_image(resolved, client)
        storage_key = _plate_storage_key(entry, content_type=validated.content_type)
        if storage.head_object(storage_key) is None:
            storage.put_object(storage_key, validated.data, validated.content_type)
        time.sleep(PLATE_FETCH_SUCCESS_DELAY_SECONDS)
        plate = oracle_plates.upsert_oracle_plate(
            db,
            source_repository=entry["source_repository"],
            source_page_url=entry["source_url"],
            source_url=resolved,
            license_text=str(entry.get("license_text") or "public domain"),
            artist=entry["artist"],
            work_title=entry["work_title"],
            year=entry.get("year"),
            attribution_text=entry["attribution_text"],
            width=validated.width,
            height=validated.height,
            storage_key=storage_key,
            content_type=validated.content_type,
            byte_size=len(validated.data),
            tags=list(entry.get("tags") or []),
        )
        print(f"  plate {entry['work_title']!r}: {storage_key} ({plate.id})")


def _fetch_plate_image(resolved_source_url: str, client: httpx.Client):
    for attempt in range(1, PLATE_FETCH_MAX_ATTEMPTS + 1):
        try:
            return fetch_validated_image(resolved_source_url, client)
        except ApiError as exc:
            if not _is_retryable_plate_fetch_error(exc) or attempt >= PLATE_FETCH_MAX_ATTEMPTS:
                raise
            delay = _plate_fetch_retry_delay(exc, attempt=attempt)
            print(
                "  plate source temporarily unavailable; "
                f"retrying in {delay:g}s ({attempt}/{PLATE_FETCH_MAX_ATTEMPTS})"
            )
            time.sleep(delay)
    raise RuntimeError(f"Could not fetch Oracle plate source: {resolved_source_url}")


def _is_retryable_plate_fetch_error(exc: ApiError) -> bool:
    return any(marker in exc.message for marker in _RETRYABLE_PLATE_FETCH_STATUSES)


def _plate_fetch_retry_delay(exc: ApiError, *, attempt: int) -> float:
    if exc.retry_after_seconds is not None:
        return float(max(1, exc.retry_after_seconds))
    delay = PLATE_FETCH_RETRY_BASE_SECONDS * (2 ** (attempt - 1))
    return min(delay, PLATE_FETCH_RETRY_MAX_SECONDS)


def _plate_storage_key(entry: dict[str, Any], *, content_type: str) -> str:
    ext = ext_for_content_type(content_type)
    parsed = urllib.parse.urlparse(str(entry["source_url"]))
    source_name = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
    if source_name.startswith("File:"):
        source_name = source_name.removeprefix("File:")
    stem = source_name.rsplit(".", 1)[0] or str(entry["work_title"])
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    if not slug:
        raise RuntimeError(f"Could not derive Oracle plate storage key for {entry['source_url']}")
    return f"oracle/plates/{slug}.{ext}"


def _print_readiness(r: oracle_corpus.OracleCorpusReadiness) -> None:
    print(
        f"corpus {r.status}: library {r.library_id}, "
        f"{r.ready_media_count}/{r.work_count} media ready, "
        f"{r.resolved_anchor_count}/{r.anchor_count} anchors resolved, "
        f"{r.ready_plate_count}/{r.plate_count} safe plates"
    )


if __name__ == "__main__":
    sys.exit(main())
