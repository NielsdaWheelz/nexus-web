"""Separate chat citation candidates from final publication.

Revision ID: 0196
Revises: 0195
Create Date: 2026-07-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0196"
down_revision: str | Sequence[str] | None = "0195"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE message_retrievals ADD COLUMN citation_candidate_ordinal integer NULL")
    op.execute("ALTER TABLE chat_runs ADD COLUMN publication_warning_code text NULL")
    op.execute(
        """
        UPDATE message_retrievals AS retrieval
        SET citation_candidate_ordinal = edge.ordinal
        FROM resource_edges AS edge
        WHERE edge.id = retrieval.cited_edge_id
          AND edge.origin = 'citation'
          AND edge.ordinal IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE chat_run_events AS event
        SET payload = jsonb_build_object(
            'status', to_jsonb(run.status),
            'error_code',
                CASE
                    WHEN run.error_code IS NULL
                    THEN '{"kind":"Absent"}'::jsonb
                    ELSE jsonb_build_object(
                        'kind', 'Present',
                        'value', run.error_code
                    )
                END,
            'support_id',
                CASE
                    WHEN run.support_id IS NULL
                    THEN '{"kind":"Absent"}'::jsonb
                    ELSE jsonb_build_object(
                        'kind', 'Present',
                        'value', run.support_id
                    )
                END,
            'publication_warning', '{"kind":"Absent"}'::jsonb,
            'usage', COALESCE(event.payload -> 'usage', 'null'::jsonb),
            'final_chars', COALESCE(event.payload -> 'final_chars', 'null'::jsonb),
            'last_provider_event_seq',
                COALESCE(event.payload -> 'last_provider_event_seq', 'null'::jsonb),
            'cancelled', to_jsonb(run.status = 'cancelled')
        )
        FROM chat_runs AS run
        WHERE event.run_id = run.id
          AND event.event_type = 'done'
        """
    )


def downgrade() -> None:
    raise RuntimeError("0196 is a hard cutover migration and has no downgrade path")
