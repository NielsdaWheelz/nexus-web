"""Remove unused dossier failure support from stored events and rows.

Revision ID: 0235
Revises: 0234
Create Date: 2026-09-17
"""

from alembic import op

revision: str = "0235"
down_revision: str = "0234"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.execute(
        "UPDATE artifact_build_events SET payload = payload - 'support' "
        "WHERE event_type IN ('Failed', 'HistoricalFailed') AND payload ? 'support'"
    )
    op.drop_constraint(
        "ck_artifact_build_failures_support_object",
        "artifact_build_failures",
        type_="check",
    )
    op.drop_column("artifact_build_failures", "support")


def downgrade() -> None:
    raise NotImplementedError("0235 removes unused dossier failure metadata irreversibly")
