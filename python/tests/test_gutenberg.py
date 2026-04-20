"""Tests for the Project Gutenberg catalog mirror."""

from __future__ import annotations

import gzip
from datetime import UTC, datetime
from unittest.mock import patch

import httpx
import pytest
import respx
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.gutenberg import (
    parse_project_gutenberg_catalog_feed,
    sync_project_gutenberg_catalog,
)
from nexus.tasks.sync_gutenberg_catalog import sync_gutenberg_catalog_job
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


def _sample_catalog_csv() -> bytes:
    return (
        b"Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves,Downloads,Copyright\r\n"
        b'123,Text,2001-01-01,Example Book,en,"Doe, Jane","Fiction",PS,Classics,42,Public domain in the USA.\r\n'
        b'456,Text,2002-02-02,Second Book,fr,"Roe, Richard","Poetry",PQ,Poetry,7,\r\n'
    )


def test_parse_project_gutenberg_catalog_feed_accepts_gzip_payload():
    synced_at = datetime(2026, 4, 19, 12, 0, tzinfo=UTC)

    rows = parse_project_gutenberg_catalog_feed(
        gzip.compress(_sample_catalog_csv()),
        synced_at=synced_at,
    )

    assert [row["ebook_id"] for row in rows] == [123, 456]
    assert rows[0]["title"] == "Example Book"
    assert rows[0]["issued"].isoformat() == "2001-01-01"
    assert rows[0]["download_count"] == 42
    assert rows[0]["raw_metadata"]["Bookshelves"] == "Classics"
    assert rows[1]["copyright_status"] is None


def test_sync_project_gutenberg_catalog_replaces_existing_rows(db_session: Session):
    db_session.execute(
        text(
            """
            INSERT INTO project_gutenberg_catalog (
                ebook_id,
                title,
                raw_metadata,
                synced_at,
                created_at,
                updated_at
            )
            VALUES (
                999,
                'Stale Row',
                '{}'::jsonb,
                now(),
                now(),
                now()
            )
            """
        )
    )
    db_session.commit()

    with patch(
        "nexus.services.gutenberg.download_project_gutenberg_catalog_feed",
        return_value=(
            "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz",
            _sample_catalog_csv(),
        ),
    ):
        result = sync_project_gutenberg_catalog(db_session)

    db_session.expire_all()
    rows = db_session.execute(
        text(
            """
            SELECT ebook_id, title, language, download_count
            FROM project_gutenberg_catalog
            ORDER BY ebook_id
            """
        )
    ).fetchall()

    assert result["row_count"] == 2
    assert rows == [
        (123, "Example Book", "en", 42),
        (456, "Second Book", "fr", 7),
    ]


@respx.mock
def test_sync_gutenberg_catalog_job_downloads_feed_and_persists_rows(db_session: Session):
    route = respx.get("https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz").mock(
        return_value=httpx.Response(
            status_code=200,
            content=gzip.compress(_sample_catalog_csv()),
            headers={"Content-Type": "application/gzip"},
        )
    )

    with patch(
        "nexus.tasks.sync_gutenberg_catalog.get_session_factory",
        return_value=task_session_factory(db_session),
    ):
        result = sync_gutenberg_catalog_job(
            request_id="req-gutenberg-sync",
            scheduler_identity="test-scheduler",
        )

    db_session.expire_all()
    stored = db_session.execute(
        text(
            """
            SELECT title, authors, bookshelves
            FROM project_gutenberg_catalog
            WHERE ebook_id = 123
            """
        )
    ).one()

    assert route.called, "Expected sync job to request the official compressed catalog feed."
    assert result["row_count"] == 2
    assert stored == ("Example Book", "Doe, Jane", "Classics")
