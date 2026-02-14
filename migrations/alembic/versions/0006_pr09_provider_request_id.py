"""PR-09: Add provider_request_id to message_llm

Revision ID: 0006
Revises: 0005
Create Date: 2026-02-14

Per PR-09 spec §7.4:
- High-leverage debugging field for cross-referencing with provider dashboards
- Nullable TEXT column; populated when providers return request IDs in headers
- OpenAI: x-request-id header
- Anthropic: request-id header or body id
- Gemini: best-effort; may be NULL
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic
revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "message_llm",
        sa.Column("provider_request_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("message_llm", "provider_request_id")
