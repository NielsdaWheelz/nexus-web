"""Backfill web results onto external snapshot resource ids.

Revision ID: 0164
Revises: 0163
Create Date: 2026-06-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0164"
down_revision: str | Sequence[str] | None = "0163"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TEMP TABLE _web_result_snapshot_backfill ON COMMIT DROP AS
        SELECT
            mr.id AS retrieval_id,
            mr.tool_call_id,
            mr.ordinal,
            mr.source_id AS old_source_id,
            COALESCE(NULLIF(mr.result_ref->>'result_ref', ''), mr.source_id) AS old_result_ref,
            COALESCE(edge_snapshot.id, current_snapshot.id, gen_random_uuid()) AS snapshot_id,
            COALESCE(edge_snapshot.id, current_snapshot.id) IS NOT NULL AS snapshot_exists,
            c.owner_user_id AS user_id,
            COALESCE(
                NULLIF(mr.result_ref->>'provider', ''),
                edge_snapshot.provider,
                current_snapshot.provider,
                'unknown'
            ) AS provider,
            COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link, edge_snapshot.url, current_snapshot.url) AS url,
            COALESCE(
                NULLIF(mr.result_ref->>'title', ''),
                mr.source_title,
                edge_snapshot.title,
                current_snapshot.title,
                NULLIF(mr.result_ref->>'url', ''),
                mr.deep_link,
                edge_snapshot.url,
                current_snapshot.url,
                'External source'
            ) AS title,
            COALESCE(
                NULLIF(mr.exact_snippet, ''),
                NULLIF(mr.result_ref->>'snippet', ''),
                edge_snapshot.snippet,
                current_snapshot.snippet,
                ''
            ) AS snippet,
            NULLIF(mr.result_ref->>'display_url', '') AS display_url,
            CASE
                WHEN jsonb_typeof(mr.result_ref->'extra_snippets') = 'array'
                THEN mr.result_ref->'extra_snippets'
                ELSE '[]'::jsonb
            END AS extra_snippets,
            NULLIF(mr.result_ref->>'published_at', '') AS published_at,
            NULLIF(mr.result_ref->>'source_name', '') AS source_name,
            CASE
                WHEN mr.result_ref->>'rank' ~ '^[0-9]+$'
                THEN CAST(mr.result_ref->>'rank' AS integer)
                ELSE NULL
            END AS rank,
            NULLIF(mr.result_ref->>'provider_request_id', '') AS provider_request_id,
            COALESCE(
                mr.locator,
                mr.result_ref->'locator',
                edge_snapshot.source_snapshot->'locator',
                current_snapshot.source_snapshot->'locator',
                jsonb_build_object(
                    'type', 'external_url',
                    'url', COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link, edge_snapshot.url, current_snapshot.url),
                    'title', COALESCE(NULLIF(mr.result_ref->>'title', ''), mr.source_title, edge_snapshot.title, current_snapshot.title),
                    'display_url', NULLIF(mr.result_ref->>'display_url', '')
                )
            ) AS locator,
            mr.score,
            mr.selected
        FROM message_retrievals mr
        JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
        JOIN conversations c ON c.id = mtc.conversation_id
        LEFT JOIN resource_edges edge
          ON edge.id = mr.cited_edge_id
         AND edge.target_scheme = 'external_snapshot'
        LEFT JOIN resource_external_snapshots edge_snapshot ON edge_snapshot.id = edge.target_id
        LEFT JOIN resource_external_snapshots current_snapshot
          ON current_snapshot.id = CASE
              WHEN mr.source_id ~ '{UUID_RE}' THEN CAST(mr.source_id AS uuid)
              ELSE NULL
          END
        WHERE mr.result_type = 'web_result'
          AND mr.result_ref->>'type' = 'web_result'
          AND (
              current_snapshot.id IS NULL
              OR mr.result_ref->>'id' IS DISTINCT FROM mr.source_id
              OR mr.result_ref->>'source_id' IS DISTINCT FROM mr.source_id
              OR mr.context_ref->>'id' IS DISTINCT FROM mr.source_id
          )
          AND COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link, edge_snapshot.url, current_snapshot.url) IS NOT NULL
        """
    )
    op.execute("""
        ALTER TABLE _web_result_snapshot_backfill
        ADD COLUMN context_ref jsonb,
        ADD COLUMN result_ref jsonb
    """)
    op.execute("""
        UPDATE _web_result_snapshot_backfill
        SET
            context_ref = jsonb_build_object(
                'type', 'web_result',
                'id', snapshot_id::text
            ),
            result_ref = jsonb_build_object(
                'type', 'web_result',
                'id', snapshot_id::text,
                'result_type', 'web_result',
                'result_ref', old_result_ref,
                'source_id', snapshot_id::text,
                'title', title,
                'url', url,
                'display_url', display_url,
                'deep_link', url,
                'snippet', snippet,
                'extra_snippets', extra_snippets,
                'published_at', published_at,
                'source_name', source_name,
                'rank', rank,
                'provider', provider,
                'provider_request_id', provider_request_id,
                'locator', locator,
                'context_ref', jsonb_build_object('type', 'web_result', 'id', snapshot_id::text),
                'media_id', NULL,
                'media_kind', NULL,
                'score', score,
                'selected', selected
            )
    """)
    op.execute("""
        INSERT INTO resource_external_snapshots (
            id, user_id, provider, url, title, snippet, source_snapshot
        )
        SELECT snapshot_id, user_id, provider, url, title, snippet, result_ref
        FROM _web_result_snapshot_backfill
        WHERE snapshot_exists = false
    """)
    op.execute("""
        UPDATE message_retrievals mr
        SET source_id = b.snapshot_id::text,
            context_ref = b.context_ref,
            result_ref = b.result_ref,
            deep_link = b.url,
            source_title = b.title,
            exact_snippet = b.snippet,
            locator = b.locator
        FROM _web_result_snapshot_backfill b
        WHERE mr.id = b.retrieval_id
    """)
    op.execute("""
        UPDATE message_retrieval_candidate_ledgers ledger
        SET source_id = b.snapshot_id::text,
            result_ref = b.result_ref,
            locator = b.locator
        FROM _web_result_snapshot_backfill b
        WHERE ledger.result_type = 'web_result'
          AND (
              ledger.retrieval_id = b.retrieval_id
              OR (
                  ledger.retrieval_id IS NULL
                  AND ledger.tool_call_id = b.tool_call_id
                  AND ledger.ordinal = b.ordinal
              )
          )
    """)
    op.execute("""
        UPDATE message_tool_calls mtc
        SET result_refs = rebuilt.result_refs
        FROM (
            SELECT mtc.id,
                   jsonb_agg(COALESCE(b.result_ref, item.value) ORDER BY item.ordinal) AS result_refs
            FROM message_tool_calls mtc
            JOIN jsonb_array_elements(mtc.result_refs) WITH ORDINALITY AS item(value, ordinal)
              ON true
            LEFT JOIN _web_result_snapshot_backfill b
              ON b.tool_call_id = mtc.id
             AND b.ordinal = item.ordinal - 1
            WHERE EXISTS (
                SELECT 1 FROM _web_result_snapshot_backfill b2 WHERE b2.tool_call_id = mtc.id
            )
            GROUP BY mtc.id
        ) rebuilt
        WHERE mtc.id = rebuilt.id
    """)
    op.execute("""
        UPDATE message_tool_calls mtc
        SET selected_context_refs = rebuilt.selected_context_refs
        FROM (
            SELECT mtc.id,
                   jsonb_agg(COALESCE(b.context_ref, item.value) ORDER BY item.ordinal) AS selected_context_refs
            FROM message_tool_calls mtc
            JOIN jsonb_array_elements(mtc.selected_context_refs) WITH ORDINALITY AS item(value, ordinal)
              ON true
            LEFT JOIN _web_result_snapshot_backfill b
              ON b.tool_call_id = mtc.id
             AND item.value->>'type' = 'web_result'
             AND (
                 item.value->>'id' = b.old_source_id
                 OR item.value->>'id' = b.old_result_ref
                 OR item.value->>'id' = b.retrieval_id::text
             )
            WHERE EXISTS (
                SELECT 1 FROM _web_result_snapshot_backfill b2 WHERE b2.tool_call_id = mtc.id
            )
            GROUP BY mtc.id
        ) rebuilt
        WHERE mtc.id = rebuilt.id
    """)
    op.execute(
        f"""
        UPDATE message_retrieval_candidate_ledgers
        SET retrieval_id = NULL
        WHERE retrieval_id IN (
            SELECT mr.id
            FROM message_retrievals mr
            LEFT JOIN resource_external_snapshots res
              ON res.id = CASE
                  WHEN mr.source_id ~ '{UUID_RE}' THEN CAST(mr.source_id AS uuid)
                  ELSE NULL
              END
            WHERE mr.result_type = 'web_result'
              AND res.id IS NULL
        )
        """
    )
    op.execute(
        f"""
        DELETE FROM message_retrievals mr
        WHERE mr.result_type = 'web_result'
          AND NOT EXISTS (
              SELECT 1
              FROM resource_external_snapshots res
              WHERE res.id = CASE
                  WHEN mr.source_id ~ '{UUID_RE}' THEN CAST(mr.source_id AS uuid)
                  ELSE NULL
              END
          )
        """
    )
    op.create_check_constraint(
        "ck_message_retrievals_web_source_snapshot_uuid",
        "message_retrievals",
        f"result_type <> 'web_result' OR source_id ~ '{UUID_RE}'",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0164 is not reversible")
