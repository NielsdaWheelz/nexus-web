"""Canonicalize object-ref message context snapshots.

Revision ID: 0108
Revises: 0107
Create Date: 2026-05-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0108"
down_revision: str | None = "0107"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_OBJECT_REF_SNAPSHOT_CHECK = (
    "context_kind != 'object_ref' OR ("
    "COALESCE(context_snapshot->>'kind', '') = 'object_ref' "
    "AND context_snapshot->>'type' = object_type "
    "AND context_snapshot->>'id' = object_id::text "
    "AND char_length(btrim(COALESCE(context_snapshot->>'title', ''))) > 0)"
)


def upgrade() -> None:
    op.execute(
        """
        UPDATE message_context_items
        SET context_snapshot = jsonb_strip_nulls(
            (
                context_snapshot
                || jsonb_build_object(
                    'kind', 'object_ref',
                    'type', object_type,
                    'id', object_id::text,
                    'title',
                        COALESCE(
                            context_snapshot->>'title',
                            context_snapshot->>'label'
                        ),
                    'preview',
                        COALESCE(
                            context_snapshot->>'preview',
                            context_snapshot->>'snippet'
                        ),
                    'media_id',
                        COALESCE(
                            context_snapshot->>'media_id',
                            context_snapshot->>'mediaId'
                        ),
                    'media_title',
                        COALESCE(
                            context_snapshot->>'media_title',
                            context_snapshot->>'mediaTitle'
                        ),
                    'media_kind',
                        COALESCE(
                            context_snapshot->>'media_kind',
                            context_snapshot->>'mediaKind'
                        ),
                    'evidence_span_ids',
                        (
                            SELECT jsonb_agg(span_id ORDER BY first_ordinal)
                            FROM (
                                SELECT DISTINCT ON (span_uuid)
                                    span_uuid::text AS span_id,
                                    ordinal AS first_ordinal
                                FROM (
                                    SELECT
                                        raw_span_id::uuid AS span_uuid,
                                        ordinal
                                    FROM jsonb_array_elements_text(
                                        CASE
                                            WHEN jsonb_typeof(
                                                context_snapshot->'evidence_span_ids'
                                            ) = 'array'
                                                THEN context_snapshot->'evidence_span_ids'
                                            WHEN context_snapshot->>'evidence_span_ids' IS NOT NULL
                                                THEN jsonb_build_array(
                                                    context_snapshot->>'evidence_span_ids'
                                                )
                                            WHEN jsonb_typeof(
                                                context_snapshot->'evidenceSpanIds'
                                            ) = 'array'
                                                THEN context_snapshot->'evidenceSpanIds'
                                            WHEN context_snapshot->>'evidenceSpanIds' IS NOT NULL
                                                THEN jsonb_build_array(
                                                    context_snapshot->>'evidenceSpanIds'
                                                )
                                            WHEN context_snapshot->>'evidence_span_id' IS NOT NULL
                                                THEN jsonb_build_array(
                                                    context_snapshot->>'evidence_span_id'
                                                )
                                            WHEN context_snapshot->>'evidenceSpanId' IS NOT NULL
                                                THEN jsonb_build_array(
                                                    context_snapshot->>'evidenceSpanId'
                                                )
                                            ELSE '[]'::jsonb
                                        END
                                    ) WITH ORDINALITY AS raw(raw_span_id, ordinal)
                                ) parsed_span_ids
                                ORDER BY span_uuid, ordinal
                            ) canonical_span_ids
                        )
                )
            )
            - 'objectType'
            - 'objectId'
            - 'label'
            - 'snippet'
            - 'mediaId'
            - 'mediaTitle'
            - 'mediaKind'
            - 'evidenceSpanIds'
            - 'evidence_span_id'
            - 'evidenceSpanId'
        )
        WHERE context_kind = 'object_ref'
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM message_context_items
                WHERE context_kind = 'object_ref'
                  AND NOT (
                    COALESCE(context_snapshot->>'kind', '') = 'object_ref'
                    AND context_snapshot->>'type' = object_type
                    AND context_snapshot->>'id' = object_id::text
                    AND char_length(btrim(COALESCE(context_snapshot->>'title', ''))) > 0
                  )
                LIMIT 1
            ) THEN
                RAISE EXCEPTION
                    'object_ref message contexts require canonical identity snapshots';
            END IF;
        END $$;
        """
    )
    op.create_check_constraint(
        "ck_message_context_items_object_ref_snapshot",
        "message_context_items",
        _OBJECT_REF_SNAPSHOT_CHECK,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_message_context_items_object_ref_snapshot",
        "message_context_items",
        type_="check",
    )
