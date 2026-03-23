"""Add transcript state/versioning, semantic chunks, and request audits.

Revision ID: 0024
Revises: 0023
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_transcript_versions",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("transcript_coverage", sa.Text(), nullable=False, server_default="full"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("request_reason", sa.Text(), nullable=False, server_default="episode_open"),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "version_no >= 1",
            name="ck_podcast_transcript_versions_version_no_positive",
        ),
        sa.CheckConstraint(
            "transcript_coverage IN ('none', 'partial', 'full')",
            name="ck_podcast_transcript_versions_coverage",
        ),
        sa.CheckConstraint(
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue'"
            ")",
            name="ck_podcast_transcript_versions_request_reason",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("media_id", "version_no", name="uq_podcast_transcript_versions_media_no"),
    )
    op.create_index(
        "uix_podcast_transcript_versions_media_active",
        "podcast_transcript_versions",
        ["media_id"],
        unique=True,
        postgresql_where=sa.text("is_active"),
    )

    op.add_column("fragments", sa.Column("transcript_version_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_fragments_transcript_version_id",
        "fragments",
        "podcast_transcript_versions",
        ["transcript_version_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "podcast_transcript_segments",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("transcript_version_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("segment_idx", sa.Integer(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=False),
        sa.Column("t_start_ms", sa.BigInteger(), nullable=False),
        sa.Column("t_end_ms", sa.BigInteger(), nullable=False),
        sa.Column("speaker_label", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "segment_idx >= 0",
            name="ck_podcast_transcript_segments_segment_idx_non_negative",
        ),
        sa.CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_podcast_transcript_segments_time_offsets_valid",
        ),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["podcast_transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_version_id",
            "segment_idx",
            name="uq_podcast_transcript_segments_version_idx",
        ),
    )
    op.create_index(
        "ix_podcast_transcript_segments_media_start",
        "podcast_transcript_segments",
        ["media_id", "t_start_ms", "segment_idx"],
    )

    op.create_table(
        "podcast_transcript_chunks",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("transcript_version_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("chunk_idx", sa.Integer(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("t_start_ms", sa.BigInteger(), nullable=False),
        sa.Column("t_end_ms", sa.BigInteger(), nullable=False),
        sa.Column("embedding", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False, server_default="hash_v1"),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "chunk_idx >= 0",
            name="ck_podcast_transcript_chunks_chunk_idx_non_negative",
        ),
        sa.CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_podcast_transcript_chunks_time_offsets_valid",
        ),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["podcast_transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_version_id",
            "chunk_idx",
            name="uq_podcast_transcript_chunks_version_idx",
        ),
    )
    op.create_index(
        "ix_podcast_transcript_chunks_media_start",
        "podcast_transcript_chunks",
        ["media_id", "t_start_ms", "chunk_idx"],
    )

    op.create_table(
        "media_transcript_states",
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("transcript_state", sa.Text(), nullable=False, server_default="not_requested"),
        sa.Column("transcript_coverage", sa.Text(), nullable=False, server_default="none"),
        sa.Column("semantic_status", sa.Text(), nullable=False, server_default="none"),
        sa.Column("active_transcript_version_id", sa.UUID(), nullable=True),
        sa.Column("last_request_reason", sa.Text(), nullable=True),
        sa.Column("last_error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "transcript_state IN ("
            "'not_requested', 'queued', 'running', 'ready', 'partial', "
            "'unavailable', 'failed_quota', 'failed_provider'"
            ")",
            name="ck_media_transcript_states_state",
        ),
        sa.CheckConstraint(
            "transcript_coverage IN ('none', 'partial', 'full')",
            name="ck_media_transcript_states_coverage",
        ),
        sa.CheckConstraint(
            "semantic_status IN ('none', 'pending', 'ready', 'failed')",
            name="ck_media_transcript_states_semantic_status",
        ),
        sa.CheckConstraint(
            "last_request_reason IS NULL OR last_request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue'"
            ")",
            name="ck_media_transcript_states_last_request_reason",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["active_transcript_version_id"],
            ["podcast_transcript_versions.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("media_id"),
    )
    op.create_index(
        "ix_media_transcript_states_semantic_status",
        "media_transcript_states",
        ["semantic_status"],
    )

    op.create_table(
        "highlight_transcript_anchors",
        sa.Column("highlight_id", sa.UUID(), nullable=False),
        sa.Column("transcript_version_id", sa.UUID(), nullable=False),
        sa.Column("transcript_segment_id", sa.UUID(), nullable=True),
        sa.Column("t_start_ms", sa.BigInteger(), nullable=False),
        sa.Column("t_end_ms", sa.BigInteger(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_highlight_transcript_anchors_time_offsets_valid",
        ),
        sa.CheckConstraint(
            "start_offset >= 0 AND end_offset > start_offset",
            name="ck_highlight_transcript_anchors_text_offsets_valid",
        ),
        sa.ForeignKeyConstraint(["highlight_id"], ["highlights.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["podcast_transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["transcript_segment_id"],
            ["podcast_transcript_segments.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("highlight_id"),
    )
    op.create_index(
        "ix_highlight_transcript_anchors_version",
        "highlight_transcript_anchors",
        ["transcript_version_id"],
    )

    op.create_table(
        "podcast_transcript_request_audits",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=True),
        sa.Column("request_reason", sa.Text(), nullable=False),
        sa.Column("dry_run", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("required_minutes", sa.Integer(), nullable=True),
        sa.Column("remaining_minutes", sa.Integer(), nullable=True),
        sa.Column("fits_budget", sa.Boolean(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue'"
            ")",
            name="ck_podcast_transcript_request_audits_reason",
        ),
        sa.CheckConstraint(
            "outcome IN ('forecast', 'queued', 'idempotent', 'rejected_quota', 'enqueue_failed')",
            name="ck_podcast_transcript_request_audits_outcome",
        ),
        sa.CheckConstraint(
            "required_minutes IS NULL OR required_minutes >= 0",
            name="ck_podcast_transcript_request_audits_required_non_negative",
        ),
        sa.CheckConstraint(
            "remaining_minutes IS NULL OR remaining_minutes >= 0",
            name="ck_podcast_transcript_request_audits_remaining_non_negative",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_podcast_transcript_request_audits_media_created",
        "podcast_transcript_request_audits",
        ["media_id", "created_at"],
    )

    op.execute(
        """
        INSERT INTO media_transcript_states (
            media_id,
            transcript_state,
            transcript_coverage,
            semantic_status,
            active_transcript_version_id,
            last_request_reason,
            last_error_code,
            created_at,
            updated_at
        )
        SELECT
            m.id,
            CASE
                WHEN m.processing_status = 'pending' THEN 'not_requested'
                WHEN m.processing_status = 'extracting' THEN 'running'
                WHEN m.processing_status IN ('ready_for_reading', 'embedding', 'ready') THEN 'ready'
                WHEN m.processing_status = 'failed' AND m.last_error_code = 'E_TRANSCRIPT_UNAVAILABLE' THEN 'unavailable'
                WHEN m.processing_status = 'failed' AND m.last_error_code = 'E_PODCAST_QUOTA_EXCEEDED' THEN 'failed_quota'
                WHEN m.processing_status = 'failed' THEN 'failed_provider'
                ELSE 'not_requested'
            END,
            CASE
                WHEN m.processing_status IN ('ready_for_reading', 'embedding', 'ready')
                    THEN CASE
                        WHEN EXISTS(SELECT 1 FROM fragments f WHERE f.media_id = m.id) THEN 'full'
                        ELSE 'none'
                    END
                ELSE 'none'
            END,
            'none',
            NULL,
            (
                SELECT j.request_reason
                FROM podcast_transcription_jobs j
                WHERE j.media_id = m.id
            ),
            m.last_error_code,
            COALESCE(m.created_at, now()),
            COALESCE(m.updated_at, now())
        FROM media m
        WHERE m.kind IN ('podcast_episode', 'video')
        ON CONFLICT (media_id) DO NOTHING
        """
    )

    op.execute(
        """
        WITH media_with_fragments AS (
            SELECT
                m.id AS media_id,
                m.created_by_user_id AS created_by_user_id,
                COALESCE(MIN(f.created_at), now()) AS first_created_at,
                COALESCE(MAX(j.request_reason), 'episode_open') AS request_reason
            FROM media m
            JOIN fragments f ON f.media_id = m.id
            LEFT JOIN podcast_transcription_jobs j ON j.media_id = m.id
            WHERE m.kind IN ('podcast_episode', 'video')
            GROUP BY m.id, m.created_by_user_id
        )
        INSERT INTO podcast_transcript_versions (
            media_id,
            version_no,
            transcript_coverage,
            is_active,
            request_reason,
            created_by_user_id,
            created_at,
            updated_at
        )
        SELECT
            mwf.media_id,
            1,
            'full',
            true,
            mwf.request_reason,
            mwf.created_by_user_id,
            mwf.first_created_at,
            now()
        FROM media_with_fragments mwf
        ON CONFLICT (media_id, version_no) DO NOTHING
        """
    )

    op.execute(
        """
        UPDATE fragments f
        SET transcript_version_id = v.id
        FROM podcast_transcript_versions v
        WHERE v.media_id = f.media_id
          AND v.version_no = 1
          AND f.transcript_version_id IS NULL
        """
    )

    op.execute(
        """
        UPDATE media_transcript_states mts
        SET
            active_transcript_version_id = v.id,
            transcript_state = CASE
                WHEN mts.transcript_state = 'not_requested' THEN 'ready'
                ELSE mts.transcript_state
            END,
            transcript_coverage = CASE
                WHEN mts.transcript_coverage = 'none' THEN 'full'
                ELSE mts.transcript_coverage
            END,
            updated_at = now()
        FROM podcast_transcript_versions v
        WHERE v.media_id = mts.media_id
          AND v.version_no = 1
          AND mts.active_transcript_version_id IS NULL
        """
    )

    op.execute(
        """
        INSERT INTO podcast_transcript_segments (
            transcript_version_id,
            media_id,
            segment_idx,
            canonical_text,
            t_start_ms,
            t_end_ms,
            speaker_label,
            created_at
        )
        SELECT
            f.transcript_version_id,
            f.media_id,
            f.idx,
            f.canonical_text,
            f.t_start_ms,
            f.t_end_ms,
            f.speaker_label,
            COALESCE(f.created_at, now())
        FROM fragments f
        WHERE f.transcript_version_id IS NOT NULL
          AND f.t_start_ms IS NOT NULL
          AND f.t_end_ms IS NOT NULL
          AND f.t_end_ms > f.t_start_ms
        ON CONFLICT (transcript_version_id, segment_idx) DO NOTHING
        """
    )

    op.execute(
        """
        INSERT INTO highlight_transcript_anchors (
            highlight_id,
            transcript_version_id,
            transcript_segment_id,
            t_start_ms,
            t_end_ms,
            start_offset,
            end_offset,
            created_at
        )
        SELECT
            h.id,
            f.transcript_version_id,
            s.id,
            f.t_start_ms,
            f.t_end_ms,
            h.start_offset,
            h.end_offset,
            COALESCE(h.created_at, now())
        FROM highlights h
        JOIN fragments f ON f.id = h.fragment_id
        LEFT JOIN podcast_transcript_segments s
          ON s.transcript_version_id = f.transcript_version_id
         AND s.segment_idx = f.idx
        WHERE f.transcript_version_id IS NOT NULL
          AND f.t_start_ms IS NOT NULL
          AND f.t_end_ms IS NOT NULL
          AND f.t_end_ms > f.t_start_ms
          AND h.start_offset IS NOT NULL
          AND h.end_offset IS NOT NULL
          AND h.end_offset > h.start_offset
        ON CONFLICT (highlight_id) DO NOTHING
        """
    )


def downgrade() -> None:
    # Keep transcript-derived fragments/highlights intact on rollback.
    # Downgrade only removes versioning metadata links.
    op.execute("UPDATE fragments SET transcript_version_id = NULL WHERE transcript_version_id IS NOT NULL")
    # Pre-0009 schema requires fragment bridge offsets to be non-null.
    # Remove post-0009 typed-only highlights so downstream downgrades succeed.
    op.execute(
        """
        DELETE FROM highlights
        WHERE fragment_id IS NULL
           OR start_offset IS NULL
           OR end_offset IS NULL
        """
    )

    op.drop_index("ix_podcast_transcript_request_audits_media_created", table_name="podcast_transcript_request_audits")
    op.drop_table("podcast_transcript_request_audits")

    op.drop_index("ix_highlight_transcript_anchors_version", table_name="highlight_transcript_anchors")
    op.drop_table("highlight_transcript_anchors")

    op.drop_index("ix_media_transcript_states_semantic_status", table_name="media_transcript_states")
    op.drop_table("media_transcript_states")

    op.drop_index("ix_podcast_transcript_chunks_media_start", table_name="podcast_transcript_chunks")
    op.drop_table("podcast_transcript_chunks")

    op.drop_index("ix_podcast_transcript_segments_media_start", table_name="podcast_transcript_segments")
    op.drop_table("podcast_transcript_segments")

    op.drop_constraint("fk_fragments_transcript_version_id", "fragments", type_="foreignkey")
    op.drop_column("fragments", "transcript_version_id")

    op.drop_index("uix_podcast_transcript_versions_media_active", table_name="podcast_transcript_versions")
    op.drop_table("podcast_transcript_versions")
