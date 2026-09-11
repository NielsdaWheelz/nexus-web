"""Install import history storage and baseline every extant import.

Revision ID: 0227
Revises: 0226
Create Date: 2026-09-08
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import Connection

from nexus.ids import new_uuid7
from nexus.schemas.import_history import (
    SAFE_FAILURE_CODES,
    FailedSourceBaselineOutcome,
    InFlightSourceBaselineOutcome,
    SourceBaselineOutcome,
    SourceHistoryBaseline,
    SucceededSourceBaselineOutcome,
    UploadHistoryBaseline,
    assume_safe_failure_code,
    history_payload,
)

revision: str = "0227"
down_revision: str | Sequence[str] | None = "0226"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _assert_every_import_has_a_recordable_baseline(bind: Connection) -> None:
    """Reject, before any DDL, a database whose extant imports cannot be stated
    as history. A rejected preflight leaves the schema at 0226."""
    unrecordable = bind.execute(
        sa.text(
            """
            SELECT id, status, error_code
            FROM media_source_attempts
            WHERE status NOT IN ('accepted', 'queued', 'running', 'succeeded', 'failed')
               OR (status = 'failed' AND error_code IS NULL)
            ORDER BY id
            """
        )
    ).all()
    if unrecordable:
        raise RuntimeError(
            "0227 preflight: source attempts have no recordable baseline outcome: "
            + ", ".join(
                f"{row.id} (status={row.status!r}, error_code={row.error_code!r})"
                for row in unrecordable
            )
        )

    recorded_codes = (
        bind.execute(
            sa.text(
                """
                SELECT verification_error_code AS code
                FROM media_upload_sessions
                WHERE verification_error_code IS NOT NULL
                UNION
                SELECT error_code
                FROM media_source_attempts
                WHERE error_code IS NOT NULL
                ORDER BY code
                """
            )
        )
        .scalars()
        .all()
    )
    uncatalogued = [code for code in recorded_codes if code not in SAFE_FAILURE_CODES]
    if uncatalogued:
        raise RuntimeError(
            "0227 preflight: recorded failure codes are not in the import history catalog: "
            + ", ".join(uncatalogued)
        )


def _create_history_tables() -> None:
    op.create_table(
        "media_upload_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "occurred_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("stage", sa.Text(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["media_upload_sessions.id"],
            name="fk_media_upload_events_session",
        ),
        sa.PrimaryKeyConstraint("id", name="media_upload_events_pkey"),
    )
    op.create_index(
        "ix_media_upload_events_session_occurred_id",
        "media_upload_events",
        ["session_id", "occurred_at", "id"],
    )
    op.create_table(
        "media_processing_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "occurred_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("stage", sa.Text(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            name="fk_media_processing_events_media",
        ),
        sa.PrimaryKeyConstraint("id", name="media_processing_events_pkey"),
    )
    op.create_index(
        "ix_media_processing_events_media_occurred_id",
        "media_processing_events",
        ["media_id", "occurred_at", "id"],
    )


def _record_upload_baselines(bind: Connection) -> None:
    """One `HistoryBaseline` per extant upload session, at recording time."""
    sessions = bind.execute(
        sa.text("SELECT id, upload_generation FROM media_upload_sessions ORDER BY id")
    ).all()
    if not sessions:
        return
    bind.execute(
        sa.text(
            """
            INSERT INTO media_upload_events (id, session_id, occurred_at, event_type, payload)
            VALUES (:id, :session_id, now(), 'HistoryBaseline', CAST(:payload AS jsonb))
            """
        ),
        [
            {
                "id": new_uuid7(),
                "session_id": row.id,
                "payload": json.dumps(
                    history_payload(UploadHistoryBaseline(generation=row.upload_generation))
                ),
            }
            for row in sessions
        ],
    )


def _record_source_attempt_baselines(bind: Connection) -> None:
    """One `HistoryBaseline` per extant source attempt, carrying the attempt's
    identity and its outcome as of recording. Pre-cut failures are never
    re-recorded as dated `Failed` events: baseline time is recording time."""
    attempts = bind.execute(
        sa.text(
            """
            SELECT id, media_id, attempt_no, status, error_code
            FROM media_source_attempts
            ORDER BY id
            """
        )
    ).all()
    if not attempts:
        return
    bind.execute(
        sa.text(
            """
            INSERT INTO media_processing_events (id, media_id, occurred_at, event_type, payload)
            VALUES (:id, :media_id, now(), 'HistoryBaseline', CAST(:payload AS jsonb))
            """
        ),
        [
            {
                "id": new_uuid7(),
                "media_id": row.media_id,
                "payload": json.dumps(
                    history_payload(
                        SourceHistoryBaseline(
                            source_attempt_id=row.id,
                            attempt_no=row.attempt_no,
                            outcome=_baseline_outcome(row.status, row.error_code),
                        )
                    )
                ),
            }
            for row in attempts
        ],
    )


def _baseline_outcome(status: str, error_code: str | None) -> SourceBaselineOutcome:
    """The preflight already rejected any status or code this cannot state."""
    match status:
        case "succeeded":
            return SucceededSourceBaselineOutcome()
        case "failed":
            return FailedSourceBaselineOutcome(
                failure_code=assume_safe_failure_code(str(error_code))
            )
        case "accepted" | "queued" | "running":
            return InFlightSourceBaselineOutcome()
        case _:
            # justify-defect: the preflight admits exactly these five statuses.
            raise AssertionError(f"source attempt baseline cannot state status {status!r}")


def upgrade() -> None:
    bind = op.get_bind()
    _assert_every_import_has_a_recordable_baseline(bind)
    _create_history_tables()
    op.add_column(
        "background_jobs",
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    _record_upload_baselines(bind)
    _record_source_attempt_baselines(bind)


def downgrade() -> None:
    raise NotImplementedError("0227 is an irreversible imports-history hard cutover")
