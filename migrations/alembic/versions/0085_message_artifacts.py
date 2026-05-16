"""Add durable message artifacts.

Revision ID: 0085_message_artifacts
Revises: 0084
Create Date: 2026-05-14
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0085_message_artifacts"
down_revision = "0084"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "message_artifacts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("artifact_key", sa.Text(), nullable=True),
        sa.Column("artifact_kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="complete"),
        sa.Column("preview_text", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(artifact_kind)) BETWEEN 1 AND 128",
            name="ck_message_artifacts_kind_length",
        ),
        sa.CheckConstraint(
            "artifact_key IS NULL OR char_length(btrim(artifact_key)) BETWEEN 1 AND 128",
            name="ck_message_artifacts_key_length",
        ),
        sa.CheckConstraint(
            "status IN ('streaming', 'complete', 'error')",
            name="ck_message_artifacts_status",
        ),
        sa.CheckConstraint(
            "title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 500",
            name="ck_message_artifacts_title_length",
        ),
        sa.CheckConstraint(
            "preview_text IS NULL OR char_length(preview_text) <= 20000",
            name="ck_message_artifacts_preview_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_message_artifacts_metadata_object",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["chat_run_id"], ["chat_runs.id"]),
        sa.UniqueConstraint("message_id", "artifact_key", name="uix_message_artifacts_message_key"),
    )
    op.create_index(
        "idx_message_artifacts_message_created",
        "message_artifacts",
        ["message_id", "created_at", "id"],
    )

    op.create_table(
        "message_artifact_parts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("part_key", sa.Text(), nullable=True),
        sa.Column("part_type", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("source_ref", postgresql.JSONB(), nullable=True),
        sa.Column("context_ref", postgresql.JSONB(), nullable=True),
        sa.Column("result_ref", postgresql.JSONB(), nullable=True),
        sa.Column("evidence_span_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "evidence_span_ids",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "source_refs",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "ordinal >= 0",
            name="ck_message_artifact_parts_ordinal",
        ),
        sa.CheckConstraint(
            "part_key IS NULL OR char_length(btrim(part_key)) BETWEEN 1 AND 128",
            name="ck_message_artifact_parts_key_length",
        ),
        sa.CheckConstraint(
            "part_type IS NULL OR char_length(btrim(part_type)) BETWEEN 1 AND 128",
            name="ck_message_artifact_parts_type_length",
        ),
        sa.CheckConstraint(
            "source_ref IS NULL OR source_ref = 'null'::jsonb OR jsonb_typeof(source_ref) = 'object'",
            name="ck_message_artifact_parts_source_ref_object",
        ),
        sa.CheckConstraint(
            "context_ref IS NULL OR context_ref = 'null'::jsonb OR jsonb_typeof(context_ref) = 'object'",
            name="ck_message_artifact_parts_context_ref_object",
        ),
        sa.CheckConstraint(
            "result_ref IS NULL OR result_ref = 'null'::jsonb OR jsonb_typeof(result_ref) = 'object'",
            name="ck_message_artifact_parts_result_ref_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(evidence_span_ids) = 'array'",
            name="ck_message_artifact_parts_evidence_span_ids_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_refs) = 'array'",
            name="ck_message_artifact_parts_source_refs_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_message_artifact_parts_metadata_object",
        ),
        sa.ForeignKeyConstraint(["artifact_id"], ["message_artifacts.id"]),
        sa.ForeignKeyConstraint(["evidence_span_id"], ["evidence_spans.id"]),
        sa.UniqueConstraint("artifact_id", "ordinal", name="uix_message_artifact_parts_ordinal"),
    )
    op.create_index(
        "idx_message_artifact_parts_artifact_ordinal",
        "message_artifact_parts",
        ["artifact_id", "ordinal", "id"],
    )
    op.create_index(
        "idx_message_artifact_parts_evidence_span",
        "message_artifact_parts",
        ["evidence_span_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_message_artifact_parts_evidence_span", table_name="message_artifact_parts")
    op.drop_index(
        "idx_message_artifact_parts_artifact_ordinal", table_name="message_artifact_parts"
    )
    op.drop_table("message_artifact_parts")
    op.drop_index("idx_message_artifacts_message_created", table_name="message_artifacts")
    op.drop_table("message_artifacts")
