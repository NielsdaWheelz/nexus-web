"""Message tool-call source boundary policy.

Revision ID: 0169
Revises: 0168
Create Date: 2026-06-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0169"
down_revision: str | Sequence[str] | None = "0168"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("message_tool_calls", sa.Column("source_domain", sa.Text(), nullable=True))
    op.add_column(
        "message_tool_calls",
        sa.Column("source_policy", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute(
        """
        UPDATE message_tool_calls
        SET source_domain = CASE
                WHEN tool_name IN (
                    'app_search', 'read_resource', 'inspect_resource', 'attached_resources'
                ) THEN 'private_app'
                WHEN tool_name = 'web_search' THEN 'public_web'
                ELSE 'provider_control'
            END
        """
    )
    op.execute(
        """
        UPDATE message_tool_calls
        SET source_policy = jsonb_build_object(
            'version', 'source_boundary_policy.v1',
            'decision', 'allowed',
            'source_domain', source_domain,
            'mixing_allowed', false,
            'reason', 'historical_pre_cutover',
            'domains_seen', '[]'::jsonb,
            'requested_domains',
                CASE
                    WHEN source_domain = 'provider_control' THEN '[]'::jsonb
                    ELSE jsonb_build_array(source_domain)
                END
        )
        """
    )
    op.alter_column("message_tool_calls", "source_domain", nullable=False)
    op.alter_column("message_tool_calls", "source_policy", nullable=False)
    op.create_check_constraint(
        "ck_message_tool_calls_source_policy_object",
        "message_tool_calls",
        "jsonb_typeof(source_policy) = 'object'",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0169 is not reversible")
