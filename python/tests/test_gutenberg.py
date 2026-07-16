"""Tests for the Project Gutenberg catalog mirror.

The sync is upsert-based (D-15): the catalog transaction reconciles rows, then
author credits are replaced only for new or author-changed ebooks on the author
facade's own fresh sessions. Because those sessions commit on independent
connections, the DB-touching tests use ``direct_db`` (real commits, visible
across connections) rather than the savepoint-isolated ``db_session``.
"""

from __future__ import annotations

import gzip
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import httpx
import pytest
import respx
from sqlalchemy import event, text

from nexus.db.engine import get_engine
from nexus.services.gutenberg import (
    parse_project_gutenberg_catalog_feed,
    sync_project_gutenberg_catalog,
)
from nexus.tasks.sync_gutenberg_catalog import sync_gutenberg_catalog_job
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_FEED_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz"
_HEADER = (
    b"Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves,Downloads,Copyright\r\n"
)


def _catalog_csv(entries: list[tuple[int, str, str]]) -> bytes:
    """Build a catalog CSV from ``(ebook_id, title, authors)`` tuples."""
    lines = [_HEADER]
    for ebook_id, title, authors in entries:
        lines.append(
            f'{ebook_id},Text,2001-01-01,{title},en,"{authors}",'
            f"Fiction,PS,Classics,42,\r\n".encode()
        )
    return b"".join(lines)


def _sync(direct_db: DirectSessionManager, csv_bytes: bytes) -> dict:
    with patch(
        "nexus.services.gutenberg.download_project_gutenberg_catalog_feed",
        return_value=(_FEED_URL, csv_bytes),
    ):
        with direct_db.session() as session:
            return sync_project_gutenberg_catalog(session)


def _track_catalog(direct_db: DirectSessionManager, ebook_ids: list[int]) -> None:
    for ebook_id in ebook_ids:
        direct_db.register_cleanup("project_gutenberg_catalog", "ebook_id", ebook_id)


def _track_contributors(direct_db: DirectSessionManager, ebook_ids: list[int]) -> None:
    """Register cleanup for every contributor the given ebooks credit.

    Registered after the catalog/credit rows so LIFO deletion removes credits
    (by contributor_id, covering the ebook FK) before the catalog and contributor
    rows they reference.
    """
    with direct_db.session() as session:
        contributor_ids = (
            session.execute(
                text(
                    "SELECT DISTINCT contributor_id FROM contributor_credits "
                    "WHERE project_gutenberg_catalog_ebook_id = ANY(:ids)"
                ),
                {"ids": ebook_ids},
            )
            .scalars()
            .all()
        )
    for contributor_id in contributor_ids:
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)


def _author_credits(direct_db: DirectSessionManager, ebook_id: int) -> list[tuple]:
    with direct_db.session() as session:
        return session.execute(
            text(
                "SELECT credited_name, contributor_id, ordinal FROM contributor_credits "
                "WHERE project_gutenberg_catalog_ebook_id = :eid AND role = 'author' "
                "ORDER BY ordinal"
            ),
            {"eid": ebook_id},
        ).fetchall()


def _catalog_ebook_ids(direct_db: DirectSessionManager, ebook_ids: list[int]) -> set[int]:
    with direct_db.session() as session:
        return set(
            session.execute(
                text("SELECT ebook_id FROM project_gutenberg_catalog WHERE ebook_id = ANY(:ids)"),
                {"ids": ebook_ids},
            )
            .scalars()
            .all()
        )


def _contributor_exists(direct_db: DirectSessionManager, contributor_id) -> bool:
    with direct_db.session() as session:
        return (
            session.execute(
                text("SELECT 1 FROM contributors WHERE id = :cid"),
                {"cid": contributor_id},
            ).first()
            is not None
        )


@contextmanager
def _captured_statements():
    engine = get_engine()
    statements: list[str] = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _listener)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _listener)


def _credit_write_statements(statements: list[str]) -> list[str]:
    writes: list[str] = []
    for statement in statements:
        upper = statement.lstrip().upper()
        verb = upper.split(None, 1)[0] if upper else ""
        if "CONTRIBUTOR_CREDITS" in upper and verb in {"INSERT", "UPDATE", "DELETE"}:
            writes.append(statement)
    return writes


class _FakeSerializationError(Exception):
    sqlstate = "40001"

    def __str__(self) -> str:
        return "could not serialize access due to read/write dependencies among transactions"


@contextmanager
def _fail_once_on_credit_insert():
    """Raise a serialization-style error on the first contributor_credits INSERT."""
    from sqlalchemy.exc import OperationalError

    engine = get_engine()
    state = {"armed": True}

    def _listener(conn, cursor, statement, parameters, context, executemany):
        if state["armed"] and statement.lstrip().upper().startswith(
            "INSERT INTO CONTRIBUTOR_CREDITS"
        ):
            state["armed"] = False
            raise OperationalError("forced retry", None, _FakeSerializationError())

    event.listen(engine, "before_cursor_execute", _listener)
    try:
        yield state
    finally:
        event.remove(engine, "before_cursor_execute", _listener)


# ---------------------------------------------------------------------------
# Pure parse
# ---------------------------------------------------------------------------


def test_parse_project_gutenberg_catalog_feed_accepts_gzip_payload():
    synced_at = datetime(2026, 4, 19, 12, 0, tzinfo=UTC)

    rows = parse_project_gutenberg_catalog_feed(
        gzip.compress(
            _catalog_csv([(123, "Example Book", "Doe, Jane"), (456, "Second Book", "Roe, Richard")])
        ),
        synced_at=synced_at,
    )

    assert [row["ebook_id"] for row in rows] == [123, 456]
    assert rows[0]["title"] == "Example Book"
    assert rows[0]["issued"].isoformat() == "2001-01-01"
    assert rows[0]["download_count"] == 42


# ---------------------------------------------------------------------------
# Catalog reconciliation + author replacement
# ---------------------------------------------------------------------------


def test_sync_adds_new_ebooks_and_author_credits(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123, 456])

    result = _sync(
        direct_db,
        _catalog_csv([(123, "Example Book", "Doe, Jane"), (456, "Second Book", "Roe, Richard")]),
    )
    _track_contributors(direct_db, [123, 456])

    assert result["row_count"] == 2
    # Commas are preserved: "Doe, Jane" stays one name (D-31).
    assert [(row[0], row[2]) for row in _author_credits(direct_db, 123)] == [("Doe, Jane", 0)]
    assert [(row[0], row[2]) for row in _author_credits(direct_db, 456)] == [("Roe, Richard", 0)]


def test_sync_replaces_stale_catalog_rows(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123, 456, 999])
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO project_gutenberg_catalog "
                "(ebook_id, title, raw_metadata, synced_at, created_at, updated_at) "
                "VALUES (999, 'Stale Row', '{}'::jsonb, now(), now(), now())"
            )
        )
        session.commit()

    result = _sync(
        direct_db,
        _catalog_csv([(123, "Example Book", "Doe, Jane"), (456, "Second Book", "Roe, Richard")]),
    )
    _track_contributors(direct_db, [123, 456])

    assert result["row_count"] == 2
    assert _catalog_ebook_ids(direct_db, [123, 456, 999]) == {123, 456}


def test_sync_name_merges_shared_author_across_ebooks(direct_db: DirectSessionManager):
    # The cutover deduplicates by name: one "Shared Author" identity, credited on
    # both ebooks (inverts the pre-cutover per-ebook contributor behavior).
    _track_catalog(direct_db, [123, 456])

    _sync(
        direct_db,
        _catalog_csv([(123, "Book One", "Shared Author"), (456, "Book Two", "Shared Author")]),
    )
    _track_contributors(direct_db, [123, 456])

    first = _author_credits(direct_db, 123)
    second = _author_credits(direct_db, 456)
    assert [row[0] for row in first] == ["Shared Author"]
    assert [row[0] for row in second] == ["Shared Author"]
    assert first[0][1] == second[0][1]


def test_sync_changed_author_replaces_credits(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123])
    _sync(direct_db, _catalog_csv([(123, "Example Book", "Old Author")]))
    _track_contributors(direct_db, [123])

    _sync(direct_db, _catalog_csv([(123, "Example Book", "New Author")]))
    _track_contributors(direct_db, [123])

    assert [row[0] for row in _author_credits(direct_db, 123)] == ["New Author"]


def test_sync_removed_ebook_drops_credits_and_prunes_orphan(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123, 456])
    _sync(
        direct_db,
        _catalog_csv([(123, "Book One", "Solo Author"), (456, "Book Two", "Kept Author")]),
    )
    _track_contributors(direct_db, [123, 456])
    removed_contributor = _author_credits(direct_db, 123)[0][1]

    # Re-sync without ebook 123: its catalog row and credits go, and the orphaned
    # "Solo Author" contributor is pruned.
    _sync(direct_db, _catalog_csv([(456, "Book Two", "Kept Author")]))

    assert _catalog_ebook_ids(direct_db, [123, 456]) == {456}
    assert _author_credits(direct_db, 123) == []
    assert not _contributor_exists(direct_db, removed_contributor)
    assert [row[0] for row in _author_credits(direct_db, 456)] == ["Kept Author"]


def test_sync_unchanged_writes_no_credit_dml(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123, 456])
    feed = _catalog_csv([(123, "Book One", "Doe, Jane"), (456, "Book Two", "Roe, Richard")])
    _sync(direct_db, feed)
    _track_contributors(direct_db, [123, 456])

    with _captured_statements() as statements:
        result = _sync(direct_db, feed)

    assert result["row_count"] == 2
    assert _credit_write_statements(statements) == []
    # Credits are intact after the no-op author pass.
    assert [row[0] for row in _author_credits(direct_db, 123)] == ["Doe, Jane"]


def test_sync_chunk_retry_converges(direct_db: DirectSessionManager):
    _track_catalog(direct_db, [123])

    with _fail_once_on_credit_insert() as state:
        _sync(direct_db, _catalog_csv([(123, "Example Book", "Retry Author")]))
    _track_contributors(direct_db, [123])

    assert state["armed"] is False  # the forced failure fired
    assert [row[0] for row in _author_credits(direct_db, 123)] == ["Retry Author"]


# ---------------------------------------------------------------------------
# Scheduled job wiring
# ---------------------------------------------------------------------------


@respx.mock
def test_sync_gutenberg_catalog_job_downloads_feed_and_persists_rows(
    direct_db: DirectSessionManager,
):
    route = respx.get(_FEED_URL).mock(
        return_value=httpx.Response(
            status_code=200,
            content=gzip.compress(_catalog_csv([(123, "Example Book", "Doe, Jane")])),
            headers={"Content-Type": "application/gzip"},
        )
    )
    _track_catalog(direct_db, [123])

    with patch(
        "nexus.tasks.sync_gutenberg_catalog.get_session_factory",
        return_value=lambda: direct_db.session(),
    ):
        result = sync_gutenberg_catalog_job(
            request_id="req-gutenberg-sync",
            scheduler_identity="test-scheduler",
        )
    _track_contributors(direct_db, [123])

    assert route.called
    assert result["row_count"] == 1
    assert _catalog_ebook_ids(direct_db, [123]) == {123}
    assert [row[0] for row in _author_credits(direct_db, 123)] == ["Doe, Jane"]
