"""Add explicit chat-run artifact intent.

Revision ID: 0102
Revises: 0101
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0102"
down_revision: str | None = "0101"
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
    op.add_column(
        "chat_runs",
        sa.Column(
            "artifact_intent",
            postgresql.JSONB(),
            server_default=sa.text("""'{"kind":"off"}'::jsonb"""),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_chat_runs_artifact_intent_kind",
        "chat_runs",
        "jsonb_typeof(artifact_intent) = 'object' "
        "AND artifact_intent->>'kind' IN ("
        f"'off', 'auto', {MESSAGE_ARTIFACT_KIND_VALUES}"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint("ck_chat_runs_artifact_intent_kind", "chat_runs", type_="check")
    op.drop_column("chat_runs", "artifact_intent")
