"""Remove claim evidence database cascades.

Revision ID: 0097
Revises: 0096
Create Date: 2026-05-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0097"
down_revision: str | None = "0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE assistant_message_evidence_summaries
        DROP CONSTRAINT IF EXISTS assistant_message_evidence_summaries_message_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_evidence_summaries
        DROP CONSTRAINT IF EXISTS assistant_message_evidence_summaries_prompt_assembly_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_claims
        DROP CONSTRAINT IF EXISTS assistant_message_claims_message_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_claim_evidence
        DROP CONSTRAINT IF EXISTS assistant_message_claim_evidence_claim_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_claim_evidence
        DROP CONSTRAINT IF EXISTS assistant_message_claim_evidence_retrieval_id_fkey
        """
    )
    op.create_foreign_key(
        "assistant_message_evidence_summaries_message_id_fkey",
        "assistant_message_evidence_summaries",
        "messages",
        ["message_id"],
        ["id"],
    )
    op.create_foreign_key(
        "assistant_message_evidence_summaries_prompt_assembly_id_fkey",
        "assistant_message_evidence_summaries",
        "chat_prompt_assemblies",
        ["prompt_assembly_id"],
        ["id"],
    )
    op.create_foreign_key(
        "assistant_message_claims_message_id_fkey",
        "assistant_message_claims",
        "messages",
        ["message_id"],
        ["id"],
    )
    op.create_foreign_key(
        "assistant_message_claim_evidence_claim_id_fkey",
        "assistant_message_claim_evidence",
        "assistant_message_claims",
        ["claim_id"],
        ["id"],
    )
    op.create_foreign_key(
        "assistant_message_claim_evidence_retrieval_id_fkey",
        "assistant_message_claim_evidence",
        "message_retrievals",
        ["retrieval_id"],
        ["id"],
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE assistant_message_claim_evidence
        DROP CONSTRAINT IF EXISTS assistant_message_claim_evidence_retrieval_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_claim_evidence
        DROP CONSTRAINT IF EXISTS assistant_message_claim_evidence_claim_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_claims
        DROP CONSTRAINT IF EXISTS assistant_message_claims_message_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_evidence_summaries
        DROP CONSTRAINT IF EXISTS assistant_message_evidence_summaries_prompt_assembly_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE assistant_message_evidence_summaries
        DROP CONSTRAINT IF EXISTS assistant_message_evidence_summaries_message_id_fkey
        """
    )
    op.create_foreign_key(
        "assistant_message_evidence_summaries_message_id_fkey",
        "assistant_message_evidence_summaries",
        "messages",
        ["message_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "assistant_message_evidence_summaries_prompt_assembly_id_fkey",
        "assistant_message_evidence_summaries",
        "chat_prompt_assemblies",
        ["prompt_assembly_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "assistant_message_claims_message_id_fkey",
        "assistant_message_claims",
        "messages",
        ["message_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "assistant_message_claim_evidence_claim_id_fkey",
        "assistant_message_claim_evidence",
        "assistant_message_claims",
        ["claim_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "assistant_message_claim_evidence_retrieval_id_fkey",
        "assistant_message_claim_evidence",
        "message_retrievals",
        ["retrieval_id"],
        ["id"],
        ondelete="SET NULL",
    )
