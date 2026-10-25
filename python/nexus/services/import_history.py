"""Import history: the only writer and reader of `media_upload_events` and
`media_processing_events` (`docs/modules/imports.md`).

Every function runs in the caller's transaction and commits nothing: an owner appends an
event in the transaction that commits the fact it documents, so a committed failure
without its history is impossible. Metadata operations are never stored; the read relation
projects them from their jobs. The two queue hooks translate a job transition into its
history inside that transition and must not raise for a code.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.jobs.queue import JobRow
from nexus.schemas.import_history import (
    FAILURE_KINDS,
    HistoryEntry,
    IndexFacts,
    IndexFailed,
    IndexRetryScheduled,
    MetadataOperationFacts,
    SafeFailureCode,
    SourceFacts,
    SourceFailed,
    SourceRetryScheduled,
    Stage,
    UploadFacts,
    decode_facts,
    queue_failure_code,
)
from nexus.services.source_types import source_failure_progress, source_history_stage
from nexus.services.suggestion_changes import record_input_change


def _append(
    db: Session,
    table: str,
    owner_column: str,
    owner_id: UUID,
    facts: UploadFacts | SourceFacts | IndexFacts,
    stage: Stage | None,
    failure_code: SafeFailureCode | None,
) -> None:
    db.execute(
        text(
            f"INSERT INTO {table} (id, {owner_column}, stage, failure_code, payload)"
            " VALUES (:id, :owner_id, :stage, :failure_code, :payload)"
        ).bindparams(bindparam("payload", type_=JSONB)),
        {
            "id": new_uuid7(),
            "owner_id": owner_id,
            "stage": stage,
            "failure_code": failure_code,
            "payload": facts.model_dump(mode="json"),
        },
    )


def append_upload_event(
    db: Session,
    *,
    session_id: UUID,
    facts: UploadFacts,
    stage: Stage | None,
    failure_code: SafeFailureCode | None,
) -> None:
    """One upload-session event; `occurred_at` is the database clock."""
    _append(db, "media_upload_events", "session_id", session_id, facts, stage, failure_code)


def append_processing_event(
    db: Session,
    *,
    media_id: UUID,
    facts: SourceFacts | IndexFacts,
    stage: Stage | None,
    failure_code: SafeFailureCode | None,
) -> None:
    """One source-ingest or content-index event of a media."""
    _append(db, "media_processing_events", "media_id", media_id, facts, stage, failure_code)


def delete_upload_history_in_current_transaction(db: Session, *, session_id: UUID) -> None:
    """History dies with the session it documents."""
    db.execute(text("DELETE FROM media_upload_events WHERE session_id = :id"), {"id": session_id})


def delete_processing_history_in_current_transaction(db: Session, *, media_id: UUID) -> None:
    """history and frozen discovery catalogues die with the physically collected source."""
    from nexus.services.part_discovery import delete_source_discovery

    delete_source_discovery(db, source_media_id=media_id)
    db.execute(text("DELETE FROM media_processing_events WHERE media_id = :id"), {"id": media_id})


def events_of_import_sql(*, session_id_expr: str, media_id_expr: str) -> str:
    """One import's history as a relation (`event_table, id, storage_id, occurred_at, stage,
    failure_code, payload, is_failure`): its session's events, its media's events and its
    media's metadata operations (time = completion, else creation)."""
    # Metadata is a read projection; the queue hooks below never import its runtime.
    from nexus.services.metadata_operations import metadata_operations_sql

    recorded = " UNION ALL ".join(
        f"SELECT '{prefix}' AS event_table, '{prefix}:' || id::text AS id, id AS storage_id,"
        f" occurred_at, stage, failure_code, payload,"
        f" payload->>'kind' IN {FAILURE_KINDS!r} AS is_failure"
        f" FROM {table} WHERE {column} = {expr}"
        for prefix, table, column, expr in (
            ("upload", "media_upload_events", "session_id", session_id_expr),
            ("processing", "media_processing_events", "media_id", media_id_expr),
        )
    )
    return f"""{recorded} UNION ALL
        SELECT 'metadata', 'metadata:' || job_id::text, job_id, occurred_at, 'Metadata',
            failure_code, NULL::jsonb, effective_status = 'failed'
        FROM ({metadata_operations_sql()}) metadata_history WHERE media_id = {media_id_expr}"""


def history_entries(
    db: Session, *, viewer_id: UUID, rows: Sequence[RowMapping | Mapping[str, Any]]
) -> list[HistoryEntry]:
    """Rows of `events_of_import_sql` as entries, their metadata operations in one batch."""
    from nexus.services.metadata_operations import metadata_operations_for_jobs

    operations = metadata_operations_for_jobs(
        db,
        viewer_id=viewer_id,
        job_ids=[row["storage_id"] for row in rows if row["event_table"] == "metadata"],
    )
    return [
        HistoryEntry(
            id=row["id"],
            occurred_at=row["occurred_at"],
            stage=row["stage"],
            failure_code=row["failure_code"],
            facts=MetadataOperationFacts(operation=operations[row["storage_id"]])
            if row["event_table"] == "metadata"
            else decode_facts(row["payload"]),
        )
        for row in rows
    ]


def read_history_page(
    db: Session,
    *,
    viewer_id: UUID,
    session_id: UUID | None,
    media_id: UUID | None,
    before: tuple[datetime, str] | None,
    limit: int,
) -> list[HistoryEntry]:
    """An import's entries newest first by (`occurred_at`, `id`), strictly before `before`."""
    relation = events_of_import_sql(session_id_expr=":session_id", media_id_expr=":media_id")
    keyset = "" if before is None else "WHERE (occurred_at, id) < (:before_at, :before_id)"
    before_at, before_id = before or (None, None)
    rows = db.execute(
        text(
            f"SELECT * FROM ({relation}) entries {keyset}"
            " ORDER BY occurred_at DESC, id DESC LIMIT :limit"
        ),
        {
            "viewer_id": viewer_id,
            "session_id": session_id,
            "media_id": media_id,
            "before_at": before_at,
            "before_id": before_id,
            "limit": limit,
        },
    ).mappings()
    return history_entries(db, viewer_id=viewer_id, rows=list(rows))


def on_source_job_outcome(db: Session, job: JobRow, execution_id: UUID) -> None:
    """A source job's failure, reclaim or scheduled retry. An attempt its owner already
    settled records nothing; its dead job still invalidates suggestions, after the source's
    own on_dead reaction published the failure."""
    media_id, attempt_id = UUID(job.payload["media_id"]), UUID(job.payload["attempt_id"])
    attempt = (
        db.execute(
            text("""SELECT source_type, processing_stage, progress_completed, progress_total,
                       progress_unit
                FROM media_source_attempts
                WHERE id = :attempt_id AND media_id = :media_id
                  AND status IN ('accepted', 'queued', 'running')"""),
            {"attempt_id": attempt_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if attempt is None:
        if job.status == "dead":
            record_input_change(db, owners=(f"media:{media_id}",))
        return
    failure, terminal, retrying = _queue_outcome(job)
    stage = source_history_stage(
        source_type=attempt["source_type"], processing_stage=attempt["processing_stage"]
    )
    if failure is not None:
        progress = source_failure_progress(
            processing_stage=attempt["processing_stage"],
            progress_completed=attempt["progress_completed"],
            progress_total=attempt["progress_total"],
            progress_unit=attempt["progress_unit"],
        )
        append_processing_event(
            db,
            media_id=media_id,
            facts=SourceFailed(
                source_attempt_id=attempt_id,
                origin="Execution",
                terminal=terminal,
                progress=progress,
            ),
            stage=stage,
            failure_code=failure,
        )
    if retrying:
        append_processing_event(
            db,
            media_id=media_id,
            facts=SourceRetryScheduled(source_attempt_id=attempt_id),
            stage=stage,
            failure_code=None,
        )


def on_index_job_outcome(db: Session, job: JobRow, execution_id: UUID) -> None:
    """A media reindex job's failure, reclaim or scheduled retry; a deleted media records
    nothing."""
    media_id, revision = UUID(job.payload["media_id"]), job.payload["revision"]
    if db.execute(text("SELECT 1 FROM media WHERE id = :id"), {"id": media_id}).first() is None:
        return
    failure, terminal, retrying = _queue_outcome(job)
    if failure is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexFailed(revision=revision, terminal=terminal),
            stage="Index",
            failure_code=failure,
        )
    if retrying:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexRetryScheduled(revision=revision),
            stage="Index",
            failure_code=None,
        )


def _queue_outcome(job: JobRow) -> tuple[SafeFailureCode | None, bool, bool]:
    """(failure, terminal, a retry follows): pending was rescheduled, running reclaimed."""
    failure = None
    if job.status != "pending":
        assert job.error_code  # failing, dead-lettering and reclaiming each set it
        failure = queue_failure_code(job.error_code)
    return failure, job.status == "dead", job.status in ("pending", "failed")
