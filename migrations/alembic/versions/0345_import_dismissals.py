"""Reader-owned import attention acknowledgements.

Data effects: none; create an empty table. No existing obligation is dismissed.
"""

import sqlalchemy as sa
from alembic import op

revision = "0345"
down_revision = "0344"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "import_dismissals",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("media_id", sa.UUID(), sa.ForeignKey("media.id"), nullable=False),
        sa.Column("through", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("user_id", "media_id", name="uq_import_dismissals_user_media"),
    )


def downgrade() -> None:
    raise RuntimeError("0345 is a hard cut; restore the verified backup and paired release")
