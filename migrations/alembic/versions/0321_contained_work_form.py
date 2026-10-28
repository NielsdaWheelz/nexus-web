"""Remove contained-work form labels without changing pieces or discovery history.

Revision ID: 0321
Revises: 0320

Data effects: preflight every non-null candidate finding's old top-level shape
and form value, then remove only finding.form and the media_parts.form column.
SQL-null findings, decisions, bindings and all remaining data stay unchanged.
Writers must be stopped; downgrade requires the verified pre-release backup and
matching binaries. Captured discovery jobs retain their inputs and are fenced
by the new prompt version when resumed.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0321"
down_revision: str | Sequence[str] | None = "0320"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    for row in connection.execute(
        sa.text("SELECT id, finding FROM media_part_candidates WHERE finding IS NOT NULL")
    ):
        finding = row.finding
        if (
            not isinstance(finding, dict)
            or set(finding)
            != {
                "section_ids",
                "verdict",
                "title",
                "form",
                "contributors",
                "evidence",
                "uncertainty_reason",
            }
            or finding["form"] not in (None, "essay", "poem", "letter", "short_story", "section")
        ):
            raise RuntimeError(f"candidate {row.id} cannot convert contained-work finding")
    connection.execute(
        sa.text(
            "UPDATE media_part_candidates SET finding = finding - 'form' WHERE finding IS NOT NULL"
        )
    )
    op.drop_column("media_parts", "form")


def downgrade() -> None:
    raise RuntimeError(
        "Restore the verified pre-release backup and matching binaries to downgrade"
    )
