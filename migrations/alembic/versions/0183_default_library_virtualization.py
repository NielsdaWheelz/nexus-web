"""Default library virtualization & transient state pruning (spec
docs/cutovers/default-library-virtualization-and-transient-state-pruning-hard-cutover.md).

This revision is written IN PLACE across two implementation slices, S4 and S6
(one file, one revision id, per the S4 contract's locked decision). S4 lands
only step 1 below: create ``reader_engagement_states`` and backfill it from the
union of ``reader_media_state``/``reading_sessions``. S6 will prepend the §6
preflight (exact row IDs, no mutation) and append steps 2-4 plus a
``NotImplementedError`` downgrade inside the clearly-marked block at the bottom
of this file. Because step 1 alone neither drops nor mutates any of the eight
tables named in §1, this revision stays fully reversible (``downgrade()`` drops
only the new table) until S6 extends it — at which point the migration becomes
irreversible, exactly as 0179/0180/0182 precede it in this chain.

Step 1 (spec §6 "0183 transform", item 1):

- Create ``reader_engagement_states`` (one current row per user/media; no
  session, device, span, dwell, or event list — spec §4.4).
- Backfill it from the union of ``reader_media_state`` and ``reading_sessions``
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


def _report(message: str) -> None:
    print(f"0183: {message}")


def upgrade() -> None:
    bind = op.get_bind()

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


# =============================================================================
# === S6 COMPLETES 0183 BELOW: prepend §6 preflight (exact row IDs, no
# mutation) at the top of upgrade(); append step 2 (delete queued
# backfill_default_library_closure_job background_jobs), step 3 (delete
# closure-only physical Default entries), step 4 (drop the 8 tables in
# dependency order); replace downgrade() below with NotImplementedError. ===
# =============================================================================


def downgrade() -> None:
    op.execute("DROP TABLE reader_engagement_states")
