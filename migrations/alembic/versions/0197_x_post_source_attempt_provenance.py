"""repair X-post source-attempt provenance

Revision ID: 0197
Revises: 0196
Create Date: 2026-07-27
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0197"
down_revision: str | Sequence[str] | None = "0196"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO media_source_attempts (
            media_id,
            created_by_user_id,
            source_type,
            attempt_no,
            run_count,
            status,
            intent_key,
            requested_url,
            canonical_source_url,
            provider,
            provider_target_ref,
            source_payload,
            started_at,
            finished_at,
            created_at,
            updated_at
        )
        SELECT
            m.id,
            m.created_by_user_id,
            'x_post',
            COALESCE((
                SELECT max(existing.attempt_no)
                FROM media_source_attempts AS existing
                WHERE existing.media_id = m.id
            ), 0) + 1,
            1,
            'succeeded',
            concat(
                '{"source_type":"x_post","target_ref":',
                to_jsonb(substring(m.provider_id FROM 6))::text,
                ',"url":',
                to_jsonb(COALESCE(
                    m.canonical_source_url,
                    m.canonical_url,
                    m.requested_url,
                    'https://x.com/i/status/' || substring(m.provider_id FROM 6)
                ))::text,
                '}'
            ),
            COALESCE(
                m.requested_url,
                m.canonical_source_url,
                m.canonical_url,
                'https://x.com/i/status/' || substring(m.provider_id FROM 6)
            ),
            COALESCE(
                m.canonical_source_url,
                m.canonical_url,
                m.requested_url,
                'https://x.com/i/status/' || substring(m.provider_id FROM 6)
            ),
            'x',
            substring(m.provider_id FROM 6),
            jsonb_build_object('post_id', substring(m.provider_id FROM 6)),
            COALESCE(m.processing_completed_at, m.updated_at, m.created_at, now()),
            COALESCE(m.processing_completed_at, m.updated_at, m.created_at, now()),
            m.created_at,
            now()
        FROM media AS m
        WHERE m.provider = 'x'
          AND m.provider_id ~ '^post:[0-9]+$'
          AND m.processing_status = 'ready_for_reading'
          AND NOT EXISTS (
              SELECT 1
              FROM media_source_attempts AS msa
              WHERE msa.media_id = m.id
                AND msa.source_type = 'x_post'
                AND msa.status = 'succeeded'
                AND msa.provider = 'x'
                AND msa.provider_target_ref = substring(m.provider_id FROM 6)
          )
    """)
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM media AS m
                WHERE m.provider = 'x'
                  AND m.provider_id ~ '^post:[0-9]+$'
                  AND m.processing_status = 'ready_for_reading'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM media_source_attempts AS msa
                      WHERE msa.media_id = m.id
                        AND msa.source_type = 'x_post'
                        AND msa.status = 'succeeded'
                        AND msa.provider = 'x'
                        AND msa.provider_target_ref = substring(m.provider_id FROM 6)
                  )
            ) THEN
                RAISE EXCEPTION
                    'ready X-post media remains without succeeded x_post source-attempt provenance';
            END IF;
        END
        $$;
    """)


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0197 is not reversible")
