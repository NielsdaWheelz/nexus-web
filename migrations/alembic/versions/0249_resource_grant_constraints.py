"""Enforce the resource_grants row shape and one grant per creator, subject and audience.

Revision ID: 0249
Revises: 0248
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0249"
down_revision: str | Sequence[str] | None = "0248"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A link row is a bearer link someone may hold: never rewrite or delete one here.
    blocked, sample_ids = (
        op.get_bind()
        .execute(
            sa.text("""
        WITH bad AS (
            SELECT id FROM resource_grants
            WHERE subject_scheme NOT IN ('media', 'highlight')
               OR num_nonnulls(grantee_user_id, share_token) <> 1
            UNION
            SELECT unnest((array_agg(id ORDER BY created_at, id))[2:]) FROM resource_grants
            WHERE grantee_user_id IS NOT NULL
            GROUP BY created_by_user_id, subject_scheme, subject_id, grantee_user_id
            HAVING count(*) > 1
            UNION
            SELECT unnest((array_agg(id ORDER BY created_at, id))[2:]) FROM resource_grants
            WHERE share_token IS NOT NULL
            GROUP BY created_by_user_id, subject_scheme, subject_id
            HAVING count(*) > 1
        )
        SELECT (SELECT count(*) FROM bad), ARRAY(SELECT id FROM bad ORDER BY id LIMIT 10)
        """)
        )
        .one()
    )
    if blocked:
        raise RuntimeError(
            f"0249 blocked: {blocked} resource_grants rows are malformed or duplicate; "
            f"sample ids: {', '.join(str(grant_id) for grant_id in sample_ids)}. "
            "resolve them by hand and retry"
        )
    op.create_check_constraint(
        "ck_resource_grants_subject_scheme",
        "resource_grants",
        "subject_scheme IN ('media', 'highlight')",
    )
    op.create_check_constraint(
        "ck_resource_grants_one_audience",
        "resource_grants",
        "num_nonnulls(grantee_user_id, share_token) = 1",
    )
    op.create_index(
        "uq_resource_grants_person",
        "resource_grants",
        ["created_by_user_id", "subject_scheme", "subject_id", "grantee_user_id"],
        unique=True,
        postgresql_where=sa.text("grantee_user_id IS NOT NULL"),
    )
    op.create_index(
        "uq_resource_grants_link",
        "resource_grants",
        ["created_by_user_id", "subject_scheme", "subject_id"],
        unique=True,
        postgresql_where=sa.text("share_token IS NOT NULL"),
    )
    op.drop_index("ix_resource_grants_creator_subject", table_name="resource_grants")


def downgrade() -> None:
    raise NotImplementedError(
        "0249 requires restoring the previous application and database together"
    )
