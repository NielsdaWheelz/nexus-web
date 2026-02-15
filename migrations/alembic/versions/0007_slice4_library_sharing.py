"""Slice 4: Library sharing schema

Revision ID: 0007
Revises: 0006
Create Date: 2026-02-15

S4 PR-01: Land full S4 storage and error/type contract.

Creates tables:
  - library_invitations
  - default_library_intrinsics
  - default_library_closure_edges
  - default_library_backfill_jobs

Adds supporting indexes on existing tables:
  - memberships (user_id, library_id, role)
  - library_media (media_id, library_id)
  - conversation_shares (library_id, conversation_id)

Runs deterministic seed transform (section 3.7 of s4_spec):
  1. Hard-fail precheck for missing default libraries.
  2. Seed closure edges from non-default membership + library_media.
  3. Seed intrinsics for unmatched default-library rows.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID, TIMESTAMP

# revision identifiers, used by Alembic
revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # =========================================================================
    # Step 0: Precheck — every member of a non-default library must own a
    # default library.  Hard-fail if not satisfied.
    # =========================================================================
    bad_rows = conn.execute(
        sa.text("""
            SELECT m.user_id, m.library_id
            FROM memberships m
            JOIN libraries l ON l.id = m.library_id
            WHERE l.is_default = false
              AND NOT EXISTS (
                  SELECT 1 FROM libraries d
                  WHERE d.owner_user_id = m.user_id
                    AND d.is_default = true
              )
            LIMIT 10
        """)
    ).fetchall()

    if bad_rows:
        ids = ", ".join(
            f"(user_id={r[0]}, library_id={r[1]})" for r in bad_rows
        )
        raise RuntimeError(
            f"S4_0007_MISSING_DEFAULT_LIBRARY: the following memberships "
            f"reference users without a default library: {ids}"
        )

    # =========================================================================
    # Step 1: Create new tables
    # =========================================================================

    # --- library_invitations ---
    op.create_table(
        "library_invitations",
        sa.Column(
            "id",
            PG_UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "inviter_user_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invitee_user_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "responded_at",
            TIMESTAMP(timezone=True),
            nullable=True,
        ),
        sa.CheckConstraint(
            "role IN ('admin', 'member')",
            name="ck_library_invitations_role",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'revoked')",
            name="ck_library_invitations_status",
        ),
        sa.CheckConstraint(
            "inviter_user_id <> invitee_user_id",
            name="ck_library_invitations_not_self",
        ),
        sa.CheckConstraint(
            "(status = 'pending' AND responded_at IS NULL) "
            "OR (status <> 'pending' AND responded_at IS NOT NULL)",
            name="ck_library_invitations_responded_at",
        ),
    )

    op.create_index(
        "uix_library_invitations_pending_once",
        "library_invitations",
        ["library_id", "invitee_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "idx_library_invitations_library_status_created",
        "library_invitations",
        [
            "library_id",
            "status",
            sa.text("created_at DESC"),
            sa.text("id DESC"),
        ],
    )
    op.create_index(
        "idx_library_invitations_invitee_status_created",
        "library_invitations",
        [
            "invitee_user_id",
            "status",
            sa.text("created_at DESC"),
            sa.text("id DESC"),
        ],
    )

    # --- default_library_intrinsics ---
    op.create_table(
        "default_library_intrinsics",
        sa.Column(
            "default_library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_index(
        "idx_default_library_intrinsics_media",
        "default_library_intrinsics",
        ["media_id", "default_library_id"],
    )

    # --- default_library_closure_edges ---
    op.create_table(
        "default_library_closure_edges",
        sa.Column(
            "default_library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "source_library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_index(
        "idx_default_library_closure_edges_source",
        "default_library_closure_edges",
        ["source_library_id", "default_library_id", "media_id"],
    )
    op.create_index(
        "idx_default_library_closure_edges_default_media",
        "default_library_closure_edges",
        ["default_library_id", "media_id"],
    )

    # --- default_library_backfill_jobs ---
    op.create_table(
        "default_library_backfill_jobs",
        sa.Column(
            "default_library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "source_library_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column(
            "attempts", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("last_error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("finished_at", TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed')",
            name="ck_default_library_backfill_jobs_status",
        ),
        sa.CheckConstraint(
            "attempts >= 0",
            name="ck_default_library_backfill_jobs_attempts",
        ),
        sa.CheckConstraint(
            "(status IN ('pending', 'running') AND finished_at IS NULL) "
            "OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)",
            name="ck_default_library_backfill_jobs_finished_at_state",
        ),
    )

    op.create_index(
        "idx_default_library_backfill_jobs_status_updated",
        "default_library_backfill_jobs",
        ["status", sa.text("updated_at ASC")],
    )

    # =========================================================================
    # Step 2: Supporting indexes on existing tables
    # =========================================================================

    op.create_index(
        "idx_memberships_user_library_role",
        "memberships",
        ["user_id", "library_id", "role"],
    )
    op.create_index(
        "idx_library_media_media_library",
        "library_media",
        ["media_id", "library_id"],
    )
    op.create_index(
        "idx_conversation_shares_library_conversation",
        "conversation_shares",
        ["library_id", "conversation_id"],
    )

    # =========================================================================
    # Step 3: Deterministic seed transform (s4 spec §3.7)
    # =========================================================================

    # 3a. Seed closure edges from non-default membership + library_media.
    # For each non-default library L, for each member u in L, for each media m
    # in L, insert edge (d(u), m, L).
    conn.execute(
        sa.text("""
            INSERT INTO default_library_closure_edges
                (default_library_id, media_id, source_library_id)
            SELECT d.id, lm.media_id, lm.library_id
            FROM memberships m
            JOIN libraries src ON src.id = m.library_id AND src.is_default = false
            JOIN library_media lm ON lm.library_id = src.id
            JOIN libraries d ON d.owner_user_id = m.user_id AND d.is_default = true
            ON CONFLICT DO NOTHING
        """)
    )

    # 3b. Seed intrinsics for existing default-library library_media rows that
    # have no corresponding closure edge.
    conn.execute(
        sa.text("""
            INSERT INTO default_library_intrinsics
                (default_library_id, media_id)
            SELECT lm.library_id, lm.media_id
            FROM library_media lm
            JOIN libraries l ON l.id = lm.library_id AND l.is_default = true
            WHERE NOT EXISTS (
                SELECT 1 FROM default_library_closure_edges e
                WHERE e.default_library_id = lm.library_id
                  AND e.media_id = lm.media_id
            )
            ON CONFLICT DO NOTHING
        """)
    )


def downgrade() -> None:
    # Drop supporting indexes on existing tables
    op.drop_index(
        "idx_conversation_shares_library_conversation",
        table_name="conversation_shares",
    )
    op.drop_index(
        "idx_library_media_media_library",
        table_name="library_media",
    )
    op.drop_index(
        "idx_memberships_user_library_role",
        table_name="memberships",
    )

    # Drop new tables in reverse creation order
    op.drop_table("default_library_backfill_jobs")
    op.drop_table("default_library_closure_edges")
    op.drop_table("default_library_intrinsics")
    op.drop_table("library_invitations")
