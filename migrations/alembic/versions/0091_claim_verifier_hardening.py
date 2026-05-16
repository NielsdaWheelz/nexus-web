"""Harden persisted claim verifier outputs.

Revision ID: 0091_claim_verifier_hardening
Revises: 0090_artifact_part_context_refs
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0091_claim_verifier_hardening"
down_revision: str | None = "0090_artifact_part_context_refs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE assistant_message_verifier_runs "
        "SET verifier_status = 'failed' "
        "WHERE verifier_status = 'lexical_baseline'"
    )
    op.execute(
        "UPDATE assistant_message_evidence_summaries "
        "SET verifier_status = 'failed' "
        "WHERE verifier_status = 'lexical_baseline'"
    )
    op.execute(
        "UPDATE assistant_message_claims "
        "SET verifier_status = 'failed' "
        "WHERE verifier_status = 'lexical_baseline'"
    )
    op.drop_constraint(
        "ck_assistant_verifier_runs_status",
        "assistant_message_verifier_runs",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        type_="check",
    )
    op.create_check_constraint(
        "ck_assistant_verifier_runs_status",
        "assistant_message_verifier_runs",
        "verifier_status IN ('llm_verified', 'parse_failed', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        "verifier_status IN ('llm_verified', 'parse_failed', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        "verifier_status IN ('llm_verified', 'parse_failed', 'failed')",
    )
    op.drop_constraint(
        "uix_assistant_citation_audits_message",
        "assistant_message_citation_audits",
        type_="unique",
    )
    op.create_index(
        "idx_assistant_citation_audits_message_created",
        "assistant_message_citation_audits",
        ["message_id", "created_at", "id"],
    )
    op.add_column("assistant_message_claims", sa.Column("unsupported_reason", sa.Text()))
    op.add_column("assistant_message_claims", sa.Column("confidence", sa.Float()))
    op.create_check_constraint(
        "ck_assistant_claims_unsupported_reason",
        "assistant_message_claims",
        "unsupported_reason IS NULL OR char_length(btrim(unsupported_reason)) BETWEEN 1 AND 2000",
    )
    op.create_check_constraint(
        "ck_assistant_claims_confidence",
        "assistant_message_claims",
        "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
    )
    op.create_check_constraint(
        "ck_assistant_claim_evidence_support_locator_required",
        "assistant_message_claim_evidence",
        "evidence_role NOT IN ('supports', 'contradicts') OR "
        "(locator IS NOT NULL AND locator != 'null'::jsonb)",
    )
    op.create_check_constraint(
        "ck_assistant_claim_evidence_support_source_version_required",
        "assistant_message_claim_evidence",
        "evidence_role NOT IN ('supports', 'contradicts') OR "
        "(source_version IS NOT NULL AND char_length(btrim(source_version)) > 0)",
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_assistant_citation_audits_message_created")
    op.execute(
        """
        DELETE FROM assistant_message_citation_audits older
        USING assistant_message_citation_audits newer
        WHERE older.message_id = newer.message_id
          AND (
              older.created_at < newer.created_at
              OR (older.created_at = newer.created_at AND older.id < newer.id)
          )
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uix_assistant_citation_audits_message'
            ) THEN
                ALTER TABLE assistant_message_citation_audits
                ADD CONSTRAINT uix_assistant_citation_audits_message UNIQUE (message_id);
            END IF;
        END $$;
        """
    )
    op.drop_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_verifier_runs_status",
        "assistant_message_verifier_runs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_verifier_runs_status",
        "assistant_message_verifier_runs",
        "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
    )
    op.drop_constraint(
        "ck_assistant_claim_evidence_support_source_version_required",
        "assistant_message_claim_evidence",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claim_evidence_support_locator_required",
        "assistant_message_claim_evidence",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claims_confidence",
        "assistant_message_claims",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claims_unsupported_reason",
        "assistant_message_claims",
        type_="check",
    )
    op.drop_column("assistant_message_claims", "confidence")
    op.drop_column("assistant_message_claims", "unsupported_reason")
