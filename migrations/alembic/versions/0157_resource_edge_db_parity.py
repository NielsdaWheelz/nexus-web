"""Resource edge DB parity hard cutover.

Revision ID: 0157
Revises: 0156
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0157"
down_revision: str | Sequence[str] | None = "0156"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        DELETE FROM resource_edges
        WHERE source_scheme = target_scheme AND source_id = target_id
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'citation'
          AND ordinal IS NULL
          AND NOT (
              kind = 'context'
              AND source_scheme = 'conversation'
              AND snapshot IS NULL
          )
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'citation'
          AND ordinal IS NOT NULL
          AND source_scheme NOT IN (
              'message', 'oracle_reading', 'library_intelligence_revision'
          )
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'system'
          AND NOT (
              kind = 'context'
              AND source_scheme = 'conversation'
              AND ordinal IS NULL
              AND snapshot IS NULL
          )
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'note_body'
          AND NOT (
              kind = 'context'
              AND source_scheme IN ('page', 'note_block')
              AND source_order_key IS NULL
              AND target_order_key IS NULL
              AND ordinal IS NULL
              AND snapshot IS NULL
          )
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'synapse'
          AND NOT (
              source_scheme IN ('media', 'page', 'note_block', 'highlight')
              AND target_scheme IN ('media', 'note_block')
              AND source_order_key IS NULL
              AND target_order_key IS NULL
              AND ordinal IS NULL
          )
    """)
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'synapse'
          AND (
              snapshot IS NULL
              OR NOT (
                  snapshot ? 'excerpt'
                  AND jsonb_typeof(snapshot->'excerpt') = 'string'
                  AND btrim(snapshot->>'excerpt') <> ''
              )
          )
    """)
    op.execute("""
        UPDATE resource_edges
        SET source_order_key = NULL
        WHERE source_order_key IS NOT NULL
          AND NOT (
              origin = 'note_containment'
              OR (
                  kind = 'context'
                  AND origin IN ('user', 'citation', 'system')
                  AND source_scheme = 'conversation'
                  AND ordinal IS NULL
                  AND snapshot IS NULL
              )
          )
    """)
    op.execute("""
        UPDATE resource_edges
        SET target_order_key = NULL
        WHERE target_order_key IS NOT NULL
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_no_self_edge CHECK (
            NOT (source_scheme = target_scheme AND source_id = target_id)
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_source_order_key_shape CHECK (
            source_order_key IS NULL
            OR origin = 'note_containment'
            OR (
                kind = 'context'
                AND origin IN ('user', 'citation', 'system')
                AND source_scheme = 'conversation'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
        )
    """)
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_target_order_key_length")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_target_order_key_reserved CHECK (
            target_order_key IS NULL
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_synapse_snapshot_excerpt CHECK (
            origin != 'synapse'
            OR (
                snapshot IS NOT NULL
                AND snapshot ? 'excerpt'
                AND jsonb_typeof(snapshot->'excerpt') = 'string'
                AND btrim(snapshot->>'excerpt') <> ''
            )
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_citation_shape CHECK (
            origin != 'citation'
            OR (
                ordinal IS NULL
                AND kind = 'context'
                AND source_scheme = 'conversation'
                AND snapshot IS NULL
            )
            OR (
                ordinal IS NOT NULL
                AND source_scheme IN (
                    'message', 'oracle_reading', 'library_intelligence_revision'
                )
            )
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_system_shape CHECK (
            origin != 'system'
            OR (
                kind = 'context'
                AND source_scheme = 'conversation'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_note_body_shape CHECK (
            origin != 'note_body'
            OR (
                kind = 'context'
                AND source_scheme IN ('page', 'note_block')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_synapse_shape CHECK (
            origin != 'synapse'
            OR (
                source_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND target_scheme IN ('media', 'note_block')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
            )
        )
    """)
    op.drop_index("uq_resource_edges_containment_target_order", table_name="resource_edges")
    op.drop_index("ix_resource_edges_user_target", table_name="resource_edges")
    op.create_index(
        "ix_resource_edges_user_target",
        "resource_edges",
        ["user_id", "origin", "target_scheme", "target_id", "id"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0157 is not reversible")
