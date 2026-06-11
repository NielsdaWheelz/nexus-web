"""notes/pages resource graph order foundations

Revision ID: 0148
Revises: 0147
Create Date: 2026-06-10

Adds ordered-adjacency fields to ``resource_edges``, makes bare edge uniqueness
origin-aware, backfills note containment into graph edges, and removes the old
note block tree columns.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0148"
down_revision: str | Sequence[str] | None = "0147"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "pages",
        sa.Column("document_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.create_check_constraint(
        "ck_pages_document_version_positive",
        "pages",
        "document_version >= 1",
    )

    op.create_table(
        "page_document_mutations",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("page_id", sa.UUID(), nullable=False),
        sa.Column("client_mutation_id", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("base_document_version", sa.Integer(), nullable=False),
        sa.Column("document_version", sa.Integer(), nullable=False),
        sa.Column("response_json", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "page_id",
            "client_mutation_id",
            name="uix_page_document_mutations_client_id",
        ),
        sa.CheckConstraint(
            "char_length(client_mutation_id) BETWEEN 1 AND 120",
            name="ck_page_document_mutations_client_mutation_id_length",
        ),
        sa.CheckConstraint(
            "char_length(request_hash) = 64",
            name="ck_page_document_mutations_request_hash_length",
        ),
        sa.CheckConstraint(
            "base_document_version >= 1",
            name="ck_page_document_mutations_base_document_version_positive",
        ),
        sa.CheckConstraint(
            "document_version >= 1",
            name="ck_page_document_mutations_document_version_positive",
        ),
    )

    op.create_table(
        "tags",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_tags_name_length"),
        sa.CheckConstraint("char_length(slug) BETWEEN 1 AND 100", name="ck_tags_slug_length"),
        sa.UniqueConstraint("user_id", "slug", name="uix_tags_user_slug"),
    )

    op.create_table(
        "note_view_states",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("context_source_scheme", sa.Text(), nullable=False),
        sa.Column("context_source_id", sa.UUID(), nullable=False),
        sa.Column("target_block_id", sa.UUID(), nullable=False),
        sa.Column("collapsed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["target_block_id"], ["note_blocks.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "context_source_scheme",
            "context_source_id",
            "target_block_id",
            name="uix_note_view_states_occurrence",
        ),
        sa.CheckConstraint(
            "context_source_scheme IN ('page', 'note_block')",
            name="ck_note_view_states_context_source_scheme",
        ),
    )

    op.add_column("resource_edges", sa.Column("source_order_key", sa.Text(), nullable=True))
    op.add_column("resource_edges", sa.Column("target_order_key", sa.Text(), nullable=True))

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute("""
        ALTER TABLE resource_edges
        ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'note_containment'
            )
        )
    """)

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_source_scheme")
    op.execute("""
        ALTER TABLE resource_edges
        ADD CONSTRAINT ck_resource_edges_source_scheme CHECK (
            source_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_corpus_passage', 'library_intelligence_artifact',
                'external_snapshot', 'contributor', 'podcast', 'tag'
            )
        )
    """)

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_target_scheme")
    op.execute("""
        ALTER TABLE resource_edges
        ADD CONSTRAINT ck_resource_edges_target_scheme CHECK (
            target_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_corpus_passage', 'library_intelligence_artifact',
                'external_snapshot', 'contributor', 'podcast', 'tag'
            )
        )
    """)

    op.create_check_constraint(
        "ck_resource_edges_source_order_key_length",
        "resource_edges",
        "source_order_key IS NULL OR char_length(source_order_key) BETWEEN 1 AND 64",
    )
    op.create_check_constraint(
        "ck_resource_edges_target_order_key_length",
        "resource_edges",
        "target_order_key IS NULL OR char_length(target_order_key) BETWEEN 1 AND 64",
    )
    op.create_check_constraint(
        "ck_resource_edges_ordinal_origin",
        "resource_edges",
        "ordinal IS NULL OR origin = 'citation'",
    )
    op.create_check_constraint(
        "ck_resource_edges_citation_no_order",
        "resource_edges",
        "ordinal IS NULL OR (source_order_key IS NULL AND target_order_key IS NULL)",
    )
    op.create_check_constraint(
        "ck_resource_edges_snapshot_has_ordinal",
        "resource_edges",
        "snapshot IS NULL OR ordinal IS NOT NULL",
    )
    op.create_check_constraint(
        "ck_resource_edges_snapshot_origin",
        "resource_edges",
        "snapshot IS NULL OR origin = 'citation'",
    )
    op.create_check_constraint(
        "ck_resource_edges_note_containment_shape",
        "resource_edges",
        """
        origin != 'note_containment'
        OR (
            kind = 'context'
            AND source_scheme IN ('page', 'note_block')
            AND target_scheme = 'note_block'
            AND source_order_key IS NOT NULL
            AND ordinal IS NULL
            AND snapshot IS NULL
            AND NOT (source_scheme = target_scheme AND source_id = target_id)
        )
        """,
    )
    op.create_check_constraint(
        "ck_resource_edges_highlight_note_shape",
        "resource_edges",
        """
        origin != 'highlight_note'
        OR (
            kind = 'context'
            AND source_scheme = 'highlight'
            AND target_scheme = 'note_block'
            AND source_order_key IS NULL
            AND target_order_key IS NULL
            AND ordinal IS NULL
            AND snapshot IS NULL
        )
        """,
    )

    op.drop_index("uq_resource_edges_citation_ordinal", table_name="resource_edges")
    op.drop_index("uq_resource_edges_context_pair", table_name="resource_edges")
    op.drop_index("ix_resource_edges_user_source", table_name="resource_edges")
    op.drop_index("ix_resource_edges_user_target", table_name="resource_edges")

    op.create_index(
        "uq_resource_edges_citation_ordinal",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "ordinal"],
        unique=True,
        postgresql_where=sa.text("ordinal IS NOT NULL"),
    )
    op.create_index(
        "uq_resource_edges_context_pair",
        "resource_edges",
        ["user_id", "origin", "source_scheme", "source_id", "target_scheme", "target_id"],
        unique=True,
        postgresql_where=sa.text("ordinal IS NULL"),
    )
    op.create_index(
        "uq_resource_edges_containment_source_order",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "source_order_key"],
        unique=True,
        postgresql_where=sa.text(
            "origin = 'note_containment' AND source_order_key IS NOT NULL"
        ),
    )
    op.create_index(
        "uq_resource_edges_containment_target_order",
        "resource_edges",
        ["user_id", "target_scheme", "target_id", "target_order_key"],
        unique=True,
        postgresql_where=sa.text(
            "origin = 'note_containment' AND target_order_key IS NOT NULL"
        ),
    )
    op.create_index(
        "uq_resource_edges_containment_target_once",
        "resource_edges",
        ["user_id", "target_scheme", "target_id"],
        unique=True,
        postgresql_where=sa.text("origin = 'note_containment'"),
    )
    op.create_index(
        "ix_resource_edges_user_source",
        "resource_edges",
        ["user_id", "origin", "source_scheme", "source_id", "source_order_key", "id"],
    )
    op.create_index(
        "ix_resource_edges_user_target",
        "resource_edges",
        ["user_id", "origin", "target_scheme", "target_id", "target_order_key", "id"],
    )

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM note_blocks child
                JOIN pages page ON page.id = child.page_id
                WHERE page.user_id <> child.user_id
            ) THEN
                RAISE EXCEPTION '0148 preflight failed: note block page crosses user boundary';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM note_blocks child
                JOIN note_blocks parent ON parent.id = child.parent_block_id
                WHERE parent.user_id <> child.user_id
            ) THEN
                RAISE EXCEPTION '0148 preflight failed: note block parent crosses user boundary';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM note_blocks child
                JOIN note_blocks parent ON parent.id = child.parent_block_id
                WHERE parent.page_id <> child.page_id
            ) THEN
                RAISE EXCEPTION '0148 preflight failed: note block parent crosses page boundary';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM note_blocks
                WHERE parent_block_id = id
            ) THEN
                RAISE EXCEPTION '0148 preflight failed: note block cannot parent itself';
            END IF;

            IF EXISTS (
                WITH RECURSIVE ancestors(block_id, ancestor_id, path, cycle) AS (
                    SELECT id, parent_block_id, ARRAY[id], false
                    FROM note_blocks
                    WHERE parent_block_id IS NOT NULL
                    UNION ALL
                    SELECT
                        ancestors.block_id,
                        parent.parent_block_id,
                        ancestors.path || ancestors.ancestor_id,
                        parent.parent_block_id = ANY(ancestors.path)
                    FROM ancestors
                    JOIN note_blocks parent ON parent.id = ancestors.ancestor_id
                    WHERE ancestors.ancestor_id IS NOT NULL
                      AND NOT ancestors.cycle
                )
                SELECT 1 FROM ancestors WHERE cycle
            ) THEN
                RAISE EXCEPTION '0148 preflight failed: note block containment cycle';
            END IF;
        END $$;
    """)

    op.execute("""
        WITH ordered AS (
            SELECT
                id,
                user_id,
                CASE
                    WHEN parent_block_id IS NULL THEN 'page'
                    ELSE 'note_block'
                END AS source_scheme,
                COALESCE(parent_block_id, page_id) AS source_id,
                lpad(
                    row_number() OVER (
                        PARTITION BY user_id, page_id, parent_block_id
                        ORDER BY order_key ASC, created_at ASC, id ASC
                    )::text,
                    10,
                    '0'
                ) AS source_order_key
            FROM note_blocks
        )
        INSERT INTO resource_edges (
            user_id, kind, origin, source_scheme, source_id,
            target_scheme, target_id, source_order_key
        )
        SELECT
            user_id, 'context', 'note_containment', source_scheme, source_id,
            'note_block', id, source_order_key
        FROM ordered
    """)

    op.execute("""
        WITH collapsed_blocks AS (
            SELECT
                user_id,
                CASE
                    WHEN parent_block_id IS NULL THEN 'page'
                    ELSE 'note_block'
                END AS context_source_scheme,
                COALESCE(parent_block_id, page_id) AS context_source_id,
                id AS target_block_id
            FROM note_blocks
            WHERE collapsed
        )
        INSERT INTO note_view_states (
            user_id, context_source_scheme, context_source_id, target_block_id, collapsed
        )
        SELECT user_id, context_source_scheme, context_source_id, target_block_id, true
        FROM collapsed_blocks
    """)

    op.drop_constraint("note_blocks_page_id_fkey", "note_blocks", type_="foreignkey")
    op.drop_constraint("note_blocks_parent_block_id_fkey", "note_blocks", type_="foreignkey")
    op.drop_constraint("ck_note_blocks_order_key_length", "note_blocks", type_="check")
    op.drop_column("note_blocks", "collapsed")
    op.drop_column("note_blocks", "order_key")
    op.drop_column("note_blocks", "parent_block_id")
    op.drop_column("note_blocks", "page_id")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0148 is not reversible")
