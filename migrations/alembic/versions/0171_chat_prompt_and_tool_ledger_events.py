"""Add prompt and tool-ledger chat stream events.

Revision ID: 0171
Revises: 0169
Create Date: 2026-06-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0171"
down_revision: str | Sequence[str] | None = "0169"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute("""
        UPDATE chat_run_events AS e
        SET payload = e.payload || jsonb_build_object(
            'source_domain', mtc.source_domain,
            'source_policy', mtc.source_policy
        )
        FROM message_tool_calls AS mtc
        WHERE e.event_type = 'tool_result'
          AND (
            NOT e.payload ? 'source_domain'
            OR e.payload->'source_domain' = 'null'::jsonb
            OR NOT e.payload ? 'source_policy'
            OR e.payload->'source_policy' = 'null'::jsonb
          )
          AND (
            e.payload->>'tool_call_id' = mtc.id::text
            OR (
              e.payload->>'assistant_message_id' = mtc.assistant_message_id::text
              AND e.payload->>'tool_call_index' ~ '^[0-9]+$'
              AND (e.payload->>'tool_call_index')::integer = mtc.tool_call_index
            )
          )
    """)
    op.execute("""
        WITH unresolved AS (
            SELECT id,
                   CASE
                       WHEN payload->>'tool_name' IN (
                           'app_search',
                           'read_resource',
                           'inspect_resource',
                           'attached_resources'
                       ) THEN 'private_app'
                       WHEN payload->>'tool_name' = 'web_search' THEN 'public_web'
                       ELSE 'provider_control'
                   END AS source_domain
            FROM chat_run_events
            WHERE event_type = 'tool_result'
              AND (
                NOT payload ? 'source_domain'
                OR payload->'source_domain' = 'null'::jsonb
                OR NOT payload ? 'source_policy'
                OR payload->'source_policy' = 'null'::jsonb
              )
        )
        UPDATE chat_run_events AS e
        SET payload = e.payload || jsonb_build_object(
            'source_domain', unresolved.source_domain,
            'source_policy', jsonb_build_object(
                'version', 'source_boundary_policy.v1',
                'decision', 'allowed',
                'source_domain', unresolved.source_domain,
                'mixing_allowed', false,
                'reason',
                    CASE
                        WHEN unresolved.source_domain = 'provider_control'
                        THEN 'provider_control_only'
                        ELSE 'single_domain_' || unresolved.source_domain
                    END,
                'domains_seen', '[]'::jsonb,
                'requested_domains',
                    CASE
                        WHEN unresolved.source_domain = 'provider_control'
                        THEN '[]'::jsonb
                        ELSE jsonb_build_array(unresolved.source_domain)
                    END
            )
        )
        FROM unresolved
        WHERE e.id = unresolved.id
    """)
    op.execute("""
        UPDATE chat_run_events
        SET payload = jsonb_set(
            payload,
            '{filters}',
            (
                (payload->'filters')
                - 'semantic'
                - 'content_kinds'
                - 'contributor_handles'
            )
            || CASE
                WHEN (payload->'filters') ? 'content_kinds'
                  AND NOT ((payload->'filters') ? 'formats')
                THEN jsonb_build_object('formats', (payload->'filters')->'content_kinds')
                ELSE '{}'::jsonb
            END
            || CASE
                WHEN (payload->'filters') ? 'contributor_handles'
                  AND NOT ((payload->'filters') ? 'authors')
                THEN jsonb_build_object(
                    'authors',
                    (payload->'filters')->'contributor_handles'
                )
                ELSE '{}'::jsonb
            END,
            false
        )
        WHERE event_type = 'tool_result'
          AND jsonb_typeof(payload->'filters') = 'object'
          AND (
            (payload->'filters') ? 'semantic'
            OR (payload->'filters') ? 'content_kinds'
            OR (payload->'filters') ? 'contributor_handles'
          )
    """)
    op.execute("""
        ALTER TABLE chat_run_events ADD CONSTRAINT ck_chat_run_events_event_type CHECK (
            event_type IN (
                'meta', 'assistant_activity', 'assistant_text_delta',
                'tool_call_start', 'tool_call_delta', 'tool_call_done', 'tool_result',
                'prompt_assembly', 'tool_ledger_snapshot',
                'citation_index', 'context_ref_added', 'done'
            )
        )
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0171 is not reversible")
