"""Project Gutenberg catalog mirror utilities."""

from __future__ import annotations

import csv
import gzip
import re
from datetime import UTC, date, datetime
from io import StringIO
from typing import Any

import httpx
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from nexus.db.models import ProjectGutenbergCatalogEntry
from nexus.db.session import transaction
from nexus.services import contributors
from nexus.services.contributor_credits import current_gutenberg_author_names
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    ObservedRoleSlices,
    RawCreditEntry,
    build_observation,
)

_CATALOG_FEED_URLS: tuple[str, ...] = (
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz",
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
)
_CATALOG_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
_INSERT_BATCH_SIZE = 1000
_GUTENBERG_CREDIT_SOURCE = "project_gutenberg_catalog"
# Catalog columns refreshed on an ON CONFLICT UPDATE (never created_at / ebook_id).
_CATALOG_UPSERT_COLUMNS: tuple[str, ...] = (
    "title",
    "gutenberg_type",
    "issued",
    "language",
    "subjects",
    "locc",
    "bookshelves",
    "copyright_status",
    "download_count",
    "raw_metadata",
    "synced_at",
    "updated_at",
)


def sync_project_gutenberg_catalog(
    db: Session,
    *,
    source_urls: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Fetch the official catalog feed and reconcile the local mirror (D-15).

    Upsert-based: the catalog transaction inserts new rows, updates existing ones,
    and deletes removed ebooks (dropping their credits first via the deletion
    cleanup hook so the credit FK holds). Author credits are then replaced only
    for new or author-changed ebooks, on the facade's own fresh sessions after the
    catalog transaction commits — unchanged ebooks perform zero credit DML. The
    catalog and author writes never share a transaction (spec §2.7 / D-22).
    """
    resolved_source_urls = source_urls or _CATALOG_FEED_URLS
    source_url, payload = download_project_gutenberg_catalog_feed(source_urls=resolved_source_urls)
    synced_at = datetime.now(UTC)
    rows = parse_project_gutenberg_catalog_feed(payload, synced_at=synced_at)

    # Build one observation per parsed ebook up front (pure): it both drives the
    # author-change comparison and is the payload for the batched author op.
    observations: dict[int, ContributorObservationBatch] = {}
    expected_names: dict[int, tuple[str, ...]] = {}
    for row in rows:
        ebook_id = int(row["ebook_id"])
        observation, _truncation = build_observation({"author": _gutenberg_author_entries(row)})
        observations[ebook_id] = observation
        expected_names[ebook_id] = (
            tuple(credit.credited_name for credit in observation.credits)
            if isinstance(observation, ObservedRoleSlices)
            else ()
        )
    parsed_ids = set(observations)

    with transaction(db):
        current_ids = set(db.scalars(select(ProjectGutenbergCatalogEntry.ebook_id)).all())
        removed_ids = current_ids - parsed_ids
        existing_ids = current_ids & parsed_ids

        # Author-changed set: every new ebook, plus existing ebooks whose parsed
        # author names differ from the stored slice. One bulk read of current names.
        stored_names = current_gutenberg_author_names(db, list(existing_ids))
        changed_ids = parsed_ids - current_ids
        for ebook_id in existing_ids:
            if expected_names.get(ebook_id, ()) != stored_names.get(ebook_id, ()):
                changed_ids.add(ebook_id)

        # Drop removed ebooks: credits (+ orphan prune) before the catalog row so
        # the credit FK holds. cleanup runs on this deletion transaction (spec §3).
        for ebook_id in removed_ids:
            contributors.cleanup_credits_for_deleted_target(
                db, target=contributors.GutenbergTarget(ebook_id)
            )
        if removed_ids:
            db.execute(
                delete(ProjectGutenbergCatalogEntry).where(
                    ProjectGutenbergCatalogEntry.ebook_id.in_(removed_ids)
                )
            )

        for start in range(0, len(rows), _INSERT_BATCH_SIZE):
            batch = rows[start : start + _INSERT_BATCH_SIZE]
            if not batch:
                continue
            stmt = pg_insert(ProjectGutenbergCatalogEntry).values(batch)
            db.execute(
                stmt.on_conflict_do_update(
                    index_elements=["ebook_id"],
                    set_={column: stmt.excluded[column] for column in _CATALOG_UPSERT_COLUMNS},
                )
            )

    # Author replacement runs only for new/changed ebooks, after the catalog
    # transaction has committed — the facade opens its own fresh sessions and
    # chunks the work (D-15). NOT_OBSERVED targets are filtered out (no erase).
    contributors.replace_observed_role_slices_batch(
        [
            (
                contributors.GutenbergTarget(ebook_id),
                observations[ebook_id],
                _GUTENBERG_CREDIT_SOURCE,
            )
            for ebook_id in sorted(changed_ids)
        ]
    )

    return {
        "source_url": source_url,
        "row_count": len(rows),
        "synced_at": synced_at.isoformat(),
    }


def download_project_gutenberg_catalog_feed(
    *,
    source_urls: tuple[str, ...] | None = None,
) -> tuple[str, bytes]:
    """Download the official catalog feed, preferring the compressed variant."""
    last_error: Exception | None = None
    for source_url in source_urls or _CATALOG_FEED_URLS:
        try:
            with httpx.Client(timeout=_CATALOG_TIMEOUT, follow_redirects=True) as client:
                response = client.get(source_url)
                response.raise_for_status()
                return source_url, response.content
        except httpx.HTTPError as exc:  # pragma: no cover - fallback path asserted at API level
            last_error = exc

    assert last_error is not None
    raise last_error


def parse_project_gutenberg_catalog_feed(
    payload: bytes,
    *,
    synced_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Parse pg_catalog.csv(.gz) into normalized database rows."""
    resolved_synced_at = synced_at or datetime.now(UTC)
    csv_bytes = _maybe_decompress(payload)
    text_stream = StringIO(csv_bytes.decode("utf-8-sig"))
    reader = csv.DictReader(text_stream)
    rows: list[dict[str, Any]] = []

    for raw_row in reader:
        ebook_id = _parse_required_int(
            _row_value(raw_row, "Text#", "Text", "ID", "EBook-No."),
        )
        rows.append(
            {
                "ebook_id": ebook_id,
                "title": _row_value(raw_row, "Title") or "",
                "gutenberg_type": _row_value(raw_row, "Type"),
                "issued": _parse_optional_date(_row_value(raw_row, "Issued")),
                "language": _row_value(raw_row, "Language"),
                "subjects": _row_value(raw_row, "Subjects", "Subject"),
                "locc": _row_value(raw_row, "LoCC"),
                "bookshelves": _row_value(raw_row, "Bookshelves", "Bookshelf"),
                "copyright_status": _row_value(
                    raw_row,
                    "Copyright",
                    "Copyright Status",
                ),
                "download_count": _parse_optional_int(_row_value(raw_row, "Downloads")),
                "raw_metadata": {key: value or "" for key, value in raw_row.items() if key},
                "synced_at": resolved_synced_at,
                "created_at": resolved_synced_at,
                "updated_at": resolved_synced_at,
            }
        )

    return rows


def _maybe_decompress(payload: bytes) -> bytes:
    if payload[:2] == b"\x1f\x8b":
        return gzip.decompress(payload)
    return payload


def _row_value(row: dict[str, str | None], *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def _parse_required_int(value: str | None) -> int:
    parsed = _parse_optional_int(value)
    if parsed is None:
        raise ValueError("Project Gutenberg catalog row is missing a valid ebook id")
    return parsed


def _gutenberg_author_entries(row: dict[str, Any]) -> list[RawCreditEntry]:
    """Parse the catalog author string into raw author entries.

    Split on ``;`` and `` and `` only — commas are preserved so ``Verne, Jules``
    stays one name (D-31: only the PDF delimiter rule reverses; the catalog keeps
    this comma-preserving split). ``build_observation`` owns cleaning, dedupe, and
    truncation. The catalog carries no identity keys (provenance, not identity).
    """
    raw_metadata = row.get("raw_metadata")
    if not isinstance(raw_metadata, dict):
        return []
    raw_authors = str(raw_metadata.get("Authors") or raw_metadata.get("Author") or "").strip()
    if not raw_authors:
        return []
    return [
        RawCreditEntry(credited_name=part, raw_role="author")
        for part in re.split(r"\s*;\s*|\s+and\s+", raw_authors)
        if part.strip()
    ]


def _parse_optional_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _parse_optional_date(value: str | None) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
