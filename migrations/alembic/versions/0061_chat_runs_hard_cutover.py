"""Add durable chat runs and replay events.

Revision ID: 0061
Revises: 0060
Create Date: 2026-04-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0061"
down_revision: str | None = "0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("model_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reasoning", sa.Text(), nullable=False),
        sa.Column("key_mode", sa.Text(), nullable=False),
        sa.Column("web_search", postgresql.JSONB(), nullable=False),
        sa.Column("next_event_seq", sa.Integer(), server_default="1", nullable=False),
        sa.Column("cancel_requested_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'complete', 'error', 'cancelled')",
            name="ck_chat_runs_status",
        ),
        sa.CheckConstraint(
            "length(idempotency_key) >= 1 AND length(idempotency_key) <= 128",
            name="ck_chat_runs_idempotency_key_length",
        ),
        sa.CheckConstraint(
            "next_event_seq >= 1",
            name="ck_chat_runs_next_event_seq_positive",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["assistant_message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["model_id"], ["models.id"]),
        sa.UniqueConstraint(
            "owner_user_id",
            "idempotency_key",
            name="uix_chat_runs_owner_idempotency_key",
        ),
    )
    op.create_index(
        "idx_chat_runs_owner_created",
        "chat_runs",
        ["owner_user_id", "created_at", "id"],
    )

    op.create_table(
        "chat_run_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("seq >= 1", name="ck_chat_run_events_seq_positive"),
        sa.CheckConstraint(
            "event_type IN ('meta', 'tool_call', 'tool_result', 'citation', 'delta', 'done')",
            name="ck_chat_run_events_event_type",
        ),
        sa.ForeignKeyConstraint(["run_id"], ["chat_runs.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("run_id", "seq", name="uix_chat_run_events_run_seq"),
    )
    op.create_index("idx_chat_run_events_run_seq", "chat_run_events", ["run_id", "seq"])

    op.drop_index("idx_stream_liveness_markers_expires_at", table_name="stream_liveness_markers")
    op.drop_table("stream_liveness_markers")

    op.drop_index("idx_idempotency_keys_expires_at", table_name="idempotency_keys")
    op.drop_index("idx_idempotency_keys_user_created", table_name="idempotency_keys")
    op.drop_constraint("ck_idempotency_keys_key_length", "idempotency_keys", type_="check")
    op.drop_table("idempotency_keys")


def downgrade() -> None:
    op.create_table(
        "idempotency_keys",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("key", sa.Text(), primary_key=True, nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column("user_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(key) >= 1 AND length(key) <= 128",
            name="ck_idempotency_keys_key_length",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["assistant_message_id"], ["messages.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_idempotency_keys_user_created", "idempotency_keys", ["user_id", "created_at"])
    op.create_index("idx_idempotency_keys_expires_at", "idempotency_keys", ["expires_at"])

    op.create_table(
        "stream_liveness_markers",
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["assistant_message_id"], ["messages.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_stream_liveness_markers_expires_at",
        "stream_liveness_markers",
        ["expires_at"],
    )

    op.drop_index("idx_chat_run_events_run_seq", table_name="chat_run_events")
    op.drop_table("chat_run_events")
    op.drop_index("idx_chat_runs_owner_created", table_name="chat_runs")
    op.drop_table("chat_runs")
