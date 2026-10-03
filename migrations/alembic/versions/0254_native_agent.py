"""Native callback evidence and transport-neutral effect ownership.

Admissions must be stopped. Unresolved shell work requires reconciliation before
this hard cut; no old row is upgraded to invented native evidence.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0254"
down_revision: str | Sequence[str] | None = "0252"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM llm_calls
                WHERE generation_spec #>> '{authority,kind}' = 'CodexShell'
                    AND outcome IS NULL
            ) OR EXISTS (
                SELECT 1 FROM llm_tool_positions
                WHERE transport_kind = 'GenerationApi'
                    AND replay_status <> 'Completed'
            ) THEN
                RAISE EXCEPTION 'unresolved shell generation or effect blocks native cutover';
            END IF;
            IF EXISTS (
                SELECT 1 FROM llm_tool_positions p
                LEFT JOIN generation_api_credentials a ON a.generation_id = p.generation_id
                WHERE p.transport_kind = 'GenerationApi' AND a.generation_id IS NULL
            ) THEN
                RAISE EXCEPTION 'historical shell position lacks persisted account ownership';
            END IF;
        END $$;
    """)
    op.add_column(
        "llm_calls",
        sa.Column(
            "tool_principal_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )
    op.execute("""
        UPDATE llm_calls c SET tool_principal_user_id = a.user_id
        FROM generation_api_credentials a WHERE a.generation_id = c.id
    """)
    for name, type_ in (
        ("fenced_at", sa.TIMESTAMP(timezone=True)),
        ("native_binding", JSONB(none_as_null=True)),
        ("submission_evidence", JSONB(none_as_null=True)),
        ("local_outcome", JSONB(none_as_null=True)),
    ):
        op.add_column("llm_model_turns", sa.Column(name, type_, nullable=True))
    op.add_column(
        "llm_tool_positions",
        sa.Column(
            "arguments",
            JSONB(none_as_null=True),
            nullable=True,
        ),
    )
    op.add_column(
        "llm_tool_positions",
        sa.Column(
            "callback_reply",
            JSONB(none_as_null=True),
            nullable=True,
        ),
    )
    op.add_column(
        "llm_tool_positions",
        sa.Column(
            "replay_of_position_id",
            UUID(as_uuid=True),
            sa.ForeignKey("llm_tool_positions.id"),
            nullable=True,
        ),
    )
    op.drop_table("generation_api_credentials")


def downgrade() -> None:
    raise NotImplementedError(
        "native evidence cutover uses forward repair, not database rollback"
    )
