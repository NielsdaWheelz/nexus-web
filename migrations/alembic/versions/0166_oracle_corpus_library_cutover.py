"""Oracle corpus library hard cutover.

Revision ID: 0166
Revises: 0165
Create Date: 2026-06-17

Makes the Oracle public-domain corpus a real Nexus library of real media indexed
through the shared content-index substrate. Adds ``libraries.system_key``, the
``oracle_corpus_sources`` work→media mapping, and ``oracle_passage_anchors`` (stable
curation identity that resolves to current media evidence). Renames
``oracle_corpus_images`` → ``oracle_plates`` and drops its text embeddings. Drops the
old Oracle-owned corpus vector store (``oracle_corpus_works``/``oracle_corpus_passages``)
and swaps the ``oracle_corpus_passage`` resource scheme for ``oracle_passage_anchor``
across every scheme CHECK.

Historical Oracle readings cite ``oracle_corpus_passage`` targets that cannot map to
media-backed anchors without re-ingestion, so this is the one-time operator deletion of
pre-existing Oracle reading state (a fresh Aleph; spec AC-M3). Re-seed via
``scripts/oracle/seed_corpus_library.py``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0166"
down_revision: str | Sequence[str] | None = "0165"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Full resource-scheme list with oracle_corpus_passage → oracle_passage_anchor.
RESOURCE_SCHEMES = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_passage_anchor', 'library_intelligence_artifact',
    'library_intelligence_revision', 'external_snapshot',
    'contributor', 'podcast', 'reader_apparatus_item'
"""
# synapse_suppressions predates the LI-revision/reader-apparatus schemes.
SYNAPSE_SCHEMES = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_passage_anchor', 'library_intelligence_artifact',
    'external_snapshot', 'contributor', 'podcast'
"""

_OLD_SCHEMES = ("oracle_reading", "oracle_corpus_passage")


def upgrade() -> None:
    # --- delete pre-existing Oracle reading state (folios → events → readings),
    # then the now-invalid citation/graph rows referencing the dropped schemes.
    op.execute("DELETE FROM oracle_reading_folios")
    op.execute("DELETE FROM oracle_reading_events")
    op.execute("DELETE FROM oracle_readings")
    op.execute("""
        UPDATE chat_run_turn_contexts
        SET requested_subject_scheme = NULL,
            requested_subject_id = NULL
        WHERE requested_subject_scheme IN ('oracle_reading', 'oracle_corpus_passage')
    """)
    op.execute("""
        UPDATE chat_run_turn_contexts
        SET subject_context_edge_id = NULL
        WHERE subject_context_edge_id IN (
            SELECT id
            FROM resource_edges
            WHERE source_scheme IN ('oracle_reading', 'oracle_corpus_passage')
               OR target_scheme IN ('oracle_reading', 'oracle_corpus_passage')
        )
    """)
    op.execute("""
        UPDATE chat_run_turn_contexts
        SET subject_scheme = NULL,
            subject_id = NULL
        WHERE subject_scheme IN ('oracle_reading', 'oracle_corpus_passage')
          AND reader_selection_highlight_id IS NOT NULL
    """)
    op.execute("""
        DELETE FROM chat_run_turn_contexts
        WHERE subject_scheme IN ('oracle_reading', 'oracle_corpus_passage')
    """)
    op.execute(
        "DELETE FROM resource_edges "
        "WHERE source_scheme IN ('oracle_reading', 'oracle_corpus_passage') "
        "   OR target_scheme IN ('oracle_reading', 'oracle_corpus_passage')"
    )
    op.execute(
        "DELETE FROM synapse_suppressions "
        "WHERE source_scheme IN ('oracle_reading', 'oracle_corpus_passage') "
        "   OR target_scheme IN ('oracle_reading', 'oracle_corpus_passage')"
    )
    op.execute("DELETE FROM resource_versions WHERE resource_scheme = 'oracle_corpus_passage'")
    op.execute(
        "DELETE FROM resource_view_states "
        "WHERE surface_scheme = 'oracle_corpus_passage' "
        "   OR target_scheme = 'oracle_corpus_passage'"
    )

    # --- libraries.system_key
    op.add_column("libraries", sa.Column("system_key", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_libraries_system_key",
        "libraries",
        "system_key IS NULL OR char_length(system_key) BETWEEN 1 AND 80",
    )
    op.create_index(
        "uix_libraries_system_key",
        "libraries",
        ["system_key"],
        unique=True,
        postgresql_where=sa.text("system_key IS NOT NULL"),
    )

    # --- corpus work → media mapping
    op.create_table(
        "oracle_corpus_sources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("corpus_key", sa.Text(), nullable=False, server_default=sa.text("'oracle'")),
        sa.Column("work_key", sa.Text(), nullable=False),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("author_text", sa.Text(), nullable=False),
        sa.Column("source_repository", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("source_download_url", sa.Text(), nullable=False),
        sa.Column("source_media_kind", sa.Text(), nullable=False),
        sa.Column("display_order", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.CheckConstraint(
            "char_length(work_key) BETWEEN 1 AND 160", name="ck_oracle_corpus_sources_key"
        ),
        sa.CheckConstraint(
            "source_media_kind IN ('epub', 'web_article', 'pdf')",
            name="ck_oracle_corpus_sources_kind",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"]),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.UniqueConstraint("corpus_key", "work_key", name="uix_oracle_corpus_sources_work"),
        sa.UniqueConstraint("media_id", name="uix_oracle_corpus_sources_media"),
    )

    # --- stable passage anchors (current pointers carry no FK, by design)
    op.create_table(
        "oracle_passage_anchors",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("corpus_source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("passage_key", sa.Text(), nullable=False),
        sa.Column("display_label", sa.Text(), nullable=False),
        sa.Column("selector", postgresql.JSONB(), nullable=False),
        sa.Column(
            "tags", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "phase_hints", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column("current_evidence_span_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("current_content_chunk_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "resolution_status", sa.Text(), nullable=False, server_default=sa.text("'pending'")
        ),
        sa.Column("resolution_error", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(selector) = 'object'", name="ck_oracle_passage_anchors_selector"
        ),
        sa.CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_passage_anchors_tags"),
        sa.CheckConstraint(
            "jsonb_typeof(phase_hints) = 'array'", name="ck_oracle_passage_anchors_phase_hints"
        ),
        sa.CheckConstraint(
            "resolution_status IN ('pending', 'resolved', 'failed')",
            name="ck_oracle_passage_anchors_status",
        ),
        sa.CheckConstraint(
            """
            (
                resolution_status = 'pending'
                AND current_evidence_span_id IS NULL
                AND current_content_chunk_id IS NULL
                AND resolved_at IS NULL
                AND resolution_error IS NULL
            )
            OR (
                resolution_status = 'resolved'
                AND current_content_chunk_id IS NOT NULL
                AND resolved_at IS NOT NULL
                AND resolution_error IS NULL
            )
            OR (
                resolution_status = 'failed'
                AND current_evidence_span_id IS NULL
                AND current_content_chunk_id IS NULL
                AND resolved_at IS NULL
                AND resolution_error IS NOT NULL
            )
            """,
            name="ck_oracle_passage_anchors_resolution_state",
        ),
        sa.ForeignKeyConstraint(["corpus_source_id"], ["oracle_corpus_sources.id"]),
        sa.UniqueConstraint("corpus_source_id", "passage_key", name="uix_oracle_passage_anchors_key"),
    )

    # --- oracle_corpus_images → oracle_plates; drop text embeddings
    op.rename_table("oracle_corpus_images", "oracle_plates")
    op.drop_column("oracle_plates", "embedding")
    # dropping embedding_model cascades idx_oracle_images_embedding + its length CHECK
    op.drop_column("oracle_plates", "embedding_model")
    for old, new in (
        ("oracle_corpus_images_pkey", "oracle_plates_pkey"),
        ("ck_oracle_images_width_positive", "ck_oracle_plates_width_positive"),
        ("ck_oracle_images_height_positive", "ck_oracle_plates_height_positive"),
        ("ck_oracle_images_tags_array", "ck_oracle_plates_tags_array"),
        ("ck_oracle_images_storage_key_shape", "ck_oracle_plates_storage_key_shape"),
        ("ck_oracle_images_content_type", "ck_oracle_plates_content_type"),
        ("ck_oracle_images_byte_size_positive", "ck_oracle_plates_byte_size_positive"),
        (
            "ck_oracle_images_storage_key_content_type_match",
            "ck_oracle_plates_storage_key_content_type_match",
        ),
        ("uix_oracle_images_source_url", "uix_oracle_plates_source_url"),
    ):
        op.execute(f"ALTER TABLE oracle_plates RENAME CONSTRAINT {old} TO {new}")
    op.create_check_constraint(
        "ck_oracle_plates_width_safe",
        "oracle_plates",
        "width <= 4096",
    )
    op.create_check_constraint(
        "ck_oracle_plates_height_safe",
        "oracle_plates",
        "height <= 4096",
    )
    op.create_check_constraint(
        "ck_oracle_plates_byte_size_safe",
        "oracle_plates",
        "byte_size <= 10485760",
    )

    # --- drop the old Oracle-owned corpus vector store
    op.drop_table("oracle_corpus_passages")
    op.drop_table("oracle_corpus_works")

    # --- swap oracle_corpus_passage → oracle_passage_anchor in every scheme CHECK
    for name, table, predicate in (
        ("ck_resource_edges_source_scheme", "resource_edges", f"source_scheme IN ({RESOURCE_SCHEMES})"),
        ("ck_resource_edges_target_scheme", "resource_edges", f"target_scheme IN ({RESOURCE_SCHEMES})"),
        (
            "ck_resource_versions_resource_scheme",
            "resource_versions",
            f"resource_scheme IN ({RESOURCE_SCHEMES})",
        ),
        (
            "ck_resource_view_states_surface_scheme",
            "resource_view_states",
            f"surface_scheme IN ({RESOURCE_SCHEMES})",
        ),
        (
            "ck_resource_view_states_target_scheme",
            "resource_view_states",
            f"target_scheme IS NULL OR target_scheme IN ({RESOURCE_SCHEMES})",
        ),
        (
            "ck_synapse_suppressions_source_scheme",
            "synapse_suppressions",
            f"source_scheme IN ({SYNAPSE_SCHEMES})",
        ),
        (
            "ck_synapse_suppressions_target_scheme",
            "synapse_suppressions",
            f"target_scheme IN ({SYNAPSE_SCHEMES})",
        ),
        (
            "ck_chat_run_turn_contexts_requested_subject_scheme",
            "chat_run_turn_contexts",
            f"requested_subject_scheme IS NULL OR requested_subject_scheme IN ({RESOURCE_SCHEMES})",
        ),
        (
            "ck_chat_run_turn_contexts_subject_scheme",
            "chat_run_turn_contexts",
            f"subject_scheme IS NULL OR subject_scheme IN ({RESOURCE_SCHEMES})",
        ),
    ):
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, predicate)


def downgrade() -> None:
    raise NotImplementedError("0166 is a hard cutover migration and has no downgrade path")
