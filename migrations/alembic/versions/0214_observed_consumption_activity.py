"""Remove positive manual activity and retain exact observed exclusions.

Revision ID: 0214
Revises: 0213
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0214"
down_revision: str | Sequence[str] | None = "0213"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    invalid_rows = connection.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM consumption_activity_adjustments
            WHERE kind NOT IN ('Add', 'Exclude')
               OR (
                    kind = 'Exclude'
                    AND (
                        modality NOT IN ('Reading', 'Listening', 'Viewing')
                        OR device_id IS NULL
                        OR device_id = ''
                        OR duration_ms <= 0
                    )
               )
            """
        )
    )
    if invalid_rows:
        raise RuntimeError(f"invalid legacy Consumption activity adjustment rows: {invalid_rows}")

    op.execute("DELETE FROM consumption_activity_adjustments WHERE kind = 'Add'")
    op.execute(
        "DELETE FROM resource_mutations WHERE mutation_scope = 'Consumption.ActivityAdjustments'"
    )

    op.rename_table("consumption_activity_adjustments", "consumption_activity_exclusions")
    op.execute(
        "ALTER TABLE consumption_activity_exclusions "
        "RENAME CONSTRAINT consumption_activity_adjustments_pkey "
        "TO consumption_activity_exclusions_pkey"
    )
    op.execute(
        "ALTER TABLE consumption_activity_exclusions "
        "RENAME CONSTRAINT fk_consumption_activity_adjustments_user "
        "TO fk_consumption_activity_exclusions_user"
    )
    op.execute(
        "ALTER TABLE consumption_activity_exclusions "
        "RENAME CONSTRAINT fk_consumption_activity_adjustments_media "
        "TO fk_consumption_activity_exclusions_media"
    )
    op.alter_column(
        "consumption_activity_exclusions",
        "occurred_at",
        new_column_name="started_at",
    )
    op.alter_column(
        "consumption_activity_exclusions",
        "retracted_at",
        new_column_name="restored_at",
    )
    op.add_column(
        "consumption_activity_exclusions",
        sa.Column("ended_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE consumption_activity_exclusions "
        "SET ended_at = started_at + duration_ms * interval '1 millisecond'"
    )
    op.alter_column("consumption_activity_exclusions", "ended_at", nullable=False)
    op.alter_column("consumption_activity_exclusions", "device_id", nullable=False)
    op.drop_column("consumption_activity_exclusions", "kind")
    op.drop_column("consumption_activity_exclusions", "duration_ms")

    op.execute(
        "ALTER INDEX ix_consumption_activity_adjustments_user_occurred_id "
        "RENAME TO ix_consumption_activity_exclusions_user_started_id"
    )
    op.execute(
        "ALTER INDEX ix_cons_activity_adj_user_media_device_time_id "
        "RENAME TO ix_cons_activity_exclusions_user_media_device_started_id"
    )
    op.execute(
        "ALTER INDEX ix_consumption_activity_adjustments_media_id "
        "RENAME TO ix_consumption_activity_exclusions_media_id"
    )


def downgrade() -> None:
    raise NotImplementedError("0214 is a hard cutover migration and has no downgrade path")
