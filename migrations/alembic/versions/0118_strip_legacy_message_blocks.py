"""Strip legacy verifier/claim/citation-audit blocks from message_document.

Migration 0116 dropped the verifier tables but left the embedded
verification_summary / citation_audit / claim / claim_evidence blocks inside
messages.message_document. MessageDocument's current discriminator only
accepts text / source_manifest / retrieval_result, so loading any historical
assistant message with a legacy block raises ValidationError and breaks
GET /api/conversations/{id}/messages.

Revision ID: 0118
Revises: 0117
Create Date: 2026-05-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0118"
down_revision: str | None = "0117"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE messages
        SET message_document = jsonb_set(
            message_document,
            '{blocks}',
            COALESCE(
                (
                    SELECT jsonb_agg(b)
                    FROM jsonb_array_elements(message_document->'blocks') b
                    WHERE b->>'type' IN ('text','source_manifest','retrieval_result')
                ),
                '[]'::jsonb
            )
        )
        WHERE message_document IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(message_document->'blocks') b
              WHERE b->>'type' NOT IN ('text','source_manifest','retrieval_result')
          )
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0118 is not reversible")
