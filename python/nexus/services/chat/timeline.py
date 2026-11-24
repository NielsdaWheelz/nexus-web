"""Paired turn order, bounded rich reads and terminal-pair deletion."""

from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.chat import ChatRunResponse, TimelineOut, TimelineTurnOut
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


def index(db: Session, *, viewer_id: UUID, around_message_id: UUID | None) -> TimelineOut:
    order = [
        TimelineTurnOut(
            run_id=run_id,
            user_message_id=user_id,
            assistant_message_id=assistant_id,
            user_seq=str(seq),
            created_at=created_at,
        )
        for run_id, user_id, assistant_id, seq, created_at in db.execute(
            select(
                ChatRun.id,
                ChatRun.user_message_id,
                ChatRun.assistant_message_id,
                Message.seq,
                Message.created_at,
            )
            .join(Message, Message.id == ChatRun.user_message_id)
            .where(ChatRun.owner_user_id == viewer_id, Message.owner_user_id == viewer_id)
            .order_by(Message.seq)
        ).tuples()
    ]
    last_start = max(0, len(order) - 25)
    start = last_start
    if around_message_id is not None:
        anchor = next(
            (
                rank
                for rank, turn in enumerate(order)
                if around_message_id in (turn.user_message_id, turn.assistant_message_id)
            ),
            None,
        )
        if anchor is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        start = max(0, min(last_start, anchor - 12))
    items = resolve(
        db, viewer_id=viewer_id, run_ids=[turn.run_id for turn in order[start : start + 25]]
    )
    return TimelineOut(order=order, items=items)


def resolve(db: Session, *, viewer_id: UUID, run_ids: list[UUID]) -> list[ChatRunResponse]:
    if not run_ids:
        return []
    runs = {
        run.id: run
        for run in db.scalars(
            select(ChatRun).where(ChatRun.owner_user_id == viewer_id, ChatRun.id.in_(run_ids))
        )
    }
    return reads.turns(db, viewer_id, [runs[run_id] for run_id in run_ids if run_id in runs])


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
