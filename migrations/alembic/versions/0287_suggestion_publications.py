"""Publish bounded suggestion pools independently of request serving."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

from nexus.ids import new_uuid7

revision = "0287"
down_revision = "0286"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "suggestion_inputs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("revision", sa.BigInteger(), nullable=False),
    )
    op.execute(
        sa.text(
            "INSERT INTO suggestion_inputs (id, revision) VALUES (:id, 0)"
        ).bindparams(id=new_uuid7())
    )
    op.create_table(
        "suggestion_feeds",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "library_id",
            UUID(as_uuid=True),
            sa.ForeignKey("libraries.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "current_job_id",
            UUID(as_uuid=True),
            sa.ForeignKey("background_jobs.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "uq_suggestion_feeds_lectern",
        "suggestion_feeds",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("library_id IS NULL"),
    )
    op.create_index(
        "uq_suggestion_feeds_library",
        "suggestion_feeds",
        ["user_id", "library_id"],
        unique=True,
        postgresql_where=sa.text("library_id IS NOT NULL"),
    )
    op.create_table(
        "suggestion_shortlists",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "feed_id",
            UUID(as_uuid=True),
            sa.ForeignKey("suggestion_feeds.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ranked_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("ranked_revision", sa.BigInteger(), nullable=False),
        sa.Column("target_refs", JSONB, nullable=False),
        sa.UniqueConstraint("feed_id", name="uq_suggestion_shortlists_feed"),
    )


def downgrade() -> None:
    raise NotImplementedError(
        "suggestions publication cutover requires the verified release backup"
    )
