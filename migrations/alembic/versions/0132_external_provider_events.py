"""external provider event ledger

Revision ID: 0132
Revises: 0131
Create Date: 2026-06-04

External provider failures can happen before a media row exists. This append-only
ledger records the provider, operation, request ID, public target reference, and
safe provider error classification without storing secrets or raw response bodies.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0132"
down_revision: str | Sequence[str] | None = "0131"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE external_provider_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            created_at timestamptz NOT NULL DEFAULT now(),
            request_id text,
            source_attempt_id uuid,
            viewer_id uuid REFERENCES users(id),
            media_id uuid REFERENCES media(id),
            provider text NOT NULL,
            capability text NOT NULL,
            operation text NOT NULL,
            target_ref text,
            status text NOT NULL,
            api_error_code text,
            provider_status_code integer,
            provider_error_type text,
            provider_error_title text,
            duration_ms integer,
            attempt_count integer NOT NULL DEFAULT 1,
            retry_after_seconds integer,
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            CONSTRAINT ck_external_provider_events_status
                CHECK (status IN ('success', 'failure')),
            CONSTRAINT ck_external_provider_events_attempt_count
                CHECK (attempt_count >= 1),
            CONSTRAINT ck_external_provider_events_duration
                CHECK (duration_ms IS NULL OR duration_ms >= 0),
            CONSTRAINT ck_external_provider_events_retry_after
                CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
            CONSTRAINT ck_external_provider_events_metadata
                CHECK (jsonb_typeof(metadata) = 'object')
        )
    """)
    op.create_index(
        "ix_external_provider_events_request_id",
        "external_provider_events",
        ["request_id"],
    )
    op.create_index(
        "ix_external_provider_events_source_attempt_id",
        "external_provider_events",
        ["source_attempt_id"],
    )
    op.create_index(
        "ix_external_provider_events_provider_status_created",
        "external_provider_events",
        ["provider", "status", "created_at"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0132 is not reversible")
