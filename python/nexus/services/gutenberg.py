"""Project Gutenberg catalog mirror."""

from __future__ import annotations

import csv
import gzip
import re
from datetime import UTC, datetime
from io import StringIO
from typing import Any

import httpx
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from nexus.db.models import ProjectGutenbergCatalogEntry
from nexus.db.session import transaction
from nexus.services import contributors
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_revisions
from nexus.services.contributor_credits import current_gutenberg_author_names
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    ObservedRoleSlices,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributor_writes import GutenbergTarget

_CATALOG_FEED_URLS = (
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz",
    "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
)
_CATALOG_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
_INSERT_BATCH_SIZE = 1000
_GUTENBERG_CREDIT_SOURCE = "project_gutenberg_catalog"
# Refreshed on ON CONFLICT UPDATE; never created_at or ebook_id.
_UPSERT_COLUMNS = ("title", "subjects", "bookshelves", "download_count", "updated_at")


def sync_project_gutenberg_catalog(
    db: Session, *, source_urls: tuple[str, ...] | None = None
) -> dict[str, Any]:
    """Download the catalog feed and reconcile the local mirror.

    One transaction upserts every parsed row and deletes removed ebooks with
    their credits. Author credits are then replaced only for new or
    author-changed ebooks, on the contributor facade's own fresh sessions after
    that transaction commits: the catalog and author writes never share one.
    """
    source_url, payload = download_project_gutenberg_catalog_feed(
        source_urls=source_urls or _CATALOG_FEED_URLS
    )
    parsed = parse_project_gutenberg_catalog_feed(payload)

    observations: dict[int, ContributorObservationBatch] = {}
    parsed_names: dict[int, tuple[str, ...]] = {}
    for row, authors in parsed:
        ebook_id = int(row["ebook_id"])
        observation, _truncated = build_observation({"author": authors})
        observations[ebook_id] = observation
        parsed_names[ebook_id] = (
            tuple(credit.credited_name for credit in observation.credits)
            if isinstance(observation, ObservedRoleSlices)
            else ()
        )
    parsed_ids = set(observations)

    with transaction(db):
        current_ids = set(db.scalars(select(ProjectGutenbergCatalogEntry.ebook_id)).all())
        removed_ids = current_ids - parsed_ids
        existing_ids = current_ids & parsed_ids
        stored_names = current_gutenberg_author_names(db, list(existing_ids))
        changed_ids = parsed_ids - current_ids
        changed_ids.update(
            ebook_id
            for ebook_id in existing_ids
            if parsed_names.get(ebook_id, ()) != stored_names.get(ebook_id, ())
        )

        # Credits before the catalog row, so the FK holds.
        for ebook_id in removed_ids:
            contributors.cleanup_credits_for_deleted_target(db, target=GutenbergTarget(ebook_id))
        if removed_ids:
            db.execute(
                delete(ProjectGutenbergCatalogEntry).where(
                    ProjectGutenbergCatalogEntry.ebook_id.in_(removed_ids)
                )
            )
        for start in range(0, len(parsed), _INSERT_BATCH_SIZE):
            statement = pg_insert(ProjectGutenbergCatalogEntry).values(
                [row for row, _ in parsed[start : start + _INSERT_BATCH_SIZE]]
            )
            db.execute(
                statement.on_conflict_do_update(
                    index_elements=["ebook_id"],
                    set_={column: statement.excluded[column] for column in _UPSERT_COLUMNS},
                )
            )
        # Catalog titles affect AuthorWorks ordering even when author credits do not change.
        bump_all_collection_revisions(db, family=CollectionFamily.AuthorWorks)

    contributors.replace_observed_role_slices_batch(
        [
            (
                GutenbergTarget(ebook_id),
                observations[ebook_id],
                _GUTENBERG_CREDIT_SOURCE,
            )
            for ebook_id in sorted(changed_ids)
        ]
    )
    return {"source_url": source_url, "row_count": len(parsed)}


def download_project_gutenberg_catalog_feed(
    *, source_urls: tuple[str, ...] | None = None
) -> tuple[str, bytes]:
    """Download the official feed, preferring the compressed variant."""
    last_error: Exception = RuntimeError("no Project Gutenberg catalog source URL was given")
    for source_url in source_urls or _CATALOG_FEED_URLS:
        try:
            with httpx.Client(timeout=_CATALOG_TIMEOUT, follow_redirects=True) as client:
                response = client.get(source_url)
                response.raise_for_status()
                return source_url, response.content
        except httpx.HTTPError as exc:
            last_error = exc
    raise last_error


def parse_project_gutenberg_catalog_feed(
    payload: bytes,
) -> list[tuple[dict[str, Any], list[RawCreditEntry]]]:
    """Parse pg_catalog.csv(.gz) into mirror rows, each with its author entries."""
    now = datetime.now(UTC)
    raw = gzip.decompress(payload) if payload[:2] == b"\x1f\x8b" else payload
    reader = csv.DictReader(StringIO(raw.decode("utf-8-sig")))
    parsed: list[tuple[dict[str, Any], list[RawCreditEntry]]] = []
    for raw_row in reader:
        ebook_id = _optional_int(_value(raw_row, "Text#", "Text", "ID", "EBook-No."))
        if ebook_id is None:
            raise ValueError("Project Gutenberg catalog row is missing a valid ebook id")
        row = {
            "ebook_id": ebook_id,
            "title": _value(raw_row, "Title") or "",
            "subjects": _value(raw_row, "Subjects", "Subject"),
            "bookshelves": _value(raw_row, "Bookshelves", "Bookshelf"),
            "download_count": _optional_int(_value(raw_row, "Downloads")),
            "created_at": now,
            "updated_at": now,
        }
        parsed.append((row, _author_entries(_value(raw_row, "Authors", "Author") or "")))
    return parsed


def _author_entries(authors: str) -> list[RawCreditEntry]:
    """Split the catalog author string on ``;`` and `` and `` only.

    Commas are preserved so ``Verne, Jules`` stays one name. The catalog carries
    no identity keys — it is provenance, not identity.
    """
    return [
        RawCreditEntry(credited_name=part, raw_role="author")
        for part in re.split(r"\s*;\s*|\s+and\s+", authors)
        if part.strip()
    ]


def _value(row: dict[str, str | None], *keys: str) -> str | None:
    for key in keys:
        stripped = (row.get(key) or "").strip()
        if stripped:
            return stripped
    return None


def _optional_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None
