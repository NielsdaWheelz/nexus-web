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
adapters for the two tables, which is why they convert owned `Presence` to
column `NULL` (`docs/rules/boundaries.md`).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.schemas.import_history import (
    PROCESSING_EVENTS_TABLE,
    UPLOAD_EVENTS_TABLE,
    FullHistoryCoverage,
    HistoryCoverage,
    HistoryEntry,
    HistoryOwner,
    HistoryTable,
    IndexFacts,
    PartialHistoryCoverage,
    SafeFailureCode,
    SourceFacts,
    SourceSuperseded,
    Stage,
    UploadFacts,
    UploadHistoryOwner,
    history_event_type,
    history_facts,
    history_payload,
)
from nexus.schemas.presence import Presence, Present, nullable_from_presence, presence_from_nullable

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
    stage: Presence[Stage],
    failure_code: Presence[SafeFailureCode],
) -> UUID:
    """Record one upload-session event. `occurred_at` is the database clock."""
    event_id = new_uuid7()
    db.execute(
        _APPEND_UPLOAD_EVENT,
        {
            "id": event_id,
            "session_id": session_id,
            "event_type": history_event_type(facts),
            "stage": nullable_from_presence(stage),
            "failure_code": nullable_from_presence(failure_code),
            "payload": history_payload(facts),
        },
    )
    return event_id


def append_processing_event(
    db: Session,
    *,
    media_id: UUID,
    facts: SourceFacts | IndexFacts,
    stage: Presence[Stage],
    failure_code: Presence[SafeFailureCode],
) -> UUID:
    """Record one source-ingest or content-index event for a media."""
    event_id = new_uuid7()
    db.execute(
        _APPEND_PROCESSING_EVENT,
        {
            "id": event_id,
            "media_id": media_id,
            "event_type": history_event_type(facts),
            "stage": nullable_from_presence(stage),
            "failure_code": nullable_from_presence(failure_code),
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


def source_supersession_media_id(db: Session, *, source_attempt_id: UUID) -> Presence[UUID]:
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
    return presence_from_nullable(next(iter(owners), None))


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
        if isinstance(owner.media_id, Present):
            sources.append((PROCESSING_EVENTS_TABLE, "media_id = :media_id"))
            params["media_id"] = owner.media_id.value
        return sources, params
    return [(PROCESSING_EVENTS_TABLE, "media_id = :media_id")], {"media_id": owner.media_id}


def events_of_import_sql(*, session_id_expr: str, media_id_expr: str) -> str:
    """Set-wise twin of `_owner_sources` for a query over many imports at once:
    every event whose owner the two SQL expressions name (a NULL expression
    names none), in the column shape `history_entry` decodes."""
    return " UNION ALL ".join(
        f"SELECT '{table}' AS event_table, id, occurred_at, event_type, stage, failure_code,"
        f" payload FROM {table} WHERE {column} = {expr}"
        for table, column, expr in (
            (UPLOAD_EVENTS_TABLE, "session_id", session_id_expr),
            (PROCESSING_EVENTS_TABLE, "media_id", media_id_expr),
        )
    )


def read_history_page(
    db: Session,
    *,
    owner: HistoryOwner,
    before: Presence[tuple[datetime, UUID]],
    limit: int,
) -> list[HistoryEntry]:
    """One page of this import's history, newest first, keyset-paged on
    `(occurred_at, id)`."""
    sources, params = _owner_sources(owner)
    params["limit"] = limit
    keyset = ""
    if isinstance(before, Present):
        occurred_at, event_id = before.value
        params["before_occurred_at"] = occurred_at
        params["before_id"] = event_id
        keyset = " AND (occurred_at, id) < (:before_occurred_at, :before_id)"
    # Table and predicate come from `_owner_sources`, never from a caller value.
    branches = " UNION ALL ".join(
        f"SELECT '{table}' AS source_table, id, occurred_at, event_type, stage, failure_code,"
        f" payload FROM {table} WHERE {predicate}{keyset}"
        for table, predicate in sources
    )
    rows = db.execute(
        text(f"{branches} ORDER BY occurred_at DESC, id DESC LIMIT :limit"), params
    ).all()
    return [
        history_entry(
            table=row.source_table,
            event_id=row.id,
            occurred_at=row.occurred_at,
            event_type=row.event_type,
            stage=row.stage,
            failure_code=row.failure_code,
            payload=row.payload,
        )
        for row in rows
    ]


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
            "id": event_id,
            "occurred_at": occurred_at,
            "stage": presence_from_nullable(stage),
            "failure_code": presence_from_nullable(failure_code),
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
