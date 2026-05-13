"""Daily notes, pinned object refs, and object-search projection.

Revision ID: 0077
Revises: 0076
Create Date: 2026-05-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0077"
down_revision: str | None = "0076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OBJECT_REF_TYPES = (
    "'page', 'note_block', 'media', 'highlight', 'conversation', "
    "'message', 'podcast', 'content_chunk', 'contributor'"
)


def upgrade() -> None:
    op.create_table(
        "daily_note_pages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("time_zone", sa.Text(), nullable=False, server_default="UTC"),
        sa.Column("page_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"]),
        sa.CheckConstraint(
            "char_length(time_zone) BETWEEN 1 AND 100",
            name="ck_daily_note_pages_time_zone_length",
        ),
        sa.UniqueConstraint("user_id", "local_date", name="uix_daily_note_pages_user_date"),
        sa.UniqueConstraint("user_id", "page_id", name="uix_daily_note_pages_user_page"),
    )

    op.create_table(
        "user_pinned_objects",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("object_type", sa.Text(), nullable=False),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("surface_key", sa.Text(), nullable=False),
        sa.Column("order_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint(
            f"object_type IN ({_OBJECT_REF_TYPES})",
            name="ck_user_pinned_objects_type",
        ),
        sa.CheckConstraint(
            "char_length(surface_key) BETWEEN 1 AND 64",
            name="ck_user_pinned_objects_surface_key_length",
        ),
        sa.CheckConstraint(
            "char_length(order_key) BETWEEN 1 AND 64",
            name="ck_user_pinned_objects_order_key_length",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "user_id",
            "surface_key",
            "object_type",
            "object_id",
            name="uix_user_pinned_objects_surface_ref",
        ),
    )

    op.create_table(
        "object_search_documents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("object_type", sa.Text(), nullable=False),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("parent_object_type", sa.Text(), nullable=True),
        sa.Column("parent_object_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title_text", sa.Text(), nullable=False),
        sa.Column("body_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("route_path", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("index_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("index_status", sa.Text(), nullable=False, server_default="pending_embedding"),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint(
            "object_type IN ('page', 'note_block')",
            name="ck_object_search_documents_type",
        ),
        sa.CheckConstraint(
            "parent_object_type IS NULL OR parent_object_type IN ('page')",
            name="ck_osd_parent_object_type",
        ),
        sa.CheckConstraint(
            "(parent_object_type IS NULL) = (parent_object_id IS NULL)",
            name="ck_osd_parent_shape",
        ),
        sa.CheckConstraint(
            "char_length(title_text) BETWEEN 1 AND 300",
            name="ck_osd_title_text_length",
        ),
        sa.CheckConstraint(
            "char_length(search_text) >= 1",
            name="ck_osd_search_text_length",
        ),
        sa.CheckConstraint(
            "char_length(route_path) BETWEEN 1 AND 500",
            name="ck_osd_route_path_length",
        ),
        sa.CheckConstraint(
            "char_length(content_hash) BETWEEN 1 AND 128",
            name="ck_osd_content_hash_length",
        ),
        sa.CheckConstraint("index_version > 0", name="ck_osd_index_version"),
        sa.CheckConstraint(
            "index_status IN ('pending_embedding', 'ready')",
            name="ck_osd_index_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "user_id",
            "object_type",
            "object_id",
            "index_version",
            name="uix_osd_object_ref_version",
        ),
    )
    op.execute(
        """
        ALTER TABLE object_search_documents
        ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
            to_tsvector('english'::regconfig, search_text)
        ) STORED
        """
    )
    op.create_index(
        "ix_osd_search_vector",
        "object_search_documents",
        ["search_vector"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_osd_user_type_updated",
        "object_search_documents",
        ["user_id", "object_type", "updated_at"],
    )

    op.create_table(
        "object_search_embeddings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("search_document_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("object_type", sa.Text(), nullable=False),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column("embedding_dimensions", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("index_version", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint(
            "object_type IN ('page', 'note_block')",
            name="ck_ose_object_type",
        ),
        sa.CheckConstraint(
            "char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_ose_model_length",
        ),
        sa.CheckConstraint("embedding_dimensions > 0", name="ck_ose_dimensions"),
        sa.CheckConstraint(
            "char_length(content_hash) BETWEEN 1 AND 128",
            name="ck_ose_content_hash_length",
        ),
        sa.CheckConstraint("index_version > 0", name="ck_ose_index_version"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["search_document_id"], ["object_search_documents.id"]),
        sa.UniqueConstraint(
            "search_document_id",
            "embedding_model",
            "index_version",
            name="uix_ose_document_model_version",
        ),
    )
    op.execute("ALTER TABLE object_search_embeddings ADD COLUMN embedding vector(256)")
    op.create_index("ix_ose_model", "object_search_embeddings", ["user_id", "embedding_model"])
    op.execute(
        """
        CREATE INDEX ix_ose_embedding_ann
        ON object_search_embeddings
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
        """
    )

    op.execute(
        """
        INSERT INTO object_search_documents (
            user_id, object_type, object_id, title_text, body_text, search_text,
            route_path, content_hash, index_version, index_status, created_at, updated_at
        )
        SELECT
            user_id,
            'page',
            id,
            title,
            COALESCE(description, ''),
            concat_ws(' ', title, COALESCE(description, '')),
            '/pages/' || id::text,
            md5(concat_ws(' ', title, COALESCE(description, ''))),
            1,
            'pending_embedding',
            created_at,
            updated_at
        FROM pages
        """
    )
    op.execute(
        """
        INSERT INTO object_search_documents (
            user_id, object_type, object_id, parent_object_type, parent_object_id,
            title_text, body_text, search_text, route_path, content_hash, index_version,
            index_status, created_at, updated_at
        )
        SELECT
            nb.user_id,
            'note_block',
            nb.id,
            'page',
            nb.page_id,
            p.title,
            nb.body_text,
            concat_ws(' ', p.title, nb.body_text),
            '/notes/' || nb.id::text,
            md5(concat_ws(' ', p.title, nb.body_text)),
            1,
            'pending_embedding',
            nb.created_at,
            nb.updated_at
        FROM note_blocks nb
        JOIN pages p ON p.id = nb.page_id
        """
    )


def downgrade() -> None:
    op.drop_index("ix_ose_embedding_ann", table_name="object_search_embeddings")
    op.drop_index("ix_ose_model", table_name="object_search_embeddings")
    op.drop_table("object_search_embeddings")
    op.drop_index("ix_osd_user_type_updated", table_name="object_search_documents")
    op.drop_index("ix_osd_search_vector", table_name="object_search_documents")
    op.drop_table("object_search_documents")
    op.drop_table("user_pinned_objects")
    op.drop_table("daily_note_pages")
