"""Conversation references: pointer rows from a conversation to a resource URI.

One table, one URI per row, dispatched by scheme. This service mirrors the
shape of :mod:`nexus.services.pinned_sources` (its predecessor) and uses the
resolver layer in :mod:`nexus.services.resource_resolver` to hydrate rows
with label/summary/inline_body for API and prompt-assembly consumers.

Owner-only access for list/add/remove. ``insert_reference_if_absent`` is the
citation-pipeline write-through; it does the SELECT-then-INSERT step without
owner checks (caller is the chat-run, which has already authorized the
conversation upstream).
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ConversationReference
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.schemas.conversation import ConversationOut, PageInfo
from nexus.services.resource_resolver import ResolvedResource, resolve, resolve_batch

# Pagination defaults mirror `nexus.services.conversations`. Kept local because
# importing that module during the cutover would pull in references to types
# the migration has already dropped.
_DEFAULT_LIMIT = 50
_MIN_LIMIT = 1
_MAX_LIMIT = 100

# Allowed URI grammar: <scheme>:<UUID>. Scheme list mirrors the resolver's
# dispatch table; UUID format is the canonical 8-4-4-4-12 lowercase hex form.
_URI_PATTERN = re.compile(
    r"^(media|library|span|chunk|highlight|page|note_block|fragment|conversation|message)"
    r":[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


@dataclass(frozen=True)
class ResolvedResourceWithId:
    """A resolved resource plus its conversation_references row metadata."""

    id: UUID
    conversation_id: UUID
    resource_uri: str
    label: str
    summary: str
    inline_body: str | None
    fetch_hint: str
    missing: bool
    created_at: datetime


def _decode_cursor_clause(cursor: str | None) -> tuple[str, dict[str, object]]:
    """Decode a conversation cursor into a SQL fragment + bound params."""
    if not cursor:
        return "", {}
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(cursor).decode("utf-8"))
        updated_at = datetime.fromisoformat(payload["updated_at"])
        conversation_id = UUID(payload["id"])
    except (ValueError, KeyError, TypeError):
        # justify-ignore-error: expected malformed-cursor failures from the
        # base64url/JSON decode and primitive parsing path. Other exceptions
        # propagate.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None
    return (
        "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)",
        {"cursor_updated_at": updated_at, "cursor_id": conversation_id},
    )


def _encode_cursor(updated_at: datetime, conversation_id: UUID) -> str:
    payload = json.dumps({"updated_at": updated_at.isoformat(), "id": str(conversation_id)})
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def _require_owner(db: Session, viewer_id: UUID, conversation_id: UUID) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Owner required")
    return conversation


def _validate_uri(resource_uri: str) -> None:
    if not _URI_PATTERN.match(resource_uri):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource_uri: {resource_uri!r}. Expected '<scheme>:<UUID>' "
            "where scheme is one of media, library, span, chunk, highlight, page, "
            "note_block, fragment, conversation, message.",
        )


def _combine(row: ConversationReference, resolved: ResolvedResource) -> ResolvedResourceWithId:
    return ResolvedResourceWithId(
        id=row.id,
        conversation_id=row.conversation_id,
        resource_uri=resolved.uri,
        label=resolved.label,
        summary=resolved.summary,
        inline_body=resolved.inline_body,
        fetch_hint=resolved.fetch_hint,
        missing=resolved.missing,
        created_at=row.created_at,
    )


def reference_to_api_payload(row: ResolvedResourceWithId) -> dict[str, object]:
    """Serialize a resolved reference for the REST API contract."""
    return {
        "id": str(row.id),
        "conversation_id": str(row.conversation_id),
        "resource_uri": row.resource_uri,
        "label": row.label,
        "summary": row.summary,
        "inline_body": row.inline_body,
        "fetch_hint": row.fetch_hint,
        "missing": row.missing,
        "created_at": row.created_at.isoformat(),
    }


def reference_to_event_payload(row: ResolvedResourceWithId) -> dict[str, object]:
    """Serialize a newly added reference for chat-run SSE."""
    payload = reference_to_api_payload(row)
    payload["reference_id"] = payload.pop("id")
    return payload


def resolve_reference_row(
    db: Session,
    row: ConversationReference,
    *,
    viewer_id: UUID,
) -> ResolvedResourceWithId:
    """Hydrate one existing ``conversation_references`` row."""
    resolved = resolve(db, row.resource_uri, viewer_id=viewer_id)
    return _combine(row, resolved)


def _select_reference(
    db: Session,
    *,
    conversation_id: UUID,
    resource_uri: str,
) -> ConversationReference | None:
    return db.execute(
        select(ConversationReference).where(
            ConversationReference.conversation_id == conversation_id,
            ConversationReference.resource_uri == resource_uri,
        )
    ).scalar_one_or_none()


def _insert_reference_if_missing(
    db: Session,
    *,
    conversation_id: UUID,
    resource_uri: str,
) -> tuple[ConversationReference, bool]:
    existing = _select_reference(
        db,
        conversation_id=conversation_id,
        resource_uri=resource_uri,
    )
    if existing is not None:
        return existing, False

    try:
        with db.begin_nested():
            row_id = db.scalar(
                text(
                    """
                    INSERT INTO conversation_references (conversation_id, resource_uri)
                    VALUES (:conversation_id, :resource_uri)
                    RETURNING id
                    """
                ),
                {"conversation_id": conversation_id, "resource_uri": resource_uri},
            )
    except IntegrityError:
        existing = _select_reference(
            db,
            conversation_id=conversation_id,
            resource_uri=resource_uri,
        )
        if existing is not None:
            return existing, False
        raise
    assert row_id is not None
    row = db.get(ConversationReference, row_id)
    if row is None:
        raise RuntimeError("Inserted conversation reference could not be reloaded")
    return row, True


def list_references(
    db: Session, conversation_id: UUID, *, viewer_id: UUID
) -> list[ResolvedResourceWithId]:
    _require_owner(db, viewer_id, conversation_id)
    rows = (
        db.execute(
            select(ConversationReference)
            .where(ConversationReference.conversation_id == conversation_id)
            .order_by(ConversationReference.created_at.asc())
        )
        .scalars()
        .all()
    )
    resolved = resolve_batch(db, [r.resource_uri for r in rows], viewer_id=viewer_id)
    return [_combine(row, res) for row, res in zip(rows, resolved, strict=True)]


def add_reference(
    db: Session, conversation_id: UUID, resource_uri: str, *, viewer_id: UUID
) -> ResolvedResourceWithId:
    """Add a reference to a conversation. Caller commits the transaction.

    Letting the caller commit keeps the route layer free to batch reference
    adds with a conversation create (or with other reference adds) in a single
    atomic transaction.
    """
    _require_owner(db, viewer_id, conversation_id)
    _validate_uri(resource_uri)

    # Verify the underlying resource exists and is visible to the viewer. The
    # resolver returns missing=True for unknown or forbidden URIs; we refuse to
    # admit such a reference rather than persist a dangling pointer.
    resolved = resolve(db, resource_uri, viewer_id=viewer_id)
    if resolved.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    row, _created = _insert_reference_if_missing(
        db,
        conversation_id=conversation_id,
        resource_uri=resource_uri,
    )
    return _combine(row, resolved)


def remove_reference(
    db: Session, conversation_id: UUID, reference_id: UUID, *, viewer_id: UUID
) -> None:
    _require_owner(db, viewer_id, conversation_id)
    row = db.execute(
        select(ConversationReference).where(
            ConversationReference.id == reference_id,
            ConversationReference.conversation_id == conversation_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reference not found")
    db.delete(row)
    db.commit()


def insert_reference_if_absent(
    db: Session, conversation_id: UUID, resource_uri: str
) -> ConversationReference | None:
    """SELECT-then-INSERT for citation write-through.

    Returns the newly inserted row when a row was created, or None if a row
    with the same (conversation_id, resource_uri) already exists. The caller
    uses the return value to decide whether to emit a ``reference_added``
    SSE event.

    No owner check: the citation pipeline runs in the context of an authorized
    chat-run that already owns the conversation.
    """
    _validate_uri(resource_uri)
    row, created = _insert_reference_if_missing(
        db,
        conversation_id=conversation_id,
        resource_uri=resource_uri,
    )
    return row if created else None


def list_conversations_with_reference(
    db: Session,
    resource_uri: str,
    *,
    viewer_id: UUID,
    limit: int = _DEFAULT_LIMIT,
    cursor: str | None = None,
) -> tuple[list[ConversationOut], PageInfo]:
    """List conversations owned by ``viewer_id`` that hold ``resource_uri``.

    Single-user system: only conversations owned by the viewer are returned;
    there is no shared-by-others variant. Cursor and ordering mirror
    :func:`nexus.services.conversations.list_conversations` for shape
    consistency.
    """
    _validate_uri(resource_uri)
    limit = min(max(limit, _MIN_LIMIT), _MAX_LIMIT)

    params: dict = {
        "viewer_id": viewer_id,
        "resource_uri": resource_uri,
        "limit": limit + 1,
    }
    cursor_clause, cursor_params = _decode_cursor_clause(cursor)
    params.update(cursor_params)

    rows = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
                       AS message_count
            FROM conversations c
            JOIN conversation_references cr ON cr.conversation_id = c.id
            WHERE c.owner_user_id = :viewer_id
              AND cr.resource_uri = :resource_uri
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    ).fetchall()

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            title=row[2],
            is_owner=True,
            sharing=row[3],
            message_count=row[6],
            created_at=row[4],
            updated_at=row[5],
        )
        for row in rows
    ]

    next_cursor = None
    if has_more and conversations:
        last = conversations[-1]
        next_cursor = _encode_cursor(last.updated_at, last.id)

    return conversations, PageInfo(next_cursor=next_cursor)
