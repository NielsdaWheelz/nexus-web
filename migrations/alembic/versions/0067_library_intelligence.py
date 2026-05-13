"""Add library intelligence artifacts.

Revision ID: 0067
Revises: 0066
Create Date: 2026-05-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0067"
down_revision: str | None = "0066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "library_source_set_versions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_set_hash", sa.Text(), nullable=False),
        sa.Column("source_count", sa.Integer(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("schema_version", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("source_count >= 0", name="ck_library_source_sets_source_count"),
        sa.CheckConstraint("chunk_count >= 0", name="ck_library_source_sets_chunk_count"),
        sa.CheckConstraint(
            "char_length(source_set_hash) BETWEEN 1 AND 128",
            name="ck_library_source_sets_hash_length",
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_library_source_sets_prompt_version_length",
        ),
        sa.CheckConstraint(
            "char_length(schema_version) BETWEEN 1 AND 128",
            name="ck_library_source_sets_schema_version_length",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"]),
        sa.UniqueConstraint(
            "library_id",
            "source_set_hash",
            "prompt_version",
            "schema_version",
            name="uix_library_source_sets_version",
        ),
    )
    op.create_index(
        "idx_library_source_sets_library_created",
        "library_source_set_versions",
        ["library_id", "created_at"],
    )

    op.create_table(
        "library_source_set_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("source_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("podcast_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("media_kind", sa.Text(), nullable=True),
        sa.Column("readiness_state", sa.Text(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("included", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("exclusion_reason", sa.Text(), nullable=True),
        sa.Column("source_updated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(media_id IS NOT NULL AND podcast_id IS NULL) "
            "OR (media_id IS NULL AND podcast_id IS NOT NULL)",
            name="ck_library_source_set_items_one_source",
        ),
        sa.CheckConstraint(
            "source_kind IN ('media', 'podcast')",
            name="ck_library_source_set_items_source_kind",
        ),
        sa.CheckConstraint("chunk_count >= 0", name="ck_library_source_set_items_chunk_count"),
        sa.CheckConstraint(
            "(included = true AND exclusion_reason IS NULL) "
            "OR (included = false AND exclusion_reason IS NOT NULL)",
            name="ck_library_source_set_items_inclusion_reason",
        ),
        sa.ForeignKeyConstraint(
            ["source_set_version_id"],
            ["library_source_set_versions.id"],
        ),
        sa.UniqueConstraint(
            "source_set_version_id",
            "media_id",
            name="uix_library_source_set_items_media",
        ),
        sa.UniqueConstraint(
            "source_set_version_id",
            "podcast_id",
            name="uix_library_source_set_items_podcast",
        ),
    )
    op.create_index(
        "idx_library_source_set_items_version_included",
        "library_source_set_items",
        ["source_set_version_id", "included"],
    )

    op.create_table(
        "library_intelligence_artifacts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("artifact_kind", sa.Text(), nullable=False),
        sa.Column("active_version_id", postgresql.UUID(as_uuid=True), nullable=True),
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
        sa.CheckConstraint(
            "artifact_kind IN ('overview')",
            name="ck_library_intelligence_artifacts_kind",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"]),
        sa.UniqueConstraint(
            "library_id",
            "artifact_kind",
            name="uix_library_intelligence_artifacts_library_kind",
        ),
    )

    op.create_table(
        "library_intelligence_versions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("artifact_version", sa.Integer(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("generator_model_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("published_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("invalidated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("invalid_reason", sa.Text(), nullable=True),
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
        sa.CheckConstraint(
            "status IN ('building', 'active', 'failed', 'superseded', 'stale')",
            name="ck_library_intelligence_versions_status",
        ),
        sa.CheckConstraint(
            "artifact_version >= 1",
            name="ck_library_intelligence_versions_version_positive",
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_library_intelligence_versions_prompt_version_length",
        ),
        sa.CheckConstraint(
            "(status = 'active' AND published_at IS NOT NULL) OR (status != 'active')",
            name="ck_library_intelligence_versions_active_published",
        ),
        sa.CheckConstraint(
            "(invalid_reason IS NULL AND invalidated_at IS NULL) "
            "OR (invalid_reason IS NOT NULL AND invalidated_at IS NOT NULL)",
            name="ck_library_intelligence_versions_invalid_pair",
        ),
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["library_intelligence_artifacts.id"],
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"]),
        sa.ForeignKeyConstraint(
            ["source_set_version_id"],
            ["library_source_set_versions.id"],
        ),
        sa.ForeignKeyConstraint(["generator_model_id"], ["models.id"]),
        sa.UniqueConstraint(
            "artifact_id",
            "artifact_version",
            name="uix_library_intelligence_versions_artifact_version",
        ),
        sa.UniqueConstraint(
            "artifact_id",
            "source_set_version_id",
            "prompt_version",
            name="uix_library_intelligence_versions_source_prompt",
        ),
    )
    op.create_index(
        "idx_library_intelligence_versions_library_status",
        "library_intelligence_versions",
        ["library_id", "status"],
    )

    op.create_foreign_key(
        "fk_library_intelligence_artifacts_active_version",
        "library_intelligence_artifacts",
        "library_intelligence_versions",
        ["active_version_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )

    op.create_table(
        "library_intelligence_sections",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("section_kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_library_intelligence_sections_ordinal"),
        sa.CheckConstraint(
            "section_kind IN ('overview', 'key_topics', 'key_sources', 'tensions', "
            "'open_questions', 'reading_path', 'recent_changes')",
            name="ck_library_intelligence_sections_kind",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_library_intelligence_sections_metadata_object",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["library_intelligence_versions.id"],
        ),
        sa.UniqueConstraint(
            "version_id",
            "section_kind",
            name="uix_library_intelligence_sections_kind",
        ),
        sa.UniqueConstraint(
            "version_id",
            "ordinal",
            name="uix_library_intelligence_sections_ordinal",
        ),
    )

    op.create_table(
        "library_intelligence_nodes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("node_type", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "node_type IN ('topic', 'entity', 'source', 'tension', 'open_question')",
            name="ck_library_intelligence_nodes_type",
        ),
        sa.CheckConstraint(
            "char_length(slug) BETWEEN 1 AND 160",
            name="ck_library_intelligence_nodes_slug_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_library_intelligence_nodes_metadata_object",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["library_intelligence_versions.id"],
        ),
        sa.UniqueConstraint("version_id", "slug", name="uix_library_intelligence_nodes_slug"),
    )
    op.create_index(
        "idx_library_intelligence_nodes_version_type",
        "library_intelligence_nodes",
        ["version_id", "node_type"],
    )

    op.create_table(
        "library_intelligence_claims",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("section_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("claim_text", sa.Text(), nullable=False),
        sa.Column("support_state", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "node_id IS NOT NULL OR section_id IS NOT NULL",
            name="ck_library_intelligence_claims_parent",
        ),
        sa.CheckConstraint(
            "char_length(btrim(claim_text)) BETWEEN 1 AND 50000",
            name="ck_library_intelligence_claims_text_length",
        ),
        sa.CheckConstraint(
            """
            support_state IN (
                'supported',
                'partially_supported',
                'contradicted',
                'not_enough_evidence',
                'out_of_scope',
                'not_source_grounded'
            )
            """,
            name="ck_library_intelligence_claims_support_state",
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_library_intelligence_claims_confidence",
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_library_intelligence_claims_ordinal"),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["library_intelligence_versions.id"],
        ),
        sa.ForeignKeyConstraint(
            ["node_id"],
            ["library_intelligence_nodes.id"],
        ),
        sa.ForeignKeyConstraint(
            ["section_id"],
            ["library_intelligence_sections.id"],
        ),
        sa.UniqueConstraint(
            "version_id",
            "ordinal",
            name="uix_library_intelligence_claims_version_ordinal",
        ),
    )

    op.create_table(
        "library_intelligence_evidence",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("claim_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(), nullable=False),
        sa.Column("snippet", sa.Text(), nullable=False),
        sa.Column("locator", postgresql.JSONB(), nullable=True),
        sa.Column("support_role", sa.Text(), nullable=False),
        sa.Column("retrieval_status", sa.Text(), nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_library_intelligence_evidence_source_ref_object",
        ),
        sa.CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_library_intelligence_evidence_locator_object",
        ),
        sa.CheckConstraint(
            "support_role IN ('supports', 'contradicts', 'context')",
            name="ck_library_intelligence_evidence_support_role",
        ),
        sa.CheckConstraint(
            "retrieval_status IN ('retrieved', 'selected', 'included_in_artifact', "
            "'excluded_by_scope', 'excluded_by_source_state')",
            name="ck_library_intelligence_evidence_retrieval_status",
        ),
        sa.CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_library_intelligence_evidence_score",
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"],
            ["library_intelligence_claims.id"],
        ),
    )
    op.create_index(
        "idx_library_intelligence_evidence_claim",
        "library_intelligence_evidence",
        ["claim_id"],
    )

    op.create_table(
        "library_intelligence_builds",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("artifact_kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("phase", sa.Text(), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "diagnostics",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("finished_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
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
        sa.CheckConstraint(
            "artifact_kind IN ('overview')",
            name="ck_library_intelligence_builds_kind",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_library_intelligence_builds_status",
        ),
        sa.CheckConstraint(
            "phase IN ('queued', 'source_set', 'synthesis', 'evidence', "
            "'publish', 'complete', 'failed')",
            name="ck_library_intelligence_builds_phase",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(diagnostics) = 'object'",
            name="ck_library_intelligence_builds_diagnostics_object",
        ),
        sa.CheckConstraint(
            "(status = 'failed' AND error_code IS NOT NULL) OR (status != 'failed')",
            name="ck_library_intelligence_builds_failed_error",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"]),
        sa.ForeignKeyConstraint(
            ["source_set_version_id"],
            ["library_source_set_versions.id"],
        ),
        sa.UniqueConstraint(
            "idempotency_key",
            name="uix_library_intelligence_builds_idempotency_key",
        ),
    )
    op.create_index(
        "idx_library_intelligence_builds_library_status",
        "library_intelligence_builds",
        ["library_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_library_intelligence_builds_library_status",
        table_name="library_intelligence_builds",
    )
    op.drop_table("library_intelligence_builds")
    op.drop_index(
        "idx_library_intelligence_evidence_claim",
        table_name="library_intelligence_evidence",
    )
    op.drop_table("library_intelligence_evidence")
    op.drop_table("library_intelligence_claims")
    op.drop_index(
        "idx_library_intelligence_nodes_version_type", table_name="library_intelligence_nodes"
    )
    op.drop_table("library_intelligence_nodes")
    op.drop_table("library_intelligence_sections")
    op.drop_constraint(
        "fk_library_intelligence_artifacts_active_version",
        "library_intelligence_artifacts",
        type_="foreignkey",
    )
    op.drop_index(
        "idx_library_intelligence_versions_library_status",
        table_name="library_intelligence_versions",
    )
    op.drop_table("library_intelligence_versions")
    op.drop_table("library_intelligence_artifacts")
    op.drop_index(
        "idx_library_source_set_items_version_included",
        table_name="library_source_set_items",
    )
    op.drop_table("library_source_set_items")
    op.drop_index(
        "idx_library_source_sets_library_created",
        table_name="library_source_set_versions",
    )
    op.drop_table("library_source_set_versions")
