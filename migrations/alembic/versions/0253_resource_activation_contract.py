"""One snake-case activation contract, including durable mutation replay.

Only known receipt paths change; opaque JSON remains native jsonb throughout.
Writers must be stopped under the existing release/backup contract. Downgrade
reverses receipt keys, retaining explicit Oracle nulls admitted by the old app.
Old writers can reintroduce camel keys, so restarting forward requires this
migration again. No historical absence reconstruction or provider rollback.

Revision ID: 0253
Revises: 0252
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0253"
down_revision: str | Sequence[str] | None = "0252"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rename_receipt_keys(
    source_ref: str, source_reason: str, target_ref: str, target_reason: str
) -> None:
    # This transaction-local helper handles one exact path, never a JSON walk.
    # It is explicitly dropped after the bounded rewrite; failure rolls back
    # its creation and every preceding update with the migration transaction.
    op.get_bind().exec_driver_sql(
        f"""
        CREATE FUNCTION pg_temp.rename_activation(
            document jsonb, path text[], scope text, receipt uuid, location text
        ) RETURNS jsonb LANGUAGE plpgsql AS $function$
        DECLARE activation jsonb := document #> path;
        BEGIN
            IF jsonb_typeof(activation) IS DISTINCT FROM 'object'
                OR NOT activation ?& ARRAY['{source_ref}', 'kind', 'href', '{source_reason}']
                OR activation - ARRAY['{source_ref}', 'kind', 'href', '{source_reason}']
                    <> '{{}}'::jsonb
                OR jsonb_typeof(activation->'{source_ref}') IS DISTINCT FROM 'string'
                OR jsonb_typeof(activation->'kind') IS DISTINCT FROM 'string'
                OR NOT COALESCE(activation->>'kind' IN ('route', 'external', 'none'), false)
                OR NOT COALESCE(jsonb_typeof(activation->'href') IN ('string', 'null'), false)
                OR NOT COALESCE(
                    jsonb_typeof(activation->'{source_reason}') IN ('string', 'null'), false)
                OR NOT COALESCE(
                    (activation->>'kind' = 'none') = (activation->'href' = 'null'::jsonb),
                    false)
            THEN
                RAISE EXCEPTION '0253 blocked: scope %, receipt %, path %',
                    scope, receipt, location;
            END IF;
            RETURN jsonb_set(document, path,
                (activation - ARRAY['{source_ref}', '{source_reason}'])
                || jsonb_build_object(
                    '{target_ref}', activation->'{source_ref}',
                    '{target_reason}', activation->'{source_reason}'), false);
        END
        $function$;

        DO $rewrite$
        DECLARE row record; document jsonb; entries jsonb; endpoint text;
        BEGIN
            FOR row IN SELECT id, mutation_scope, response_json FROM resource_mutations
                WHERE mutation_scope LIKE 'resource:%:title'
                    OR mutation_scope LIKE 'resource:%:body'
                    OR mutation_scope = 'resource_graph:link'
                    OR mutation_scope LIKE 'link_note:%'
                    OR mutation_scope = 'daily:capture'
                ORDER BY id
            LOOP
                document := row.response_json;
                IF row.mutation_scope LIKE 'resource:page:%:title'
                    OR row.mutation_scope LIKE 'resource:note_block:%:body'
                THEN
                    document := pg_temp.rename_activation(document,
                        ARRAY['item', 'activation'], row.mutation_scope, row.id, 'item.activation');
                ELSIF row.mutation_scope = 'resource_graph:link'
                    OR row.mutation_scope LIKE 'link_note:%'
                THEN
                    IF row.mutation_scope LIKE 'link_note:%' AND document = '{{}}'::jsonb
                    THEN CONTINUE;
                    END IF;
                    IF document #> ARRAY['connection', 'citation'] IS DISTINCT FROM 'null'::jsonb
                    THEN
                        RAISE EXCEPTION '0253 blocked: scope %, receipt %, path connection.citation',
                            row.mutation_scope, row.id;
                    END IF;
                    FOREACH endpoint IN ARRAY ARRAY['source', 'target', 'other'] LOOP
                        document := pg_temp.rename_activation(document,
                            ARRAY['connection', endpoint, 'activation'], row.mutation_scope, row.id,
                            format('connection.%s.activation', endpoint));
                    END LOOP;
                ELSIF row.mutation_scope = 'daily:capture' THEN
                    document := pg_temp.rename_activation(document,
                        ARRAY['surface', 'source', 'item', 'activation'], row.mutation_scope, row.id,
                        'surface.source.item.activation');
                    IF jsonb_typeof(document #> ARRAY['surface', 'ordered_items'])
                        IS DISTINCT FROM 'array'
                    THEN
                        RAISE EXCEPTION '0253 blocked: scope %, receipt %, path surface.ordered_items',
                            row.mutation_scope, row.id;
                    END IF;
                    SELECT COALESCE(jsonb_agg(pg_temp.rename_activation(entry,
                        ARRAY['target', 'item', 'activation'], row.mutation_scope, row.id,
                        format('surface.ordered_items[%s].target.item.activation', ordinal - 1))
                        ORDER BY ordinal), '[]'::jsonb)
                    INTO entries FROM jsonb_array_elements(
                        document #> ARRAY['surface', 'ordered_items'])
                        WITH ORDINALITY AS items(entry, ordinal);
                    document := jsonb_set(document, ARRAY['surface', 'ordered_items'], entries, false);
                ELSE
                    RAISE EXCEPTION '0253 blocked: unadmitted scope %, receipt %',
                        row.mutation_scope, row.id;
                END IF;
                UPDATE resource_mutations SET response_json = document WHERE id = row.id;
            END LOOP;
        END
        $rewrite$;
        DROP FUNCTION pg_temp.rename_activation(jsonb, text[], text, uuid, text);
    """,
        execution_options={"no_parameters": True},
    )


def upgrade() -> None:
    _rename_receipt_keys(
        "resourceRef", "unresolvedReason", "resource_ref", "unresolved_reason"
    )
    op.get_bind().exec_driver_sql(
        """
        DO $guard$
        DECLARE row record;
        BEGIN
            FOR row IN SELECT id, payload FROM oracle_reading_events WHERE event_type = 'passage'
            LOOP
                IF jsonb_typeof(row.payload) IS DISTINCT FROM 'object'
                THEN
                    RAISE EXCEPTION '0253 blocked: oracle passage %, path payload', row.id;
                END IF;
            END LOOP;
        END
        $guard$;
        UPDATE oracle_reading_events SET payload = payload
            || CASE WHEN NOT payload ? 'deep_link'
                THEN '{"deep_link":null}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN NOT payload ? 'citation'
                THEN '{"citation":null}'::jsonb ELSE '{}'::jsonb END
        WHERE event_type = 'passage' AND (NOT payload ? 'deep_link' OR NOT payload ? 'citation');
    """,
        execution_options={"no_parameters": True},
    )


def downgrade() -> None:
    _rename_receipt_keys(
        "resource_ref", "unresolved_reason", "resourceRef", "unresolvedReason"
    )
