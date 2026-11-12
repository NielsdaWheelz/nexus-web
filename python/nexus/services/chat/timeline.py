"""Bounded turn navigation, terminal-pair deletion and individual message reads."""

from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.chat import TimelineOut
from nexus.services.chat import deletion, events, reads
from nexus.services.collection_keyset import (
    KeysetValueKind,
    SortKey,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.generation.ledger import lock_generation_owner
from nexus.services.media_read_map import READ_DOCUMENT_MAX_CHARS
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change


def window(
    db: Session,
    *,
    viewer_id: UUID,
    before_seq: str | None,
    after_seq: str | None,
    around_message_id: UUID | None,
    limit: int,
) -> TimelineOut:
    if sum(value is not None for value in (before_seq, after_seq, around_message_id)) > 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Choose one timeline cursor")
    query = (
        select(ChatRun)
        .join(Message, Message.id == ChatRun.user_message_id)
        .where(ChatRun.owner_user_id == viewer_id)
    )
    if around_message_id is not None:
        anchor = db.scalar(
            select(Message.seq).where(
                Message.id == around_message_id, Message.owner_user_id == viewer_id
            )
        )
        if anchor is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        query = query.order_by(text("abs(messages.seq - :anchor)"), Message.seq).params(
            anchor=anchor
        )
    elif after_seq is not None:
        query = query.where(Message.seq > int(after_seq)).order_by(Message.seq)
    else:
        if before_seq is not None:
            query = query.where(Message.seq < int(before_seq))
        query = query.order_by(Message.seq.desc())
    runs = list(db.scalars(query.limit(limit)))
    items = sorted(reads.turns(db, viewer_id, runs), key=lambda item: int(item.user_message.seq))
    before = after = None
    if items:
        first, last = items[0].user_message.seq, items[-1].user_message.seq
        if db.scalar(
            select(Message.id)
            .where(
                Message.owner_user_id == viewer_id, Message.role == "user", Message.seq < int(first)
            )
            .limit(1)
        ):
            before = first
        if db.scalar(
            select(Message.id)
            .where(
                Message.owner_user_id == viewer_id, Message.role == "user", Message.seq > int(last)
            )
            .limit(1)
        ):
            after = last
    return TimelineOut(items=items, before_seq=before, after_seq=after)


def delete_turn(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    """A terminal pair is one removal; later retries and completed effects survive."""

    def attempt() -> None:
        lock_generation_owner(db, kind="chat_run", id=run_id)
        run = events.lock_run(db, run_id)
        if run is None or run.owner_user_id != viewer_id:
            return
        if run.status not in events.TERMINAL:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "Cancel this turn and wait for it to settle before deleting it",
            )
        ids = [run.user_message_id, run.assistant_message_id]
        cleanup.delete_edges_for_deleted_resources(
            db, refs=[ResourceRef("message", identity) for identity in ids]
        )
        db.execute(
            text("UPDATE tool_calls SET assistant_message_id=NULL WHERE assistant_message_id=:id"),
            {"id": run.assistant_message_id},
        )
        db.execute(
            text("DELETE FROM message_retrievals WHERE assistant_message_id=:id"),
            {"id": run.assistant_message_id},
        )
        db.execute(text("DELETE FROM chat_run_events WHERE run_id=:id"), {"id": run.id})
        db.execute(
            text("DELETE FROM background_jobs WHERE kind='chat_run' AND dedupe_key=:key"),
            {"key": f"chat_run:{run.id}"},
        )
        db.execute(text("DELETE FROM chat_runs WHERE id=:id"), {"id": run.id})
        db.execute(text("DELETE FROM messages WHERE id=ANY(:ids)"), {"ids": ids})
        projection.refresh(db, "message", ids)
        record_input_change(db, owners=[f"message:{run.user_message_id}"])
        deletion.advance(db, viewer_id)

    retry_serializable(db, "delete_librarian_turn", attempt)


@dataclass(frozen=True, slots=True)
class MessageActionFacts:
    run_id: UUID
    can_retry: bool
    can_delete: bool


def message_action_facts(
    db: Session, *, viewer_id: UUID, message_ids: list[UUID]
) -> dict[UUID, MessageActionFacts]:
    runs = db.scalars(
        select(ChatRun).where(
            ChatRun.owner_user_id == viewer_id,
            (
                ChatRun.user_message_id.in_(message_ids)
                | ChatRun.assistant_message_id.in_(message_ids)
            ),
        )
    )
    result = {}
    for run in runs:
        for identity in (run.user_message_id, run.assistant_message_id):
            if identity in message_ids:
                result[identity] = MessageActionFacts(
                    run.id, reads.can_retry(run), run.status in events.TERMINAL
                )
    return result


@dataclass(frozen=True, slots=True)
class MessageReadPage:
    body: str
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class MessageReadRefusal:
    code: Literal["missing", "invalid_cursor"]


_MESSAGE_CURSOR = (SortKey("offset", "asc", KeysetValueKind.Int),)


def read_message_page(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    cursor: str | None,
) -> MessageReadPage | MessageReadRefusal:
    """Read one owned settled message; foreground tools enforce their run horizon first."""
    message = db.scalar(
        select(Message).where(
            Message.id == ref.id, Message.owner_user_id == viewer_id, Message.status != "pending"
        )
    )
    if message is None or ref.scheme != "message":
        return MessageReadRefusal("missing")
    binding = {
        "list": "LibrarianMessage",
        "viewer": viewer_id,
        "uri": ref.uri,
        "updated_at": message.updated_at.isoformat(),
    }
    offset = 0
    if cursor is not None:
        try:
            values = decode_keyset_cursor(cursor, binding, _MESSAGE_CURSOR)
        except InvalidRequestError:
            return MessageReadRefusal("invalid_cursor")
        offset = cast(int, values[0])
        if offset < 0 or offset >= len(message.content):
            return MessageReadRefusal("invalid_cursor")
    header = f"message:{message.id} role={message.role} status={message.status}\n"
    end = min(len(message.content), offset + READ_DOCUMENT_MAX_CHARS - len(header))
    continuation = (
        encode_keyset_cursor(binding, _MESSAGE_CURSOR, {"offset": end})
        if end < len(message.content)
        else None
    )
    return MessageReadPage(header + message.content[offset:end], continuation)


def message_visible(db: Session, viewer_id: UUID, message_id: UUID, horizon_seq: int) -> bool:
    """Current question or an earlier terminal pair, never a later queued request."""
    return bool(
        db.scalar(
            text("""SELECT EXISTS (
        SELECT 1 FROM messages m JOIN chat_runs r ON m.id IN (r.user_message_id,r.assistant_message_id)
        WHERE m.id=:id AND m.owner_user_id=:viewer AND
            ((m.seq=:horizon AND m.role='user') OR (m.seq<:horizon AND r.status IN ('complete','error','cancelled'))))"""),
            {"id": message_id, "viewer": viewer_id, "horizon": horizon_seq},
        )
    )
