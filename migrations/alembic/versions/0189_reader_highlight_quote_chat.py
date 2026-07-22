"""Reader-highlight quote-to-chat hard cutover — persistence half (spec
docs/cutovers/reader-highlight-quote-chat-hard-cutover.md §Migration).

Transform:

1. Add nullable ``messages.reader_selection_snapshot`` JSONB with the shallow
   object CHECK (parity with sibling message JSON; strict decode owns the deep
   shape).
2. Preflight every selection-bearing turn context grouped by its run's user
   message. Abort atomically (write nothing) with an operator-readable report on
   a missing Highlight/media, malformed locator, blank/over-limit fields, role
   mismatch, absent/mismatched Highlight subject, or more than one distinct
   ``ReaderSelectionKey`` per message.
3. Build one immutable snapshot per valid user message from the current
   Highlight/Media/locator via the canonical snapshot owner. Rerun-cloned
   messages are independent user messages and each receive the equal value.
4. Assert every selection-bearing message has exactly one snapshot and every
   selection-free message has none.
5. Drop ``chat_run_turn_contexts.reader_selection_media_id`` /
   ``reader_selection_highlight_id`` and their pair CHECK; rewrite ``has_anchor``
   to the subject-only shape. Downgrade is blocked.

Remediation for an unrecoverable binding is explicit operator data loss via
``python/scripts/remediate_reader_selection_backfill.py``, never a migration
fallback: the backfill captures current state because pre-cutover history was
never snapshotted, and a remediated turn intentionally becomes an ordinary
historical user turn with no quote binding.
"""

from __future__ import annotations

import json
from collections import defaultdict
from uuid import UUID

from alembic import op
from sqlalchemy import text
from sqlalchemy.orm import Session

revision = "0189"
down_revision = "0188"
branch_labels = None
depends_on = None


def _fail(phase: str, message: str) -> None:
    raise RuntimeError(f"0189 {phase}: {message}")


def _plan_backfill(session: Session) -> dict[UUID, str]:
    """Preflight + build one snapshot JSON per valid selection-bearing user
    message. Raises (writing nothing) on the first-collected set of failures."""
    from nexus.errors import ApiError
    from nexus.schemas.chat_reader_selection import ReaderSelectionKey
    from nexus.services.chat_reader_selection import (
        build_reader_selection_snapshot,
        encode_reader_selection_snapshot,
    )

    rows = session.execute(
        text(
            """
            SELECT tc.chat_run_id, r.user_message_id, m.role,
                   tc.subject_scheme, tc.subject_id,
                   tc.reader_selection_media_id, tc.reader_selection_highlight_id
            FROM chat_run_turn_contexts tc
            JOIN chat_runs r ON r.id = tc.chat_run_id
            JOIN messages m ON m.id = r.user_message_id
            WHERE tc.reader_selection_highlight_id IS NOT NULL
            """
        )
    ).fetchall()

    by_message: dict[UUID, list[tuple]] = defaultdict(list)
    for row in rows:
        by_message[row.user_message_id].append(row)

    plan: dict[UUID, str] = {}
    failures: list[str] = []

    for user_message_id in sorted(by_message, key=str):
        group = by_message[user_message_id]
        pairs = {(g.reader_selection_media_id, g.reader_selection_highlight_id) for g in group}
        if len(pairs) != 1:
            failures.append(
                f"{user_message_id}: {len(pairs)} distinct reader-selection keys across its runs"
            )
            continue
        media_id, highlight_id = next(iter(pairs))

        if any(g.role != "user" for g in group):
            failures.append(f"{user_message_id}: selection-bearing turn is not a user message")
            continue
        if any(
            g.subject_scheme != "highlight" or g.subject_id != highlight_id for g in group
        ):
            failures.append(
                f"{user_message_id}: turn subject is absent or is not the selection highlight"
            )
            continue

        owner = session.execute(
            text("SELECT user_id FROM highlights WHERE id = :id"),
            {"id": highlight_id},
        ).scalar()
        if owner is None:
            failures.append(f"{user_message_id}: highlight {highlight_id} is missing")
            continue

        try:
            snapshot = build_reader_selection_snapshot(
                session,
                viewer_id=owner,
                key=ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id),
            )
        except ApiError as err:
            failures.append(f"{user_message_id}: {err.code.value} — {err.message}")
            continue
        except (ValueError, AssertionError) as err:
            failures.append(f"{user_message_id}: malformed snapshot — {err}")
            continue

        plan[user_message_id] = json.dumps(encode_reader_selection_snapshot(snapshot))

    if failures:
        _fail(
            "preflight",
            "cannot snapshot "
            f"{len(failures)} selection-bearing user message(s); review each and run"
            " python/scripts/remediate_reader_selection_backfill.py before rerunning"
            f" the migration:\n  " + "\n  ".join(failures),
        )
    return plan


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Add the snapshot column + shallow object CHECK (sibling-parity only).
    op.execute("ALTER TABLE messages ADD COLUMN reader_selection_snapshot jsonb NULL")
    op.execute(
        "ALTER TABLE messages ADD CONSTRAINT ck_messages_reader_selection_snapshot_object"
        " CHECK (reader_selection_snapshot IS NULL"
        " OR jsonb_typeof(reader_selection_snapshot) = 'object')"
    )

    # 2 + 3. Preflight then backfill one immutable snapshot per valid message.
    session = Session(bind=bind)
    plan = _plan_backfill(session)
    for user_message_id, snapshot_json in plan.items():
        session.execute(
            text(
                "UPDATE messages SET reader_selection_snapshot = CAST(:snap AS jsonb)"
                " WHERE id = :id"
            ),
            {"snap": snapshot_json, "id": user_message_id},
        )

    # 4. Assert the backfill is total and exclusive.
    selection_message_count = session.execute(
        text(
            """
            SELECT count(DISTINCT r.user_message_id)
            FROM chat_run_turn_contexts tc
            JOIN chat_runs r ON r.id = tc.chat_run_id
            WHERE tc.reader_selection_highlight_id IS NOT NULL
            """
        )
    ).scalar_one()
    snapshot_count = session.execute(
        text("SELECT count(*) FROM messages WHERE reader_selection_snapshot IS NOT NULL")
    ).scalar_one()
    if selection_message_count != len(plan) or snapshot_count != len(plan):
        _fail(
            "assert",
            "snapshot backfill is not total/exclusive"
            f" (selection messages={selection_message_count}, snapshots={snapshot_count},"
            f" planned={len(plan)})",
        )

    # 5. Drop the reader-selection columns + pair CHECK; rewrite has_anchor.
    op.execute(
        "ALTER TABLE chat_run_turn_contexts"
        " DROP CONSTRAINT ck_chat_run_turn_contexts_reader_selection_pair"
    )
    op.execute(
        "ALTER TABLE chat_run_turn_contexts"
        " DROP CONSTRAINT ck_chat_run_turn_contexts_has_anchor"
    )
    op.execute("ALTER TABLE chat_run_turn_contexts DROP COLUMN reader_selection_media_id")
    op.execute("ALTER TABLE chat_run_turn_contexts DROP COLUMN reader_selection_highlight_id")
    op.execute(
        "ALTER TABLE chat_run_turn_contexts ADD CONSTRAINT ck_chat_run_turn_contexts_has_anchor"
        " CHECK (subject_id IS NOT NULL)"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0189 is a hard cutover migration and has no downgrade path: it drops the"
        " chat_run_turn_contexts reader-selection columns after moving selection"
        " identity/content into the immutable messages.reader_selection_snapshot,"
        " which the collapsed post-cutover shape cannot reconstruct."
    )
