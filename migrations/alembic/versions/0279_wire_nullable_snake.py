"""Stored JSON follows the wire: plain nullable values and snake_case keys.

Revision ID: 0279
Revises: 0278

The api retired ``Presence<T>`` (``{"kind": "Absent"}`` / ``{"kind": "Present", "value": v}``)
for plain nullable values and serializes every model by field name. Stored JSON written in the
old forms is read back through the same models, so:

1. Every jsonb column of the public schema has each exact Presence object replaced by its
   value: ``{"kind": "Absent"}`` becomes ``null`` and ``{"kind": "Present", "value": v}``
   becomes ``v``, at any depth. Import and processing history, chat run events, chunk
   locators, apparatus note groups, job results, 0278's x source snapshots and the rest
   carried them. Three columns are left as written: ``note_blocks.body_pm_json`` (user
   documents, never Presence-encoded), ``model_cutover_archives.reviewed_manifest`` (a frozen
   archive its reader parses as archived) and ``resource_mutations`` (the replay ledger: its
   request hashes are of the old wire, so no new request replays an old row).
2. ``workspace_sessions.state`` (the web's layout, stored as sent) has its camelCase keys
   renamed to snake_case.

Total: every value converts; nothing is refused. Irreversible: the release's pre-migration
backup holds the old forms.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0279"
down_revision: str | Sequence[str] | None = "0278"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEPT = (
    ("note_blocks", "body_pm_json"),
    ("model_cutover_archives", "reviewed_manifest"),
    ("resource_mutations", "response_json"),
    ("resource_mutations", "effects_json"),
)


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION pg_temp.unwrap_presence(value jsonb) RETURNS jsonb
        LANGUAGE plpgsql IMMUTABLE AS $$
        BEGIN
            IF jsonb_typeof(value) = 'array' THEN
                RETURN (SELECT coalesce(jsonb_agg(pg_temp.unwrap_presence(e) ORDER BY i), '[]')
                        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(e, i));
            ELSIF jsonb_typeof(value) <> 'object' THEN
                RETURN value;
            ELSIF value = '{"kind": "Absent"}' THEN
                RETURN 'null';
            ELSIF value ->> 'kind' = 'Present' AND value ? 'value'
                  AND (SELECT count(*) FROM jsonb_object_keys(value)) = 2 THEN
                RETURN pg_temp.unwrap_presence(value -> 'value');
            END IF;
            RETURN (SELECT coalesce(jsonb_object_agg(k, pg_temp.unwrap_presence(v)), '{}')
                    FROM jsonb_each(value) AS o(k, v));
        END $$
    """)
    op.execute("""
        CREATE FUNCTION pg_temp.snake_keys(value jsonb) RETURNS jsonb
        LANGUAGE plpgsql IMMUTABLE AS $$
        BEGIN
            IF jsonb_typeof(value) = 'array' THEN
                RETURN (SELECT coalesce(jsonb_agg(pg_temp.snake_keys(e) ORDER BY i), '[]')
                        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(e, i));
            ELSIF jsonb_typeof(value) <> 'object' THEN
                RETURN value;
            END IF;
            RETURN (SELECT coalesce(jsonb_object_agg(
                               lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\\1_\\2', 'g')),
                               pg_temp.snake_keys(v)), '{}')
                    FROM jsonb_each(value) AS o(k, v));
        END $$
    """)
    kept = ", ".join(f"('{table}', '{column}')" for table, column in _KEPT)
    op.execute(f"""
        DO $$
        DECLARE c record;
        BEGIN
            FOR c IN
                SELECT table_name, column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND data_type = 'jsonb'
                  AND (table_name, column_name) NOT IN ({kept})
            LOOP
                EXECUTE format(
                    'UPDATE %I SET %I = pg_temp.unwrap_presence(%I) '
                    'WHERE %I::text LIKE ''%%"kind": "Absent"%%'' '
                    'OR %I::text LIKE ''%%"kind": "Present"%%''',
                    c.table_name, c.column_name, c.column_name, c.column_name, c.column_name);
            END LOOP;
        END $$
    """)
    op.execute("UPDATE workspace_sessions SET state = pg_temp.snake_keys(state)")


def downgrade() -> None:
    raise NotImplementedError("0279 is irreversible; restore the pre-release backup")
