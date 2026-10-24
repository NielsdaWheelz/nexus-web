"""add a positive account consumption observation watermark.

revision: 0315; parent: 0314. initializes every account at 1 without changing
positions, overrides, epochs, history or membership. no data conversion or loss.
"""

import sqlalchemy as sa
from alembic import op

revision = "0315"
down_revision = "0314"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "consumption_revision", sa.BigInteger(), nullable=False, server_default="1"
        ),
    )
    op.create_check_constraint(
        "ck_users_consumption_revision_positive", "users", "consumption_revision > 0"
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_consumption_revision_positive", "users", type_="check")
    op.drop_column("users", "consumption_revision")
