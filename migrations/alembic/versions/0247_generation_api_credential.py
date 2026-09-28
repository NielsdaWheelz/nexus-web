"""Bind native generation API admission to one account and job execution.

Revision ID: 0247
Revises: 0246
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0247"
down_revision: str | Sequence[str] | None = "0246"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_tool_positions",
        sa.Column("reverted_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_llm_tool_positions_generation_api_key",
        "llm_tool_positions",
        ["generation_id", "transport_call_id"],
        unique=True,
        postgresql_where=sa.text("transport_kind = 'GenerationApi'"),
    )
    op.create_table(
        "generation_api_credentials",
        sa.Column(
            "generation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("llm_calls.id"),
            primary_key=True,
        ),
        sa.Column("token_sha256", sa.Text(), nullable=False),
        sa.Column("job_execution_id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("closed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.UniqueConstraint("token_sha256", name="uq_generation_api_credentials_token_sha256"),
    )


def downgrade() -> None:
    op.drop_table("generation_api_credentials")
    op.drop_index("uq_llm_tool_positions_generation_api_key", table_name="llm_tool_positions")
    op.drop_column("llm_tool_positions", "reverted_at")
