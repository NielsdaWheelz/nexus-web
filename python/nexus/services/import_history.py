"""Transaction-scoped recording and reading of import history.

The only writer and the only reader of `media_upload_events` and
`media_processing_events`. Every function here runs inside a caller-owned
transaction and commits nothing: an owner appends the event in the same
transaction that commits the fact it documents, so a committed failure without
its history is impossible.

Source-supersession facts retain their immutable payload, id and time, while
their owning media follows canonical dedupe so loser teardown cannot erase
the accepted source identity's resolution.

No policy, no scheduling, no domain decisions — these are the final insert
adapters for the two tables. The two queue hooks at the end
translate a job's transition into its history, inside that transition.
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
    PROCESSING_EVENTS_TABLE,
    UPLOAD_EVENTS_TABLE,
    FullHistoryCoverage,
    HistoryCoverage,
    HistoryEntry,
    HistoryOwner,
    HistoryTable,
    IndexFacts,
    IndexFailed,
    IndexRetryScheduled,
    MetadataOperationFacts,
    PartialHistoryCoverage,
    SafeFailureCode,
    SourceFacts,
    SourceFailed,
    SourceRetryScheduled,
    SourceSuperseded,
    Stage,
    UploadFacts,
    UploadHistoryOwner,
    history_event_type,
    history_facts,
    history_payload,
    queue_failure_code,
)
from nexus.services.source_history import source_failure_progress, source_history_stage

_APPEND_UPLOAD_EVENT = text(
    """
    INSERT INTO media_upload_events (id, session_id, event_type, stage, failure_code, payload)
    VALUES (:id, :session_id, :event_type, :stage, :failure_code, :payload)
    """
).bindparams(bindparam("payload", type_=JSONB))

_APPEND_PROCESSING_EVENT = text(
    """
    INSERT INTO media_processing_events (id, media_id, event_type, stage, failure_code, payload)
    VALUES (:id, :media_id, :event_type, :stage, :failure_code, :payload)
    """
).bindparams(bindparam("payload", type_=JSONB))


def append_upload_event(
    db: Session,
    *,
    session_id: UUID,
    facts: UploadFacts,
    stage: Stage | None,
    failure_code: SafeFailureCode | None,
) -> UUID:
    """Record one upload-session event. `occurred_at` is the database clock."""
    event_id = new_uuid7()
    db.execute(
        _APPEND_UPLOAD_EVENT,
        {
            "id": event_id,
            "session_id": session_id,
            "event_type": history_event_type(facts),
            "stage": stage,
            "failure_code": failure_code,
            "payload": history_payload(facts),
        },
    )
    return event_id


def append_processing_event(
    db: Session,
    *,
    media_id: UUID,
    facts: SourceFacts | IndexFacts,
    stage: Stage | None,
    failure_code: SafeFailureCode | None,
) -> UUID:
    """Record one source-ingest or content-index event for a media."""
    event_id = new_uuid7()
    db.execute(
        _APPEND_PROCESSING_EVENT,
        {
            "id": event_id,
            "media_id": media_id,
            "event_type": history_event_type(facts),
            "stage": stage,
            "failure_code": failure_code,
            "payload": history_payload(facts),
        },
    )
    return event_id


def delete_upload_history_in_current_transaction(db: Session, *, session_id: UUID) -> None:
    """Explicit teardown: history dies with the session row it documents."""
    db.execute(
        text("DELETE FROM media_upload_events WHERE session_id = :session_id"),
        {"session_id": session_id},
    )


def delete_processing_history_in_current_transaction(db: Session, *, media_id: UUID) -> None:
    """Explicit teardown: history dies with the media row it documents."""
    db.execute(
        text("DELETE FROM media_processing_events WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def rehome_source_supersessions(
    db: Session, *, loser_media_id: UUID, winner_media_id: UUID
) -> None:
    """Keep accepted source identities reachable through canonical dedupe chains.

    The payload keeps the historical winner; the event's owning media is the
    current winner and retains the event when the duplicate is torn down.
    """
    db.execute(
        text(
            "UPDATE media_processing_events SET media_id = :winner_media_id "
            "WHERE media_id = :loser_media_id AND event_type = 'Superseded' "
            "AND payload ? 'source_attempt_id'"
        ),
        {"loser_media_id": loser_media_id, "winner_media_id": winner_media_id},
    )


def source_supersession_media_id(db: Session, *, source_attempt_id: UUID) -> UUID | None:
    """Resolve a superseded acceptance independently of its retired attempt/job.

    Repeated executions may record the same supersession. Distinct surviving
    owners for one accepted attempt are a defect, never a latest-event choice.
    """
    rows = db.execute(
        text(
            "SELECT media_id, event_type, payload FROM media_processing_events "
            "WHERE event_type = 'Superseded' "
            "AND payload ->> 'source_attempt_id' = :source_attempt_id FOR SHARE"
        ),
        {"source_attempt_id": str(source_attempt_id)},
    ).all()
    owners: set[UUID] = set()
    for row in rows:
        facts = history_facts(
            table=PROCESSING_EVENTS_TABLE, event_type=row.event_type, payload=row.payload
        )
        if not isinstance(facts, SourceSuperseded) or facts.source_attempt_id != source_attempt_id:
            raise AssertionError("source supersession history identity is malformed")
        owners.add(row.media_id)
    if len(owners) > 1:
        raise AssertionError("accepted source attempt has multiple canonical media owners")
    return next(iter(owners), None)


def _owner_sources(owner: HistoryOwner) -> tuple[list[tuple[HistoryTable, str]], dict[str, object]]:
    """Every table holding this owner's history, with its owner predicate.

    An upload-origin import keeps its session history after publication and
    gains the published media's processing history, so both tables answer for it.
    """
    if isinstance(owner, UploadHistoryOwner):
        sources: list[tuple[HistoryTable, str]] = [
            (UPLOAD_EVENTS_TABLE, "session_id = :session_id")
        ]
        params: dict[str, object] = {"session_id": owner.session_id}
        if owner.media_id is not None:
            sources.append((PROCESSING_EVENTS_TABLE, "media_id = :media_id"))
            params["media_id"] = owner.media_id
        return sources, params
    return [(PROCESSING_EVENTS_TABLE, "media_id = :media_id")], {"media_id": owner.media_id}


def events_of_import_sql(*, session_id_expr: str, media_id_expr: str) -> str:
    """Composed read relation; metadata operations never enter the event writer."""
    # Metadata is a read projection; worker history hooks do not import its runtime.
    from nexus.services.metadata_operations import metadata_operations_sql

    recorded = " UNION ALL ".join(
        f"SELECT '{table}' AS event_table, '{prefix}:' || id::text AS id, id AS storage_id,"
        f" occurred_at, event_type, stage, failure_code, payload,"
        f" event_type = 'Failed' AS is_failure FROM {table} WHERE {column} = {expr}"
        for table, prefix, column, expr in (
            (UPLOAD_EVENTS_TABLE, "upload", "session_id", session_id_expr),
            (PROCESSING_EVENTS_TABLE, "processing", "media_id", media_id_expr),
        )
    )
    return (
        recorded
        + f""" UNION ALL
        SELECT 'metadata' AS event_table, 'metadata:' || job_id::text AS id,
            job_id AS storage_id, occurred_at, NULL::text AS event_type,
            'Metadata' AS stage, failure_code, NULL::jsonb AS payload,
            effective_status = 'failed' AS is_failure
        FROM ({metadata_operations_sql()}) metadata_history
        WHERE media_id = {media_id_expr}
    """
    )


def history_entries(
    db: Session, *, viewer_id: UUID, rows: Sequence[RowMapping | Mapping[str, Any]]
) -> list[HistoryEntry]:
    """Hydrate a page or matched rows with one metadata-owner batch."""
    from nexus.services.metadata_operations import metadata_operations_for_jobs

    operations = metadata_operations_for_jobs(
        db,
        viewer_id=viewer_id,
        job_ids=[row["storage_id"] for row in rows if row["event_table"] == "metadata"],
    )
    entries: list[HistoryEntry] = []
    for row in rows:
        if row["event_table"] == "metadata":
            entries.append(
                HistoryEntry(
                    id=row["id"],
                    occurred_at=row["occurred_at"],
                    stage="Metadata",
                    failure_code=row["failure_code"],
                    facts=MetadataOperationFacts(operation=operations[row["storage_id"]]),
                )
            )
        else:
            entries.append(
                history_entry(
                    table=row["event_table"],
                    event_id=row["storage_id"],
                    occurred_at=row["occurred_at"],
                    event_type=row["event_type"],
                    stage=row["stage"],
                    failure_code=row["failure_code"],
                    payload=row["payload"],
                )
            )
    return entries


def read_history_page(
    db: Session,
    *,
    viewer_id: UUID,
    owner: HistoryOwner,
    before: tuple[datetime, str] | None,
    limit: int,
) -> list[HistoryEntry]:
    """Recorded events and retained operations, keyset-paged by time and text id."""
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit}
    if isinstance(owner, UploadHistoryOwner):
        params["session_id"] = owner.session_id
        params["media_id"] = owner.media_id
    else:
        params["session_id"] = None
        params["media_id"] = owner.media_id
    keyset = ""
    if before is not None:
        params["before_occurred_at"], params["before_id"] = before
        keyset = "WHERE (occurred_at, id) < (:before_occurred_at, :before_id)"
    relation = events_of_import_sql(session_id_expr=":session_id", media_id_expr=":media_id")
    rows = (
        db.execute(
            text(
                f"SELECT * FROM ({relation}) entries {keyset} "
                "ORDER BY occurred_at DESC, id DESC LIMIT :limit"
            ),
            params,
        )
        .mappings()
        .all()
    )
    return history_entries(db, viewer_id=viewer_id, rows=rows)


def history_entry(
    *,
    table: HistoryTable,
    event_id: UUID,
    occurred_at: datetime,
    event_type: str,
    stage: str | None,
    failure_code: str | None,
    payload: Mapping[str, object],
) -> HistoryEntry:
    """Decode one stored event row (this module's page reads and the Imports
    query's correlated match both read the same columns)."""
    return HistoryEntry.model_validate(
        {
            "id": f"{'upload' if table == UPLOAD_EVENTS_TABLE else 'processing'}:{event_id}",
            "occurred_at": occurred_at,
            "stage": stage,
            "failure_code": failure_code,
            "facts": history_facts(table=table, event_type=event_type, payload=payload),
        }
    )


def history_coverage(db: Session, *, owner: HistoryOwner) -> HistoryCoverage:
    """`Partial` from the earliest baseline this import carries, else `Full`."""
    sources, params = _owner_sources(owner)
    branches = " UNION ALL ".join(
        f"SELECT occurred_at FROM {table} WHERE {predicate} AND event_type = 'HistoryBaseline'"
        for table, predicate in sources
    )
    recorded_since = db.execute(
        text(f"SELECT min(occurred_at) FROM ({branches}) baselines"), params
    ).scalar_one()
    if recorded_since is None:
        return FullHistoryCoverage()
    return PartialHistoryCoverage(recorded_since=recorded_since)


def on_source_job_outcome(db: Session, job: JobRow, execution_id: UUID) -> None:
    """Source ingest's queue history: a failed or reclaimed attempt, a scheduled retry.

    An attempt its owner already settled (succeeded, or failed with its own history)
    records nothing more.
    """
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
        return
    failure, terminal, next_at = _queue_outcome(job)
    stage: Stage | None = source_history_stage(
        source_type=attempt["source_type"], processing_stage=attempt["processing_stage"]
    )
    if failure is not None:
        progress = source_failure_progress(
            processing_stage=attempt["processing_stage"],
            progress_completed=attempt["progress_completed"],
            progress_total=attempt["progress_total"],
            progress_unit=attempt["progress_unit"],
        )
        facts = SourceFailed(
            source_attempt_id=attempt_id,
            execution_id=execution_id,
            origin="Execution",
            terminal=terminal,
            progress=progress,
        )
        append_processing_event(
            db, media_id=media_id, facts=facts, stage=stage, failure_code=failure
        )
    if next_at is not None:
        retry = SourceRetryScheduled(
            source_attempt_id=attempt_id,
            execution_id=execution_id,
            next_attempt_at=next_at,
        )
        append_processing_event(db, media_id=media_id, facts=retry, stage=stage, failure_code=None)


def on_index_job_outcome(db: Session, job: JobRow, execution_id: UUID) -> None:
    """A media reindex job's queue history; a deleted media records nothing."""
    media_id, revision = UUID(job.payload["media_id"]), job.payload["revision"]
    if db.execute(text("SELECT 1 FROM media WHERE id = :id"), {"id": media_id}).first() is None:
        return
    failure, terminal, next_at = _queue_outcome(job)
    execution = {"revision": revision, "job_id": job.id, "execution_id": execution_id}
    stage: Stage | None = "Index"
    if failure is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexFailed(**execution, origin="Execution", terminal=terminal),
            stage=stage,
            failure_code=failure,
        )
    if next_at is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexRetryScheduled(**execution, next_attempt_at=next_at),
            stage=stage,
            failure_code=None,
        )


def _queue_outcome(job: JobRow) -> tuple[SafeFailureCode | None, bool, datetime | None]:
    """What a transition says: pending was rescheduled, running was reclaimed."""
    failure = None
    if job.status != "pending":
        assert job.error_code  # failing, dead-lettering and reclaiming each set it
        failure = queue_failure_code(job.error_code)
    next_at = job.available_at if job.status in ("pending", "failed") else None
    return failure, job.status == "dead", next_at
