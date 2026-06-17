"""Enqueue a content-index reindex job for every existing note block."""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from nexus.db.models import NoteBlock
from nexus.db.session import create_session_factory
from nexus.services.note_indexing import enqueue_note_reindex


def backfill_note_content_index(*, dry_run: bool, batch_size: int) -> int:
    session_factory = create_session_factory()
    scanned = 0
    enqueued = 0
    pending_in_batch = 0
    with session_factory() as db:
        for note_block_id in db.scalars(select(NoteBlock.id).order_by(NoteBlock.id)):
            scanned += 1
            if dry_run:
                print(f"would enqueue note_reindex for note_block {note_block_id}")
                continue
            enqueue_note_reindex(db, note_block_id=note_block_id, reason="backfill")
            enqueued += 1
            pending_in_batch += 1
            if pending_in_batch >= batch_size:
                db.commit()
                pending_in_batch = 0
        if not dry_run and pending_in_batch:
            db.commit()
    print(
        "note content-index backfill complete: "
        f"note_blocks_scanned={scanned} jobs_enqueued={enqueued} dry_run={dry_run}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args(argv)
    return backfill_note_content_index(dry_run=bool(args.dry_run), batch_size=int(args.batch_size))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
