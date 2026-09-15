"""Create durable upload intent and nullable immutable-source digest storage.

Revision ID: 0220
Revises: 0219
Create Date: 2026-08-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0220"
down_revision: str | Sequence[str] | None = "0219"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_upload_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_media_upload_sessions_created_by_user"),
            nullable=False,
        ),
        sa.Column(
            "candidate_media_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("expected_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("upload_generation", sa.BigInteger(), nullable=False),
        sa.Column("upload_url_expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("verification_token", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("verification_generation", sa.BigInteger(), nullable=True),
        sa.Column("verification_expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("transport_failure_kind", sa.Text(), nullable=True),
        sa.Column("transport_http_status", sa.Integer(), nullable=True),
        sa.Column("transport_failed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("verification_error_code", sa.Text(), nullable=True),
        sa.Column("verification_failed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "published_media_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("media.id", name="fk_media_upload_sessions_published_media"),
            nullable=True,
        ),
        sa.Column(
            "published_source_attempt_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "media_source_attempts.id",
                name="fk_media_upload_sessions_published_source_attempt",
            ),
            nullable=True,
        ),
        sa.Column("published_at", sa.TIMESTAMP(timezone=True), nullable=True),
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
        sa.UniqueConstraint(
            "created_by_user_id",
            "idempotency_key",
            name="uq_media_upload_sessions_viewer_idempotency",
        ),
        sa.UniqueConstraint(
            "candidate_media_id",
            name="uq_media_upload_sessions_candidate_media",
        ),
        sa.UniqueConstraint(
            "published_media_id",
            name="uq_media_upload_sessions_published_media",
        ),
        sa.UniqueConstraint(
            "published_source_attempt_id",
            name="uq_media_upload_sessions_published_source_attempt",
        ),
    )
    op.create_table(
        "media_upload_session_destinations",
        sa.Column(
            "upload_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "media_upload_sessions.id",
                name="fk_media_upload_session_destinations_session",
            ),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "library_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "libraries.id",
                name="fk_media_upload_session_destinations_library",
            ),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.add_column("media_file", sa.Column("source_sha256", sa.Text(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError("0220 is an irreversible document-import hard cutover")
