"""Remove status pseudo retrieval results.

Revision ID: 0101
Revises: 0100
Create Date: 2026-05-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0101"
down_revision: str | None = "0100"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MESSAGE_RETRIEVAL_TYPES = (
    "'page', 'note_block', 'highlight', 'media', 'podcast', 'episode', 'video', "
    "'content_chunk', 'fragment', 'message', 'contributor', 'evidence_span', "
    "'conversation', 'artifact', 'artifact_part', 'web_result'"
)
LEGACY_MESSAGE_RETRIEVAL_TYPES = f"{MESSAGE_RETRIEVAL_TYPES}, 'status'"

RETRIEVAL_SELECTION_STATUSES = (
    "'retrieved', 'selected', 'included_in_prompt', 'excluded_by_budget', "
    "'excluded_by_scope', 'web_result'"
)
LEGACY_RETRIEVAL_SELECTION_STATUSES = f"{RETRIEVAL_SELECTION_STATUSES}, 'status'"


def upgrade() -> None:
    op.execute(
        """
        UPDATE message_tool_calls mtc
        SET result_refs = COALESCE(
                (
                    SELECT jsonb_agg(ref)
                    FROM jsonb_array_elements(mtc.result_refs) AS refs(ref)
                    WHERE ref->>'type' <> 'status'
                ),
                '[]'::jsonb
            ),
            selected_context_refs = COALESCE(
                (
                    SELECT jsonb_agg(ref)
                    FROM jsonb_array_elements(mtc.selected_context_refs) AS refs(ref)
                    WHERE ref->>'type' <> 'status'
                ),
                '[]'::jsonb
            )
        WHERE jsonb_typeof(mtc.result_refs) = 'array'
          AND jsonb_typeof(mtc.selected_context_refs) = 'array'
        """
    )
    op.execute(
        """
        UPDATE chat_run_events cre
        SET payload = jsonb_set(
            cre.payload,
            '{results}',
            COALESCE(
                (
                    SELECT jsonb_agg(result)
                    FROM jsonb_array_elements(cre.payload->'results') AS results(result)
                    WHERE result->>'type' <> 'status'
                ),
                '[]'::jsonb
            ),
            true
        )
        WHERE cre.event_type = 'retrieval_result'
          AND jsonb_typeof(cre.payload->'results') = 'array'
        """
    )
    op.execute(
        """
        UPDATE messages m
        SET message_document = jsonb_set(
            m.message_document,
            '{blocks}',
            COALESCE(
                (
                    SELECT jsonb_agg(block)
                    FROM jsonb_array_elements(m.message_document->'blocks') AS blocks(block)
                    WHERE NOT (
                        block->>'type' = 'retrieval_result'
                        AND (
                            block->>'result_type' = 'status'
                            OR block->'context_ref'->>'type' = 'status'
                            OR block->'result_ref'->>'type' = 'status'
                        )
                    )
                ),
                '[]'::jsonb
            ),
            true
        )
        WHERE jsonb_typeof(m.message_document->'blocks') = 'array'
        """
    )
    op.execute(
        """
        UPDATE chat_prompt_assemblies cpa
        SET included_retrieval_ids = COALESCE(
            (
                SELECT jsonb_agg(retrieval_id)
                FROM jsonb_array_elements_text(cpa.included_retrieval_ids) AS ids(retrieval_id)
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM message_retrievals mr
                    WHERE mr.id::text = retrieval_id
                      AND (
                        mr.result_type = 'status'
                        OR mr.context_ref->>'type' = 'status'
                        OR mr.result_ref->>'type' = 'status'
                      )
                )
            ),
            '[]'::jsonb
        )
        WHERE jsonb_typeof(cpa.included_retrieval_ids) = 'array'
        """
    )
    op.execute(
        """
        UPDATE assistant_message_claim_evidence ace
        SET retrieval_id = NULL,
            context_ref = CASE
                WHEN context_ref->>'type' = 'status' THEN NULL
                ELSE context_ref
            END,
            result_ref = CASE
                WHEN result_ref->>'type' = 'status' THEN NULL
                ELSE result_ref
            END
        WHERE (context_ref->>'type' = 'status')
           OR (result_ref->>'type' = 'status')
           OR EXISTS (
                SELECT 1
                FROM message_retrievals mr
                WHERE mr.id = ace.retrieval_id
                  AND (
                    mr.result_type = 'status'
                    OR mr.context_ref->>'type' = 'status'
                    OR mr.result_ref->>'type' = 'status'
                  )
           )
        """
    )
    op.execute(
        """
        DELETE FROM message_retrieval_candidate_ledgers
        WHERE result_type = 'status'
           OR selection_status = 'status'
           OR result_ref->>'type' = 'status'
        """
    )
    op.execute(
        """
        DELETE FROM message_retrievals
        WHERE result_type = 'status'
           OR context_ref->>'type' = 'status'
           OR result_ref->>'type' = 'status'
        """
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({MESSAGE_RETRIEVAL_TYPES})",
    )

    op.drop_constraint(
        "ck_retrieval_candidate_ledgers_status",
        "message_retrieval_candidate_ledgers",
        type_="check",
    )
    op.create_check_constraint(
        "ck_retrieval_candidate_ledgers_status",
        "message_retrieval_candidate_ledgers",
        f"selection_status IN ({RETRIEVAL_SELECTION_STATUSES})",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_retrieval_candidate_ledgers_status",
        "message_retrieval_candidate_ledgers",
        type_="check",
    )
    op.create_check_constraint(
        "ck_retrieval_candidate_ledgers_status",
        "message_retrieval_candidate_ledgers",
        f"selection_status IN ({LEGACY_RETRIEVAL_SELECTION_STATUSES})",
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({LEGACY_MESSAGE_RETRIEVAL_TYPES})",
    )
