"""Remove generated chat artifacts.

Revision ID: 0112
Revises: 0110
Create Date: 2026-05-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0112"
down_revision: str | None = "0110"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


OBJECT_TYPES = (
    "'page', 'note_block', 'media', 'highlight', 'conversation', 'message', "
    "'podcast', 'content_chunk', 'fragment', 'contributor', 'evidence_span'"
)

RETRIEVAL_TYPES = (
    "'page', 'note_block', 'highlight', 'media', 'podcast', 'episode', 'video', "
    "'content_chunk', 'fragment', 'message', 'contributor', 'evidence_span', "
    "'conversation', 'web_result'"
)

CHAT_RUN_EVENT_TYPES = (
    "'meta', 'tool_call', 'retrieval_result', 'source_manifest_delta', 'claim', "
    "'claim_evidence', 'delta', 'done'"
)

GENERATED_ARTIFACT_TYPES = "'artifact', 'artifact_part'"


def upgrade() -> None:
    op.execute("DELETE FROM chat_run_events WHERE event_type = 'artifact_delta'")

    op.execute(
        f"""
        UPDATE chat_run_events
        SET payload = jsonb_set(
            payload,
            '{{results}}',
            COALESCE(
                (
                    SELECT jsonb_agg(result ORDER BY ordinal)
                    FROM jsonb_array_elements(payload->'results') WITH ORDINALITY AS item(result, ordinal)
                    WHERE COALESCE(result->>'type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result->>'result_type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result #>> '{{context_ref,type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result #>> '{{result_ref,type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result #>> '{{result_ref,result_type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                ),
                '[]'::jsonb
            ),
            false
        )
        WHERE event_type = 'retrieval_result'
          AND jsonb_typeof(payload->'results') = 'array'
        """
    )

    op.execute(
        f"""
        UPDATE messages
        SET message_document = jsonb_set(
            message_document,
            '{{blocks}}',
            COALESCE(
                (
                    SELECT jsonb_agg(block ORDER BY ordinal)
                    FROM jsonb_array_elements(message_document->'blocks') WITH ORDINALITY AS item(block, ordinal)
                    WHERE COALESCE(block->>'type', '') != 'artifact_preview'
                      AND NOT (
                        block->>'type' = 'retrieval_result'
                        AND (
                            COALESCE(block->>'result_type', '') IN ({GENERATED_ARTIFACT_TYPES})
                            OR COALESCE(block #>> '{{context_ref,type}}', '') IN ({GENERATED_ARTIFACT_TYPES})
                            OR COALESCE(block #>> '{{result_ref,type}}', '') IN ({GENERATED_ARTIFACT_TYPES})
                            OR COALESCE(block #>> '{{result_ref,result_type}}', '') IN ({GENERATED_ARTIFACT_TYPES})
                        )
                      )
                ),
                '[]'::jsonb
            ),
            false
        )
        WHERE jsonb_typeof(message_document->'blocks') = 'array'
        """
    )

    op.execute(
        f"""
        UPDATE message_tool_calls
        SET result_refs = COALESCE(
                (
                    SELECT jsonb_agg(result_ref ORDER BY ordinal)
                    FROM jsonb_array_elements(result_refs) WITH ORDINALITY AS item(result_ref, ordinal)
                    WHERE COALESCE(result_ref->>'type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result_ref->>'result_type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result_ref #>> '{{context_ref,type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result_ref #>> '{{result_ref,type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                      AND COALESCE(result_ref #>> '{{result_ref,result_type}}', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                ),
                '[]'::jsonb
            ),
            selected_context_refs = COALESCE(
                (
                    SELECT jsonb_agg(context_ref ORDER BY ordinal)
                    FROM jsonb_array_elements(selected_context_refs) WITH ORDINALITY AS item(context_ref, ordinal)
                    WHERE COALESCE(context_ref->>'type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                ),
                '[]'::jsonb
            )
        """
    )

    op.execute(
        f"""
        UPDATE assistant_message_claim_evidence
        SET retrieval_id = NULL
        WHERE retrieval_id IN (
            SELECT id
            FROM message_retrievals
            WHERE result_type IN ({GENERATED_ARTIFACT_TYPES})
               OR context_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
               OR result_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
               OR result_ref->>'result_type' IN ({GENERATED_ARTIFACT_TYPES})
        )
        """
    )
    op.execute(
        f"""
        UPDATE assistant_message_claim_evidence
        SET context_ref = NULL
        WHERE context_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
        """
    )
    op.execute(
        f"""
        UPDATE assistant_message_claim_evidence
        SET result_ref = NULL
        WHERE result_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
           OR result_ref->>'result_type' IN ({GENERATED_ARTIFACT_TYPES})
        """
    )

    op.execute(
        f"""
        DELETE FROM message_retrieval_candidate_ledgers
        WHERE result_type IN ({GENERATED_ARTIFACT_TYPES})
           OR result_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
           OR result_ref->>'result_type' IN ({GENERATED_ARTIFACT_TYPES})
           OR retrieval_id IN (
                SELECT id
                FROM message_retrievals
                WHERE result_type IN ({GENERATED_ARTIFACT_TYPES})
                   OR context_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
                   OR result_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
                   OR result_ref->>'result_type' IN ({GENERATED_ARTIFACT_TYPES})
           )
        """
    )

    op.execute(
        f"""
        DELETE FROM message_context_items
        WHERE object_type IN ({GENERATED_ARTIFACT_TYPES})
        """
    )
    op.execute(
        f"""
        DELETE FROM object_links
        WHERE a_type IN ({GENERATED_ARTIFACT_TYPES})
           OR b_type IN ({GENERATED_ARTIFACT_TYPES})
        """
    )
    op.execute(
        f"""
        DELETE FROM user_pinned_objects
        WHERE object_type IN ({GENERATED_ARTIFACT_TYPES})
        """
    )
    op.execute(
        f"""
        DELETE FROM message_retrievals
        WHERE result_type IN ({GENERATED_ARTIFACT_TYPES})
           OR context_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
           OR result_ref->>'type' IN ({GENERATED_ARTIFACT_TYPES})
           OR result_ref->>'result_type' IN ({GENERATED_ARTIFACT_TYPES})
        """
    )

    op.execute(
        """
        UPDATE chat_prompt_assemblies
        SET included_retrieval_ids = COALESCE(
            (
                SELECT jsonb_agg(retrieval_id ORDER BY ordinal)
                FROM jsonb_array_elements_text(included_retrieval_ids) WITH ORDINALITY AS item(retrieval_id, ordinal)
                WHERE EXISTS (
                    SELECT 1
                    FROM message_retrievals mr
                    WHERE mr.id::text = item.retrieval_id
                )
            ),
            '[]'::jsonb
        )
        """
    )
    op.execute(
        f"""
        UPDATE chat_prompt_assemblies
        SET included_context_refs = COALESCE(
                (
                    SELECT jsonb_agg(context_ref ORDER BY ordinal)
                    FROM jsonb_array_elements(included_context_refs) WITH ORDINALITY AS item(context_ref, ordinal)
                    WHERE COALESCE(context_ref->>'type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                ),
                '[]'::jsonb
            ),
            dropped_items = COALESCE(
                (
                    SELECT jsonb_agg(dropped_item ORDER BY ordinal)
                    FROM jsonb_array_elements(dropped_items) WITH ORDINALITY AS item(dropped_item, ordinal)
                    WHERE COALESCE(dropped_item->>'type', '') NOT IN ({GENERATED_ARTIFACT_TYPES})
                ),
                '[]'::jsonb
            )
        """
    )

    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        f"a_type IN ({OBJECT_TYPES})",
    )
    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        f"b_type IN ({OBJECT_TYPES})",
    )
    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        f"object_type IN ({OBJECT_TYPES})",
    )
    op.drop_constraint("ck_message_context_items_object_type", "message_context_items", type_="check")
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        f"object_type IS NULL OR object_type IN ({OBJECT_TYPES})",
    )
    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({RETRIEVAL_TYPES})",
    )
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        f"event_type IN ({CHAT_RUN_EVENT_TYPES})",
    )

    op.drop_constraint("ck_chat_runs_artifact_intent_kind", "chat_runs", type_="check")
    op.drop_column("chat_runs", "artifact_intent")

    op.drop_table("message_artifact_exports")
    op.drop_table("message_artifact_parts")
    op.drop_table("message_artifacts")


def downgrade() -> None:
    raise RuntimeError("0112 is a hard cutover; generated chat artifacts are not restored")
