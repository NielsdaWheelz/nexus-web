"""Default library virtualization & transient state pruning (spec
docs/cutovers/default-library-virtualization-and-transient-state-pruning-hard-cutover.md).

This revision is written IN PLACE across two implementation slices, S4 and S6
(one file, one revision id, per the S4 contract's locked decision). S4 landed
step 1 only: create ``reader_engagement_states`` and backfill it from the
union of ``reader_media_state``/``reading_sessions``. S6 (this completion)
prepends the §6 preflight (exact row IDs, no mutation) and appends steps 2-4
plus a ``NotImplementedError`` downgrade. This revision is now irreversible,
exactly as 0166/0179/0180/0182 precede it in this chain.

Preflight (spec §6 "Preflight"; no mutation; aborts with exact row IDs):

1. Every default library has zero podcast entries.
2. Every ``default_library_intrinsics`` row has its matching physical Default
   entry.
3. Record + report counts for all eight dropped tables.
4. Classify Default physical media rows: intrinsic-backed, closure-only, both,
   or unclassified.
5. Oracle/system-only media are excluded by the new Default relation.

Transform (spec §6 "0183 transform"):

1. Create ``reader_engagement_states`` (one current row per user/media; no
   session, device, span, dwell, or event list — spec §4.4).
   Backfill it from the union of ``reader_media_state`` and ``reading_sessions``
   pairs, restricted to reader-supported media kinds (``web_article`` |
   ``epub`` | ``pdf`` — the migration backfill's narrower scope than the live
   write, which is not kind-gated; S4 contract LOCKED DECISION M1).
   ``last_engaged_at = GREATEST(reader_media_state.updated_at,
   MAX(reading_sessions.last_active_at))``, null-safe (Postgres ``GREATEST``
   ignores NULL arguments, matching 0180's own backfill idiom) so cursor-only
   and attention-only document rows both survive. ``max_total_progression``
   overlays the current cursor's ``locations.total_progression`` with the
   session-tracked ``max_progression`` via the same null-safe ``GREATEST`` (the
   same "advance to the higher value" rule the live write uses), but only for
   document-wide kinds (``web_article``/``epub``); PDF progression is
   page-local, not whole-document, so it is forced to ``NULL`` regardless of any
   stored session value, never false completion.
2. Delete queued/running ``background_jobs`` rows of kind
   ``backfill_default_library_closure_job``.
3. Delete physical Default entries proven closure-only (retain intrinsic-backed,
   both-backed, and unclassified rows — the current agent path can create
   unclassified direct intent).
4. Drop the eight tables in dependency order (children before parents).

Downgrade is blocked: this cutover deletes data (closure-only physical Default
entries) and drops eight tables with no reconstructable inverse.

Revision ID: 0183
Revises: 0182
Create Date: 2026-07-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0183"
down_revision: str | Sequence[str] | None = "0182"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Reader-supported media kinds the migration backfill is scoped to (spec §6
# step 1). The live write (services/consumption/_reader_engagement_store.py)
# is deliberately NOT kind-gated this way — see the S4 contract's LOCKED
# DECISION M1 (video's transcript-kind cursor writes still touch a row; only
# the historical backfill is scoped narrower, since reading_sessions/
# reader_media_state history for video is sparse/low-value to reconstruct).
_BACKFILL_KINDS: tuple[str, ...] = ("web_article", "epub", "pdf")

# The eight tables dropped by step 4, in dependency order: children before
# parents (spec §1/§6 item 4). None of these are referenced by any surviving
# FK (models audit, spec §7 "Delete"); a plain DROP TABLE suffices for each.
_DROPPED_TABLES: tuple[str, ...] = (
    "library_entry_page_snapshot_items",
    "library_entry_page_snapshots",
    "message_retrieval_candidate_ledgers",
    "message_rerank_ledgers",
    "reading_sessions",
    "default_library_backfill_jobs",
    "default_library_closure_edges",
    "default_library_intrinsics",
)


def _fail(phase: str, message: str) -> None:
    raise RuntimeError(f"0183 {phase}: {message}")


def _report(message: str) -> None:
    print(f"0183: {message}")


def _preflight(bind) -> None:
    """SELECT-only validation (spec §6 "Preflight"). No mutation; every abort
    reports the exact offending row IDs so operators can remediate through
    existing public operations and rerun (spec §6 preflight-failure note)."""

    # 1. Every default library must have zero podcast entries: 0183 makes
    # Default a media-only virtual set (spec §4.1); a podcast entry there is a
    # pre-existing product invariant the transform cannot repair by guessing a
    # destination.
    rows = bind.execute(
        sa.text(
            "SELECT le.id FROM library_entries le"
            " JOIN libraries l ON l.id = le.library_id"
            " WHERE l.is_default AND le.podcast_id IS NOT NULL"
            " ORDER BY le.id"
        )
    ).fetchall()
    if rows:
        ids = [str(row[0]) for row in rows]
        _fail(
            "preflight",
            f"{len(ids)} default library_entries row(s) carry a podcast_id"
            f" (remediate via subscription/non-default filing, then remove the"
            f" invalid Default entry, then rerun): {ids}",
        )

    # 2. Every default_library_intrinsics row must have its matching physical
    # Default entry: an intrinsic with no backing row is unrepresentable once
    # the closure/intrinsic tables are dropped.
    rows = bind.execute(
        sa.text(
            "SELECT i.default_library_id, i.media_id"
            " FROM default_library_intrinsics i"
            " WHERE NOT EXISTS ("
            "   SELECT 1 FROM library_entries le"
            "   WHERE le.library_id = i.default_library_id"
            "     AND le.media_id = i.media_id"
            "     AND le.media_id IS NOT NULL"
            " )"
            " ORDER BY i.default_library_id, i.media_id"
        )
    ).fetchall()
    if rows:
        pairs = [(str(row[0]), str(row[1])) for row in rows]
        _fail(
            "preflight",
            f"{len(pairs)} default_library_intrinsics row(s) lack their matching"
            f" physical Default entry (default_library_id, media_id) — restore the"
            f" physical row through the current provenance owner, then rerun: {pairs}",
        )

    # 3. Record + report counts for all eight dropped tables.
    for table in _DROPPED_TABLES:
        count = bind.execute(sa.text(f"SELECT count(*) FROM {table}")).scalar()  # noqa: S608
        _report(f"preflight: {table} has {count} row(s) before drop")

    # 4. Classify Default physical media rows: intrinsic-backed, closure-only,
    # both, or unclassified (direct-intent rows the current agent path can
    # create with neither provenance table involved).
    classification_rows = bind.execute(
        sa.text(
            "SELECT"
            "   CASE"
            "     WHEN i.default_library_id IS NOT NULL AND c.default_library_id IS NOT NULL"
            "       THEN 'both'"
            "     WHEN i.default_library_id IS NOT NULL THEN 'intrinsic_backed'"
            "     WHEN c.default_library_id IS NOT NULL THEN 'closure_only'"
            "     ELSE 'unclassified'"
            "   END AS classification,"
            "   count(*) AS n"
            " FROM library_entries le"
            " JOIN libraries l ON l.id = le.library_id"
            " LEFT JOIN default_library_intrinsics i"
            "   ON i.default_library_id = le.library_id AND i.media_id = le.media_id"
            " LEFT JOIN default_library_closure_edges c"
            "   ON c.default_library_id = le.library_id AND c.media_id = le.media_id"
            " WHERE l.is_default AND le.media_id IS NOT NULL"
            " GROUP BY 1"
            " ORDER BY 1"
        )
    ).fetchall()
    classification = {row[0]: row[1] for row in classification_rows}
    _report(f"preflight: Default physical media row classification: {classification}")

    # 5. The new Default relation excludes system-only media structurally, by
    # filtering contributing libraries to system_key IS NULL (spec §4.1, tested
    # by AC2). That exclusion only holds if the default libraries it reads from
    # are themselves non-system: a library that is BOTH is_default and a system
    # library would leak system media into every personal Default surface. This
    # is the real, checkable data precondition (the previous "no default entry
    # references system-only media" phrasing was vacuous — a default entry is
    # itself a non-system reference, so it can never witness its own absence).
    rows = bind.execute(
        sa.text(
            "SELECT id FROM libraries"
            " WHERE is_default AND system_key IS NOT NULL"
            " ORDER BY id"
        )
    ).fetchall()
    if rows:
        ids = [str(row[0]) for row in rows]
        _fail(
            "preflight",
            f"{len(ids)} librar{'y is' if len(ids) == 1 else 'ies are'} both is_default and a"
            f" system library, which would leak system media into the personal Default"
            f" relation: {ids}",
        )


def upgrade() -> None:
    bind = op.get_bind()

    # --- Preflight (spec §6; no mutation, aborts with exact row IDs) ------
    _preflight(bind)

    # --- Step 1a: create reader_engagement_states -------------------------
    op.execute("""
        CREATE TABLE reader_engagement_states (
            id                     uuid        PRIMARY KEY,
            user_id                uuid        NOT NULL,
            media_id               uuid        NOT NULL,
            created_at             timestamptz NOT NULL DEFAULT now(),
            last_engaged_at        timestamptz NOT NULL,
            max_total_progression  real        NULL,

            CONSTRAINT fk_reader_engagement_states_user
                FOREIGN KEY (user_id) REFERENCES users(id),
            CONSTRAINT fk_reader_engagement_states_media
                FOREIGN KEY (media_id) REFERENCES media(id),
            CONSTRAINT uq_reader_engagement_states_user_media
                UNIQUE (user_id, media_id),
            CONSTRAINT ck_reader_engagement_states_max_total_progression
                CHECK (max_total_progression IS NULL
                       OR (max_total_progression >= 0.0 AND max_total_progression <= 1.0))
        )
    """)

    # --- Step 1b: backfill from reader_media_state UNION reading_sessions -
    # session_agg: per (user, media) reading_sessions aggregate, kept separate
    # from reader_media_state so a media absent from one side still surfaces
    # via a LEFT JOIN below (both "cursor-only" and "attention-only" document
    # rows must survive, spec AC9).
    result = bind.execute(
        sa.text("""
            WITH session_agg AS (
                SELECT user_id, media_id,
                       MAX(last_active_at) AS max_last_active_at,
                       MAX(max_progression) AS max_progression
                FROM reading_sessions
                GROUP BY user_id, media_id
            ),
            pairs AS (
                SELECT user_id, media_id FROM reader_media_state
                UNION
                SELECT user_id, media_id FROM session_agg
            ),
            scoped AS (
                SELECT p.user_id, p.media_id, m.kind
                FROM pairs p
                JOIN media m ON m.id = p.media_id
                WHERE m.kind = ANY(:kinds)
            )
            INSERT INTO reader_engagement_states (
                id, user_id, media_id, last_engaged_at, max_total_progression
            )
            SELECT
                gen_random_uuid(),
                s.user_id,
                s.media_id,
                -- GREATEST ignores NULLs (matches 0180's own backfill idiom); at
                -- least one side is always present here, so this is never NULL.
                GREATEST(rms.updated_at, sess.max_last_active_at),
                CASE
                    WHEN s.kind = 'pdf' THEN NULL
                    ELSE GREATEST(
                        CASE
                            WHEN (rms.locator->'locations'->>'total_progression') IS NULL THEN NULL
                            ELSE LEAST(1.0, GREATEST(0.0,
                                (rms.locator->'locations'->>'total_progression')::double precision
                            ))
                        END,
                        sess.max_progression
                    )
                END
            FROM scoped s
            LEFT JOIN reader_media_state rms
                ON rms.user_id = s.user_id AND rms.media_id = s.media_id
            LEFT JOIN session_agg sess
                ON sess.user_id = s.user_id AND sess.media_id = s.media_id
        """),
        {"kinds": list(_BACKFILL_KINDS)},
    )
    _report(f"backfilled {result.rowcount} reader_engagement_states row(s)")

    # --- Step 2: delete EVERY backfill_default_library_closure_job
    # background_jobs row, regardless of status. The job kind and its handler
    # are removed by this cutover, so no row can ever run again — and a
    # surviving row is not inert: the queue reclaims 'pending'/'failed' rows
    # (jobs/queue.py claims WHERE status IN ('pending','failed')) and an
    # operator can requeue a 'dead' row, either of which would dispatch to a
    # now-deleted handler after this deploy. Historical audit value is nil for
    # a kind that no longer exists. ----------------------------------------
    deleted_jobs = bind.execute(
        sa.text(
            "DELETE FROM background_jobs"
            " WHERE kind = 'backfill_default_library_closure_job'"
        )
    ).rowcount
    _report(
        f"deleted {deleted_jobs} backfill_default_library_closure_job background_jobs row(s)"
    )

    # --- Step 3: delete physical Default entries proven closure-only AND still
    # covered by a live non-default, non-system membership of the default's
    # owner. The coverage is re-derived from LIVE library_entries/memberships,
    # NOT trusted from default_library_closure_edges: that table has no
    # constraint tying an edge to a live source row, so a stale/dangling edge
    # (e.g. from an unlocked closure-backfill read racing a source removal)
    # could otherwise delete a media's sole physical reference and orphan it
    # forever (unreachable via the new relation yet never torn down). Requiring
    # live coverage means a deleted row always stays virtually visible, and a
    # closure-only entry whose edge is dangling is retained (treated like an
    # unclassified direct row) rather than silently dropped. Intrinsic-backed,
    # both-backed, and unclassified rows are retained. ----------------------
    deleted_entries = bind.execute(
        sa.text(
            "DELETE FROM library_entries le"
            " USING libraries l"
            " WHERE l.id = le.library_id"
            "   AND l.is_default"
            "   AND le.media_id IS NOT NULL"
            "   AND EXISTS ("
            "     SELECT 1 FROM default_library_closure_edges c"
            "     WHERE c.default_library_id = l.id AND c.media_id = le.media_id"
            "   )"
            "   AND NOT EXISTS ("
            "     SELECT 1 FROM default_library_intrinsics i"
            "     WHERE i.default_library_id = l.id AND i.media_id = le.media_id"
            "   )"
            "   AND EXISTS ("
            "     SELECT 1"
            "     FROM library_entries le_cover"
            "     JOIN libraries l_cover ON l_cover.id = le_cover.library_id"
            "     JOIN memberships m_cover ON m_cover.library_id = l_cover.id"
            "     WHERE le_cover.media_id = le.media_id"
            "       AND l_cover.is_default = false"
            "       AND l_cover.system_key IS NULL"
            "       AND m_cover.user_id = l.owner_user_id"
            "   )"
        )
    ).rowcount
    _report(
        f"deleted {deleted_entries} closure-only, live-covered Default library_entries row(s)"
    )

    # --- Step 4: drop the eight tables, children before parents. -----------
    for table in _DROPPED_TABLES:
        op.execute(f"DROP TABLE {table}")
        _report(f"dropped table {table}")


def downgrade() -> None:
    raise NotImplementedError(
        "0183 is a hard cutover migration and has no downgrade path: step 3"
        " deletes closure-only physical Default library_entries rows and step 4"
        " drops eight tables, neither of which is reconstructable."
    )
