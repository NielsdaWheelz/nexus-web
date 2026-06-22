"""Chat run retrieval plan cutover.

Revision ID: 0168
Revises: 0167
Create Date: 2026-06-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0168"
down_revision: str | Sequence[str] | None = "0167"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HISTORICAL_PLAN: dict[str, object] = {
    "version": "chat_retrieval_plan.v1",
    "route_intent": "no_retrieval",
    "source_domain": "none",
    "mixing_policy": "no_retrieval",
    "query_class": "no_retrieval",
    "allowed_tools": [],
    "blocked_tools": ["app_search", "web_search", "read_resource", "inspect_resource"],
    "candidate_tool_sequence": [],
    "internal_tool_sequence": [],
    "reason": "pre_cutover",
    "context_ref_count": 0,
    "search_scope_count": 0,
    "search_scope_uris": [],
    "budget_policy": "tool_output_budget_from_prompt_assembly",
}


def upgrade() -> None:
    op.add_column(
        "chat_runs",
        sa.Column("retrieval_plan", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.get_bind().execute(
        sa.text(
            """
            UPDATE chat_runs
            SET retrieval_plan = :retrieval_plan
            WHERE retrieval_plan IS NULL
            """
        ).bindparams(sa.bindparam("retrieval_plan", type_=postgresql.JSONB)),
        {"retrieval_plan": HISTORICAL_PLAN},
    )
    op.create_check_constraint(
        "ck_chat_runs_retrieval_plan_object",
        "chat_runs",
        "retrieval_plan IS NULL OR jsonb_typeof(retrieval_plan) = 'object'",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0168 is not reversible")
