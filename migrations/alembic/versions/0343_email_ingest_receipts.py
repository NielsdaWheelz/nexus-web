"""Keep email receipt identity after content removal.

Data effects: require an empty legacy email corpus; old truncated identities and
sender credits cannot be converted without guessing. Add minimal durable receipts
and remove the obsolete public media identity index. Writers must be stopped.
"""

import sqlalchemy as sa
from alembic import op

revision = "0343"
down_revision = "0342"
branch_labels = None
depends_on = None


def upgrade() -> None:
    db = op.get_bind()
    if db.scalar(
        sa.text("""SELECT EXISTS (SELECT 1 FROM media WHERE provider='email')
        OR EXISTS (SELECT 1 FROM media_source_attempts WHERE source_type='email_message')""")
    ):
        raise RuntimeError(
            "0343 requires zero legacy email media and source attempts; "
            "explicit conversion is required before email receipt cutover"
        )
    op.create_table(
        "email_ingest_receipts",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "owner_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("message_key", sa.Text(), nullable=False),
        sa.Column("media_id", sa.UUID(), sa.ForeignKey("media.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "owner_user_id",
            "message_key",
            name="uq_email_ingest_receipts_owner_message",
        ),
        sa.UniqueConstraint("media_id", name="uq_email_ingest_receipts_media"),
    )
    op.drop_index("uix_media_email_provider_id", table_name="media")


def downgrade() -> None:
    raise RuntimeError(
        "0343 is a hard cut; restore the verified backup and paired release"
    )
