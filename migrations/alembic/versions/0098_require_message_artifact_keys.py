"""Require stable message artifact keys.

Revision ID: 0098
Revises: 0097
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0098"
down_revision: str | None = "0097"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE message_artifacts
        SET artifact_key = 'artifact-' || id::text
        WHERE artifact_key IS NULL
        """
    )
    op.drop_constraint("ck_message_artifacts_key_length", "message_artifacts", type_="check")
    op.create_check_constraint(
        "ck_message_artifacts_key_length",
        "message_artifacts",
        "char_length(btrim(artifact_key)) BETWEEN 1 AND 128",
    )
    op.alter_column("message_artifacts", "artifact_key", existing_type=sa.Text(), nullable=False)


def downgrade() -> None:
    op.alter_column("message_artifacts", "artifact_key", existing_type=sa.Text(), nullable=True)
    op.drop_constraint("ck_message_artifacts_key_length", "message_artifacts", type_="check")
    op.create_check_constraint(
        "ck_message_artifacts_key_length",
        "message_artifacts",
        "artifact_key IS NULL OR char_length(btrim(artifact_key)) BETWEEN 1 AND 128",
    )
