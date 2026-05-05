"""Project Gutenberg catalog mirror utilities."""

from __future__ import annotations

import csv
import gzip
import re
from datetime import UTC, date, datetime
from io import StringIO
from typing import Any

import httpx
from sqlalchemy import delete, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import ProjectGutenbergCatalogEntry
from nexus.services.contributor_credits import replace_gutenberg_contributor_credits

_CATALOG_FEED_URLS: tuple[str, ...] = (
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz",
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
)
_CATALOG_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
_UPSERT_BATCH_SIZE = 1000


def sync_project_gutenberg_catalog(
    db: Session,
    *,
    source_urls: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Fetch the official catalog feed and replace the local mirror."""
    resolved_source_urls = source_urls or _CATALOG_FEED_URLS
    source_url, payload = download_project_gutenberg_catalog_feed(source_urls=resolved_source_urls)
    synced_at = datetime.now(UTC)
    rows = parse_project_gutenberg_catalog_feed(payload, synced_at=synced_at)

    try:
        db.execute(
            text(
                """
                DELETE FROM contributor_credits
                WHERE project_gutenberg_catalog_ebook_id IS NOT NULL
                """
            )
        )
        db.execute(delete(ProjectGutenbergCatalogEntry))
        for start in range(0, len(rows), _UPSERT_BATCH_SIZE):
            batch = rows[start : start + _UPSERT_BATCH_SIZE]
            if not batch:
                continue
            db.execute(insert(ProjectGutenbergCatalogEntry), batch)
        for row in rows:
            replace_gutenberg_contributor_credits(
                db,
                ebook_id=int(row["ebook_id"]),
                credits=_gutenberg_author_credits(row),
                source="project_gutenberg_catalog",
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

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
        except Exception as exc:  # pragma: no cover - fallback path asserted at API level
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


def _gutenberg_author_credits(row: dict[str, Any]) -> list[dict[str, Any]]:
    raw_metadata = row.get("raw_metadata")
    if not isinstance(raw_metadata, dict):
        return []
    raw_authors = str(raw_metadata.get("Authors") or raw_metadata.get("Author") or "").strip()
    if not raw_authors:
        return []

    credits: list[dict[str, Any]] = []
    for raw_name in re.split(r"\s*;\s*|\s+and\s+", raw_authors):
        credited_name = " ".join(raw_name.split()).strip()
        if not credited_name:
            continue
        credits.append(
            {
                "credited_name": credited_name,
                "role": "author",
                "raw_role": "author",
                "ordinal": len(credits),
                "source": "project_gutenberg_catalog",
                "source_ref": {"ebook_id": int(row["ebook_id"])},
            }
        )
    return credits


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
