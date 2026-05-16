"""Add first-class message artifact versions.

Revision ID: 0095
Revises: 0094
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0095"
down_revision: str | None = "0094"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "message_artifacts",
        sa.Column("artifact_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "message_artifacts",
        sa.Column("supersedes_artifact_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY message_id, artifact_key
                       ORDER BY created_at, id
                   ) AS artifact_version,
                   lag(id) OVER (
                       PARTITION BY message_id, artifact_key
                       ORDER BY created_at, id
                   ) AS supersedes_artifact_id
            FROM message_artifacts
            WHERE artifact_key IS NOT NULL
        )
        UPDATE message_artifacts ma
        SET artifact_version = ranked.artifact_version,
            supersedes_artifact_id = ranked.supersedes_artifact_id
        FROM ranked
        WHERE ma.id = ranked.id
        """
    )
    op.create_check_constraint(
        "ck_message_artifacts_version_positive",
        "message_artifacts",
        "artifact_version >= 1",
    )
    op.create_check_constraint(
        "ck_message_artifacts_not_self_supersedes",
        "message_artifacts",
        "supersedes_artifact_id IS NULL OR supersedes_artifact_id != id",
    )
    op.create_foreign_key(
        "fk_message_artifacts_supersedes_artifact_id",
        "message_artifacts",
        "message_artifacts",
        ["supersedes_artifact_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uix_message_artifacts_message_key_version",
        "message_artifacts",
        ["message_id", "artifact_key", "artifact_version"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uix_message_artifacts_message_key_version",
        "message_artifacts",
        type_="unique",
    )
    op.drop_constraint(
        "fk_message_artifacts_supersedes_artifact_id",
        "message_artifacts",
        type_="foreignkey",
    )
    op.drop_constraint(
        "ck_message_artifacts_not_self_supersedes",
        "message_artifacts",
        type_="check",
    )
    op.drop_constraint(
        "ck_message_artifacts_version_positive",
        "message_artifacts",
        type_="check",
    )
    op.drop_column("message_artifacts", "supersedes_artifact_id")
    op.drop_column("message_artifacts", "artifact_version")
