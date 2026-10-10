"""Project Gutenberg catalog mirror: after a sync the table equals the published feed."""

from __future__ import annotations

import csv
import gzip
import re
from datetime import UTC, datetime
from io import StringIO
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from nexus.db.models import ProjectGutenbergCatalogEntry
from nexus.db.session import transaction
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import contributors
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_revisions
from nexus.services.contributor_credits import current_gutenberg_author_names
from nexus.services.contributor_writes import GutenbergTarget
from nexus.services.net.safe_fetch import safe_get

_FEED_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz"
_FEED_MAX_BYTES = 64 * 1024 * 1024
_FEED_TIMEOUT_S = 120.0
_BATCH_ROWS = 1000
_CREDIT_SOURCE = "project_gutenberg_catalog"
# Refreshed on conflict; never created_at or ebook_id.
_UPSERT_COLUMNS = ("title", "subjects", "bookshelves", "download_count", "updated_at")


def sync_project_gutenberg_catalog(db: Session) -> dict[str, Any]:
    """Download the feed and reconcile the mirror.

    One transaction upserts every row and deletes removed ebooks after their credits.
    Author credits are then replaced only for new or author-changed ebooks, on the
    contributor facade's own sessions: catalog and author writes never share one.
    """
    rows = _parse(safe_get(_FEED_URL, max_bytes=_FEED_MAX_BYTES, timeout_s=_FEED_TIMEOUT_S).content)
    observations: dict[int, taxonomy.ContributorObservationBatch] = {}
    names: dict[int, tuple[str, ...]] = {}
    for row, authors in rows:
        observation, _truncated = taxonomy.build_observation({"author": authors})
        observations[row["ebook_id"]] = observation
        names[row["ebook_id"]] = (
            tuple(credit.credited_name for credit in observation.credits)
            if isinstance(observation, taxonomy.ObservedRoleSlices)
            else ()
        )
    with transaction(db):
        current = set(db.scalars(select(ProjectGutenbergCatalogEntry.ebook_id)))
        removed = current - observations.keys()
        stored = current_gutenberg_author_names(db, list(current & observations.keys()))
        changed = {
            ebook_id
            for ebook_id in observations
            if ebook_id not in current or names[ebook_id] != stored.get(ebook_id, ())
        }
        for ebook_id in removed:  # credits first, so the foreign key holds
            contributors.cleanup_credits_for_deleted_target(db, target=GutenbergTarget(ebook_id))
        if removed:
            db.execute(
                delete(ProjectGutenbergCatalogEntry).where(
                    ProjectGutenbergCatalogEntry.ebook_id.in_(removed)
                )
            )
        for start in range(0, len(rows), _BATCH_ROWS):
            statement = pg_insert(ProjectGutenbergCatalogEntry).values(
                [row for row, _authors in rows[start : start + _BATCH_ROWS]]
            )
            db.execute(
                statement.on_conflict_do_update(
                    index_elements=["ebook_id"],
                    set_={column: statement.excluded[column] for column in _UPSERT_COLUMNS},
                )
            )
        # Catalog titles order AuthorWorks even when no credit changes.
        bump_all_collection_revisions(db, family=CollectionFamily.AuthorWorks)
    contributors.replace_observed_role_slices_batch(
        [(GutenbergTarget(id_), observations[id_], _CREDIT_SOURCE) for id_ in sorted(changed)]
    )
    return {"source_url": _FEED_URL, "row_count": len(rows)}


def _parse(payload: bytes) -> list[tuple[dict[str, Any], list[taxonomy.RawCreditEntry]]]:
    """pg_catalog.csv(.gz) rows, each with its author entries."""
    now = datetime.now(UTC)
    raw = gzip.decompress(payload) if payload[:2] == b"\x1f\x8b" else payload
    rows: list[tuple[dict[str, Any], list[taxonomy.RawCreditEntry]]] = []
    for record in csv.DictReader(StringIO(raw.decode("utf-8-sig"))):
        ebook_id = _int(_value(record, "Text#", "Text", "ID", "EBook-No."))
        if ebook_id is None:
            raise ValueError("Project Gutenberg catalog row is missing a valid ebook id")
        row = {
            "ebook_id": ebook_id,
            "title": _value(record, "Title") or "",
            "subjects": _value(record, "Subjects", "Subject"),
            "bookshelves": _value(record, "Bookshelves", "Bookshelf"),
            "download_count": _int(_value(record, "Downloads")),
            "created_at": now,
            "updated_at": now,
        }
        # `;` and ` and ` separate authors; commas stay, so "Verne, Jules" is one name.
        authors = re.split(r"\s*;\s*|\s+and\s+", _value(record, "Authors", "Author") or "")
        credits = [
            taxonomy.RawCreditEntry(credited_name=a, raw_role="author")
            for a in authors
            if a.strip()
        ]
        rows.append((row, credits))
    return rows


def _value(record: dict[str, str | None], *keys: str) -> str | None:
    return next((value for key in keys if (value := (record.get(key) or "").strip())), None)


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None
