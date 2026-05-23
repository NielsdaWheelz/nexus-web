"""Require canonical reader selection snapshots.

Revision ID: 0107
Revises: 0106
Create Date: 2026-05-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0107"
down_revision: str | None = "0106"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_READER_SELECTION_SNAPSHOT_CHECK = (
    "context_kind != 'reader_selection' OR ("
    "COALESCE(context_snapshot->>'kind', '') = 'reader_selection' "
    "AND char_length(btrim(COALESCE(context_snapshot->>'client_context_id', ''))) > 0 "
    "AND char_length(btrim(COALESCE(context_snapshot->>'media_id', ''))) > 0 "
    "AND context_snapshot->>'media_id' = source_media_id::text "
    "AND char_length(btrim(COALESCE(context_snapshot->>'source_media_id', ''))) > 0 "
    "AND context_snapshot->>'source_media_id' = source_media_id::text "
    "AND char_length(btrim(COALESCE(context_snapshot->>'media_kind', ''))) > 0 "
    "AND char_length(btrim(COALESCE(context_snapshot->>'media_title', ''))) > 0 "
    "AND char_length(btrim(COALESCE(context_snapshot->>'exact', ''))) > 0 "
    "AND char_length(btrim(COALESCE(context_snapshot->>'source_version', ''))) > 0 "
    "AND context_snapshot ? 'locator' "
    "AND jsonb_typeof(context_snapshot->'locator') = 'object')"
)


def upgrade() -> None:
    op.execute(
        """
        UPDATE message_context_items
        SET context_snapshot = jsonb_strip_nulls(
            (
                context_snapshot
                || jsonb_build_object(
                    'kind', 'reader_selection',
                    'client_context_id',
                        COALESCE(
                            context_snapshot->>'client_context_id',
                            context_snapshot->>'clientContextId'
                        ),
                    'media_id',
                        COALESCE(
                            context_snapshot->>'media_id',
                            context_snapshot->>'mediaId',
                            source_media_id::text
                        ),
                    'source_media_id',
                        COALESCE(
                            context_snapshot->>'source_media_id',
                            context_snapshot->>'sourceMediaId',
                            source_media_id::text
                        ),
                    'media_kind',
                        COALESCE(
                            context_snapshot->>'media_kind',
                            context_snapshot->>'mediaKind'
                        ),
                    'media_title',
                        COALESCE(
                            context_snapshot->>'media_title',
                            context_snapshot->>'mediaTitle'
                        ),
                    'source_version',
                        COALESCE(
                            context_snapshot->>'source_version',
                            context_snapshot->>'sourceVersion'
                        ),
                    'locator',
                        COALESCE(context_snapshot->'locator', locator_json)
                )
            )
            - 'clientContextId'
            - 'mediaId'
            - 'sourceMediaId'
            - 'mediaKind'
            - 'mediaTitle'
            - 'sourceVersion'
        )
        WHERE context_kind = 'reader_selection'
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM message_context_items
                WHERE context_kind = 'reader_selection'
                  AND NOT (
                    COALESCE(context_snapshot->>'kind', '') = 'reader_selection'
                    AND char_length(btrim(COALESCE(context_snapshot->>'client_context_id', ''))) > 0
                    AND char_length(btrim(COALESCE(context_snapshot->>'media_id', ''))) > 0
                    AND context_snapshot->>'media_id' = source_media_id::text
                    AND char_length(btrim(COALESCE(context_snapshot->>'source_media_id', ''))) > 0
                    AND context_snapshot->>'source_media_id' = source_media_id::text
                    AND char_length(btrim(COALESCE(context_snapshot->>'media_kind', ''))) > 0
                    AND char_length(btrim(COALESCE(context_snapshot->>'media_title', ''))) > 0
                    AND char_length(btrim(COALESCE(context_snapshot->>'exact', ''))) > 0
                    AND char_length(btrim(COALESCE(context_snapshot->>'source_version', ''))) > 0
                    AND context_snapshot ? 'locator'
                    AND jsonb_typeof(context_snapshot->'locator') = 'object'
                  )
                LIMIT 1
            ) THEN
                RAISE EXCEPTION
                    'reader_selection message contexts require canonical source_version snapshots';
            END IF;
        END $$;
        """
    )
    op.create_check_constraint(
        "ck_message_context_items_reader_selection_snapshot",
        "message_context_items",
        _READER_SELECTION_SNAPSHOT_CHECK,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_message_context_items_reader_selection_snapshot",
        "message_context_items",
        type_="check",
    )
