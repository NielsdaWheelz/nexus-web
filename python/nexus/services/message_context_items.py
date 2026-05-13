"""Message context item service."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Message, MessageContextItem, ObjectLink
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.notes import CreateMessageContextItemRequest, MessageContextItemOut, ObjectRef
from nexus.services.contexts import resolve_media_id_for_context, upsert_conversation_media
from nexus.services.object_refs import hydrate_object_ref


def create_message_context_item(
    db: Session,
    viewer_id: UUID,
    request: CreateMessageContextItemRequest,
) -> MessageContextItemOut:
    message = db.get(Message, request.message_id)
    if (
        message is None
        or message.conversation is None
        or message.conversation.owner_user_id != viewer_id
    ):
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    object_ref = ObjectRef(object_type=request.object_type, object_id=request.object_id)
    hydrated = hydrate_object_ref(db, viewer_id, object_ref)
    context_ref = MessageContextRef(type=request.object_type, id=request.object_id)
    media_id = resolve_media_id_for_context(db, context_ref)
    if media_id is not None and not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")

    ordinal = request.ordinal
    if ordinal is None:
        ordinal = db.scalar(
            select(MessageContextItem.ordinal)
            .where(MessageContextItem.message_id == message.id)
            .order_by(MessageContextItem.ordinal.desc())
            .limit(1)
        )
        ordinal = 0 if ordinal is None else ordinal + 1

    context_snapshot = _validated_context_snapshot(
        db,
        object_type=request.object_type,
        object_id=request.object_id,
        hydrated_snapshot=hydrated.model_dump(mode="json", by_alias=True),
        requested_evidence_span_ids=request.evidence_span_ids,
        requested_snapshot=request.context_snapshot,
    )

    row = MessageContextItem(
        message_id=message.id,
        user_id=viewer_id,
        object_type=request.object_type,
        object_id=request.object_id,
        ordinal=ordinal,
        context_snapshot_json=context_snapshot,
    )
    db.add(row)
    db.flush()

    existing_link = db.scalar(
        select(ObjectLink.id).where(
            ObjectLink.user_id == viewer_id,
            ObjectLink.relation_type == "used_as_context",
            ObjectLink.a_type == "message",
            ObjectLink.a_id == message.id,
            ObjectLink.b_type == request.object_type,
            ObjectLink.b_id == request.object_id,
            ObjectLink.a_locator_json.is_(None),
            ObjectLink.b_locator_json.is_(None),
        )
    )
    if existing_link is None:
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type="used_as_context",
                a_type="message",
                a_id=message.id,
                b_type=request.object_type,
                b_id=request.object_id,
                a_order_key=f"{ordinal + 1:010d}",
                b_order_key=None,
                a_locator_json=None,
                b_locator_json=None,
                metadata_json={},
            )
        )
    if media_id is not None:
        upsert_conversation_media(db, message.conversation_id, media_id)

    db.commit()
    db.refresh(row)
    return MessageContextItemOut(
        id=row.id,
        message_id=row.message_id,
        object_ref=object_ref,
        ordinal=row.ordinal,
        context_snapshot=row.context_snapshot_json,
        created_at=row.created_at,
    )


def _validated_context_snapshot(
    db: Session,
    *,
    object_type: str,
    object_id: UUID,
    hydrated_snapshot: dict[str, object],
    requested_evidence_span_ids: Sequence[UUID],
    requested_snapshot: Mapping[str, object] | None,
) -> dict[str, object]:
    snapshot_evidence_span_ids = _snapshot_evidence_span_ids(requested_snapshot)
    if requested_snapshot:
        unsupported_keys = set(requested_snapshot) - {
            "evidence_span_id",
            "evidenceSpanId",
            "evidence_span_ids",
            "evidenceSpanIds",
        }
        if unsupported_keys:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Message context snapshot must be backend generated",
            )

    evidence_span_ids = _dedupe_ids([*requested_evidence_span_ids, *snapshot_evidence_span_ids])
    if evidence_span_ids and object_type != "content_chunk":
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Evidence spans are only valid for content chunk context",
        )
    if evidence_span_ids:
        _validate_content_chunk_evidence_span_ids(db, object_id, evidence_span_ids)

    context_snapshot = dict(hydrated_snapshot)
    if evidence_span_ids:
        context_snapshot["evidence_span_ids"] = [
            str(evidence_span_id) for evidence_span_id in evidence_span_ids
        ]
    return context_snapshot


def _snapshot_evidence_span_ids(snapshot: Mapping[str, object] | None) -> list[UUID]:
    if not snapshot:
        return []
    raw_values = snapshot.get("evidence_span_ids")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanIds")
    if raw_values is None:
        raw_values = snapshot.get("evidence_span_id")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanId")
    if isinstance(raw_values, str):
        values = [raw_values]
    elif isinstance(raw_values, Sequence) and not isinstance(raw_values, (str, bytes)):
        values = list(raw_values)
    else:
        values = []
    parsed: list[UUID] = []
    for value in values:
        try:
            parsed.append(UUID(str(value)))
        except (TypeError, ValueError):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence span id is invalid") from None
    return parsed


def _dedupe_ids(values: Sequence[UUID]) -> list[UUID]:
    deduped: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped


def _validate_content_chunk_evidence_span_ids(
    db: Session,
    chunk_id: UUID,
    evidence_span_ids: Sequence[UUID],
) -> None:
    matched_ids = set(
        db.execute(
            text(
                """
                SELECT es.id
                FROM content_chunks cc
                JOIN evidence_spans es ON es.media_id = cc.media_id
                    AND es.index_run_id = cc.index_run_id
                WHERE cc.id = :chunk_id
                  AND es.id = ANY(:evidence_span_ids)
                """
            ),
            {"chunk_id": chunk_id, "evidence_span_ids": list(evidence_span_ids)},
        ).scalars()
    )
    if matched_ids != set(evidence_span_ids):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence span is not valid for context")
