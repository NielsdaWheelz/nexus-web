"""Drop reviewed unrecoverable reader-selection bindings before migration 0189.

Run this against the 0188 schema (the ``chat_run_turn_contexts``
``reader_selection_media_id`` / ``reader_selection_highlight_id`` columns still
present) when 0189's preflight aborts on a user message it cannot snapshot.
Remediation is explicit operator data loss, never a migration fallback (spec
docs/cutovers/reader-highlight-quote-chat-hard-cutover.md §Migration point 3):
for each reviewed ``user_message_id`` it clears the reader-selection pair on
every associated chat run's turn-context row, deleting a turn-context row that
would otherwise be left anchorless (no ``subject_id``). A remediated turn thus
becomes an ordinary historical user turn with no quote binding.

The script prints the affected run/turn-context manifest, commits once, and is
safe to re-run: a message whose bindings are already cleared or deleted is a
no-op. After running it for every reviewed message, rerun preflight/migration.
"""

from __future__ import annotations

import argparse
import sys
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import create_session_factory


def remediate_reader_selection_backfill(user_message_ids: list[UUID]) -> int:
    session_factory = create_session_factory()
    cleared: list[tuple[UUID, UUID]] = []
    deleted: list[tuple[UUID, UUID]] = []
    with session_factory() as db:
        for user_message_id in user_message_ids:
            run_ids = (
                db.execute(
                    text("SELECT id FROM chat_runs WHERE user_message_id = :mid ORDER BY id"),
                    {"mid": user_message_id},
                )
                .scalars()
                .all()
            )
            for run_id in run_ids:
                row = (
                    db.execute(
                        text(
                            "SELECT subject_id, reader_selection_media_id,"
                            " reader_selection_highlight_id"
                            " FROM chat_run_turn_contexts WHERE chat_run_id = :rid"
                        ),
                        {"rid": run_id},
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    continue
                if (
                    row["reader_selection_media_id"] is None
                    and row["reader_selection_highlight_id"] is None
                ):
                    # Already remediated for this run — idempotent no-op.
                    continue
                if row["subject_id"] is not None:
                    db.execute(
                        text(
                            "UPDATE chat_run_turn_contexts"
                            " SET reader_selection_media_id = NULL,"
                            " reader_selection_highlight_id = NULL"
                            " WHERE chat_run_id = :rid"
                        ),
                        {"rid": run_id},
                    )
                    cleared.append((user_message_id, run_id))
                else:
                    # Clearing the pair would leave the row anchorless (subject_id
                    # NULL AND reader_selection_highlight_id NULL violates
                    # ck_chat_run_turn_contexts_has_anchor), so drop the row.
                    db.execute(
                        text("DELETE FROM chat_run_turn_contexts WHERE chat_run_id = :rid"),
                        {"rid": run_id},
                    )
                    deleted.append((user_message_id, run_id))

        for user_message_id, run_id in cleared:
            print(
                f"cleared reader-selection pair: user_message={user_message_id}"
                f" chat_run={run_id} (turn context kept as subject-only anchor)"
            )
        for user_message_id, run_id in deleted:
            print(
                f"deleted anchorless turn context: user_message={user_message_id}"
                f" chat_run={run_id} (no subject remained)"
            )
        db.commit()

    print(
        "reader-selection remediation complete: "
        f"messages_reviewed={len(user_message_ids)} "
        f"turn_contexts_cleared={len(cleared)} turn_contexts_deleted={len(deleted)}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Drop reviewed unrecoverable reader-selection bindings (explicit data"
            " loss) before rerunning migration 0189."
        )
    )
    parser.add_argument(
        "user_message_id",
        nargs="+",
        type=UUID,
        help="One or more reviewed user_message_id UUIDs to remediate.",
    )
    args = parser.parse_args(argv)
    return remediate_reader_selection_backfill(list(args.user_message_id))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
