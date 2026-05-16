"""Restrict generated message artifact kinds.

Revision ID: 0103
Revises: 0102
Create Date: 2026-05-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0103"
down_revision: str | None = "0102"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MESSAGE_ARTIFACT_KIND_VALUES = (
    "'briefing_document', 'study_guide', 'faq', 'timeline', "
    "'comparison_table', 'extraction_table', 'claim_table', "
    "'contradiction_report', 'source_map', 'concept_map', 'outline', "
    "'flashcards', 'quiz', 'audio_overview_script', 'audio_overview', "
    "'video_slide_overview_manifest', 'bibliography', 'citation_audit'"
)


def upgrade() -> None:
    op.execute(
        """
        UPDATE message_artifacts
        SET artifact_kind = CASE artifact_kind
            WHEN 'brief' THEN 'briefing_document'
            WHEN 'table' THEN 'comparison_table'
            ELSE artifact_kind
        END
        WHERE artifact_kind IN ('brief', 'table')
        """
    )
    op.create_check_constraint(
        "ck_message_artifacts_kind_supported",
        "message_artifacts",
        f"artifact_kind IN ({MESSAGE_ARTIFACT_KIND_VALUES})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_message_artifacts_kind_supported", "message_artifacts", type_="check")
