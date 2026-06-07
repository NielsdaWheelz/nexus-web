"""Enqueue a content-index reindex job for every existing note page.

Run this once after Alembic revision 0141. That migration only copies
``owner_kind``/``owner_id`` onto the page content-index rows (a cheap column
copy); it does NOT create content_chunks/embeddings for pages. So every
pre-existing page has an empty content index until it is next saved, leaving
existing notes invisible to semantic search and uncitable.

This script streams all page ids and enqueues a debounced ``page_reindex_job``
for each, so the background worker drains them and builds the index. It is
idempotent: ``enqueue_page_reindex`` coalesces on the in-flight dedupe key, so
already-queued pages collapse onto the pending job and already-indexed pages
re-enqueue a fresh, harmless reindex. Re-running is therefore safe.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from nexus.db.models import Page
from nexus.db.session import create_session_factory
from nexus.services.note_indexing import enqueue_page_reindex


def backfill_page_content_index(*, dry_run: bool, batch_size: int) -> int:
    session_factory = create_session_factory()
    scanned = 0
    enqueued = 0
    pending_in_batch = 0
    with session_factory() as db:
        for page_id in db.scalars(select(Page.id).order_by(Page.id)):
            scanned += 1
            if dry_run:
                print(f"would enqueue page_reindex for page {page_id}")
                continue
            enqueue_page_reindex(db, page_id=page_id, reason="backfill")
            enqueued += 1
            pending_in_batch += 1
            if pending_in_batch >= batch_size:
                db.commit()
                pending_in_batch = 0
        if not dry_run and pending_in_batch:
            db.commit()
    print(
        "page content-index backfill complete: "
        f"pages_scanned={scanned} jobs_enqueued={enqueued} dry_run={dry_run}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args(argv)
    return backfill_page_content_index(dry_run=bool(args.dry_run), batch_size=int(args.batch_size))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
