"""One browser device's durable queue; no audio, progress replica or media retention.

Writes lock viewer then session. Absolute state already present is inert success;
otherwise the captured revision must match. Creation uses the client UUID once,
with no other-device fallback. A terminal retry additionally inspects consumption's
finished/epoch/lectern postcondition, never reapplying it. Present malformed
persisted state is a defect, never absence.
"""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import PlaybackSession
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas import playback_sessions as wire
from nexus.schemas.consumption import NaturalEndIn
from nexus.services.consumption import state as consumption
from nexus.services.consumption import viewer_txn
from nexus.services.playback_snapshot import MAX_ENTRIES, playable_episode_fields


def _conflict() -> ConflictError:
    return ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Playback queue changed")


def _out(row: PlaybackSession) -> wire.BrowserSessionOut:
    return wire.BrowserSessionOut(
        id=row.id, revision=str(row.revision), state=wire.QueueState.model_validate(row.state)
    )


def get_session(db: Session, user_id: UUID, device_id: str) -> wire.BrowserSessionOut | None:
    row = db.scalar(
        select(PlaybackSession).where(
            PlaybackSession.user_id == user_id, PlaybackSession.device_id == device_id
        )
    )
    return _out(row) if row is not None else None


def put_session(
    user_id: UUID, device_id: str, body: wire.PutPlaybackSessionRequest
) -> wire.BrowserSessionOut:
    if len(body.state.entries) > MAX_ENTRIES:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Too many queued episodes")

    def run(db: Session) -> wire.BrowserSessionOut:
        row = db.scalar(
            select(PlaybackSession)
            .where(PlaybackSession.user_id == user_id, PlaybackSession.device_id == device_id)
            .with_for_update()
        )
        if row is None:
            if body.expected_revision is not None or body.terminal is not None:
                raise _conflict()
            created = db.scalar(
                insert(PlaybackSession)
                .values(
                    id=body.id,
                    user_id=user_id,
                    device_id=device_id,
                    revision=1,
                    state=body.state.model_dump(mode="json"),
                )
                .on_conflict_do_nothing()
                .returning(PlaybackSession.id)
            )
            if created is None:
                raise _conflict()
            _validate_entries(db, user_id, None, body.state)
            return wire.BrowserSessionOut(id=body.id, revision="1", state=body.state)
        if row.id != body.id:
            raise _conflict()
        current = _out(row).state
        terminal = body.terminal
        if terminal is not None:
            ended_index = next(
                (
                    index
                    for index, entry in enumerate(body.state.entries)
                    if entry.id == terminal.ended_entry_id
                ),
                None,
            )
            if ended_index is None:
                raise _conflict()
            next_id = (
                body.state.entries[ended_index + 1].id
                if ended_index + 1 < len(body.state.entries)
                else None
            )
            if body.state.current_entry_id != next_id:
                raise _conflict()
            media_id = body.state.entries[ended_index].media_id
            end = NaturalEndIn(
                terminal_listening=terminal.terminal_listening,
                expected_override_revision=terminal.expected_override_revision,
            )
            if current == body.state:
                if not consumption.natural_end_is_settled(db, user_id, media_id, end):
                    raise _conflict()
                return _out(row)
            if (
                str(row.revision) != body.expected_revision
                or current.queue_id != body.state.queue_id
                or current.current_entry_id != terminal.ended_entry_id
                or current.entries != body.state.entries
            ):
                raise _conflict()
            consumption.settle_natural_end_in_txn(db, user_id, media_id, end)
        else:
            if current == body.state:
                return _out(row)
            if str(row.revision) != body.expected_revision:
                raise _conflict()
            _validate_entries(db, user_id, current, body.state)
        row.state = body.state.model_dump(mode="json")
        row.revision += 1
        return _out(row)

    return viewer_txn("put_playback_session", user_id, run)


def _validate_entries(
    db: Session, user_id: UUID, current: wire.QueueState | None, desired: wire.QueueState
) -> None:
    unchanged = (
        {entry.id: entry.media_id for entry in current.entries}
        if current is not None and current.queue_id == desired.queue_id
        else {}
    )
    added: list[UUID] = []
    for entry in desired.entries:
        if entry.id in unchanged:
            if unchanged[entry.id] != entry.media_id:
                raise _conflict()
        else:
            added.append(entry.media_id)
    if set(playable_episode_fields(db, user_id, added)) != set(added):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Episode not found")
