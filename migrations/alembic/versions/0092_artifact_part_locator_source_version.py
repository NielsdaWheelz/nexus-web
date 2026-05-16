"""Persist artifact part locators and source versions.

Revision ID: 0092_artifact_part_sources
Revises: 0091_claim_verifier_hardening
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0092_artifact_part_sources"
down_revision: str | None = "0091_claim_verifier_hardening"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE assistant_message_claim_evidence
        SET exact_snippet = NULL
        WHERE evidence_role NOT IN ('supports', 'contradicts')
          AND exact_snippet IS NOT NULL
          AND btrim(exact_snippet) = ''
        """
    )
    op.drop_constraint(
        "ck_assistant_claim_evidence_snippet_required",
        "assistant_message_claim_evidence",
        type_="check",
    )
    op.create_check_constraint(
        "ck_assistant_claim_evidence_snippet_required",
        "assistant_message_claim_evidence",
        """
        evidence_role NOT IN ('supports', 'contradicts')
        OR (exact_snippet IS NOT NULL AND char_length(btrim(exact_snippet)) > 0)
        """,
    )
    op.drop_constraint(
        "uix_source_manifests_run_tool_call_index",
        "source_manifests",
        type_="unique",
    )
    op.create_index(
        "idx_source_manifests_run_tool_call_created",
        "source_manifests",
        ["chat_run_id", "tool_call_index", "created_at", "id"],
    )
    op.add_column("message_artifact_parts", sa.Column("source_version", sa.Text()))
    op.add_column("message_artifact_parts", sa.Column("locator", postgresql.JSONB()))
    op.execute(
        """
        UPDATE message_artifact_parts part
        SET source_version = concat('artifact_part', chr(58), part.id::text, chr(58), 'v1'),
            locator = jsonb_strip_nulls(jsonb_build_object(
                'type', 'artifact_part_ref',
                'artifact_id', part.artifact_id::text,
                'artifact_part_id', part.id::text,
                'message_id', artifact.message_id::text,
                'conversation_id', artifact.conversation_id::text,
                'part_key', part.part_key
            ))
        FROM message_artifacts artifact
        WHERE artifact.id = part.artifact_id
        """
    )
    op.alter_column("message_artifact_parts", "source_version", nullable=False)
    op.alter_column("message_artifact_parts", "locator", nullable=False)
    op.execute(
        """
        UPDATE message_artifact_parts
        SET source_ref = NULLIF(source_ref, 'null'::jsonb),
            context_ref = NULLIF(context_ref, 'null'::jsonb),
            result_ref = NULLIF(result_ref, 'null'::jsonb)
        """
    )
    op.drop_constraint(
        "ck_message_artifact_parts_source_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_context_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_result_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_source_ref_object",
        "message_artifact_parts",
        "source_ref IS NULL OR jsonb_typeof(source_ref) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_context_ref_object",
        "message_artifact_parts",
        "context_ref IS NULL OR jsonb_typeof(context_ref) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_result_ref_object",
        "message_artifact_parts",
        "result_ref IS NULL OR jsonb_typeof(result_ref) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_source_version",
        "message_artifact_parts",
        "char_length(btrim(source_version)) BETWEEN 1 AND 256",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_locator_object",
        "message_artifact_parts",
        "jsonb_typeof(locator) = 'object'",
    )
    op.execute(
        """
        UPDATE message_artifact_parts
        SET metadata = COALESCE(metadata, '{}'::jsonb)
            || '{"support_state":"not_source_grounded"}'::jsonb
        WHERE source_ref IS NULL
          AND context_ref IS NULL
          AND result_ref IS NULL
          AND evidence_span_id IS NULL
          AND jsonb_array_length(evidence_span_ids) = 0
          AND jsonb_array_length(source_refs) = 0
          AND COALESCE(metadata, '{}'::jsonb) ->> 'support_state' IS NULL
        """
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_evidence_required",
        "message_artifact_parts",
        """
        source_ref IS NOT NULL
        OR context_ref IS NOT NULL
        OR result_ref IS NOT NULL
        OR evidence_span_id IS NOT NULL
        OR jsonb_array_length(evidence_span_ids) > 0
        OR jsonb_array_length(source_refs) > 0
        OR metadata ->> 'support_state' = 'not_source_grounded'
        """,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_assistant_claim_evidence_snippet_required",
        "assistant_message_claim_evidence",
        type_="check",
    )
    op.create_check_constraint(
        "ck_assistant_claim_evidence_snippet_required",
        "assistant_message_claim_evidence",
        """
        evidence_role NOT IN ('supports', 'contradicts')
        OR exact_snippet IS NOT NULL
        """,
    )
    op.drop_constraint(
        "ck_message_artifact_parts_evidence_required",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_locator_object",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_source_version",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_result_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_context_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifact_parts_source_ref_object",
        "message_artifact_parts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_source_ref_object",
        "message_artifact_parts",
        "source_ref IS NULL OR source_ref = 'null'::jsonb OR jsonb_typeof(source_ref) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_context_ref_object",
        "message_artifact_parts",
        "context_ref IS NULL OR context_ref = 'null'::jsonb OR jsonb_typeof(context_ref) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_artifact_parts_result_ref_object",
        "message_artifact_parts",
        "result_ref IS NULL OR result_ref = 'null'::jsonb OR jsonb_typeof(result_ref) = 'object'",
    )
    op.drop_column("message_artifact_parts", "locator")
    op.drop_column("message_artifact_parts", "source_version")
    op.drop_index(
        "idx_source_manifests_run_tool_call_created",
        table_name="source_manifests",
    )
    op.execute(
        """
        DELETE FROM source_manifests older
        USING source_manifests newer
        WHERE older.chat_run_id = newer.chat_run_id
          AND older.tool_call_index = newer.tool_call_index
          AND (
              older.created_at < newer.created_at
              OR (older.created_at = newer.created_at AND older.id < newer.id)
          )
        """
    )
    op.create_unique_constraint(
        "uix_source_manifests_run_tool_call_index",
        "source_manifests",
        ["chat_run_id", "tool_call_index"],
    )
