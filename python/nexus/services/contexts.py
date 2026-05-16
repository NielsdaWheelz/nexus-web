"""Message context item service."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import delete, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    ConversationMedia,
    Fragment,
    Highlight,
    Media,
    Message,
    MessageContextItem,
    NoteBlock,
    ObjectLink,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import ContextItem, MessageContextRef, ReaderSelectionContext
from nexus.schemas.notes import ObjectRef
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.object_refs import hydrate_object_ref
from nexus.services.pdf_quote_match import MatchStatus, compute_match
from nexus.services.pdf_readiness import is_pdf_quote_text_ready
from nexus.services.search import get_search_result

QUOTE_CONTEXT_WINDOW = 64

CITABLE_OBJECT_CONTEXT_TYPES = {
    "content_chunk",
    "fragment",
    "highlight",
    "note_block",
    "message",
    "evidence_span",
}


def _highlight_media_id(highlight: Highlight) -> UUID | None:
    if highlight.anchor_media_id is None:
        return None
    if highlight.anchor_kind == "fragment_offsets":
        anchor = highlight.fragment_anchor
        fragment = anchor.fragment if anchor is not None else None
        if fragment is not None and fragment.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
    if highlight.anchor_kind == "pdf_page_geometry":
        anchor = highlight.pdf_anchor
        if anchor is not None and anchor.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
    return None


def resolve_media_id_for_context(db: Session, context: ContextItem) -> UUID | None:
    if context.kind == "reader_selection":
        media = db.get(Media, context.media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return media.id

    if context.type == "media":
        media = db.get(Media, context.id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return media.id

    if context.type == "highlight":
        highlight = db.get(Highlight, context.id)
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        media_id = _highlight_media_id(highlight)
        if media_id is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        return media_id

    if context.type == "content_chunk":
        row = db.execute(
            text("SELECT media_id FROM content_chunks WHERE id = :id"),
            {"id": context.id},
        ).fetchone()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Content chunk not found")
        return row[0]

    if context.type == "fragment":
        fragment = db.get(Fragment, context.id)
        if fragment is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
        return fragment.media_id

    if context.type == "note_block":
        block = db.get(NoteBlock, context.id)
        if block is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Note block not found")
        media_link = db.scalar(
            select(ObjectLink).where(
                or_(
                    (
                        (ObjectLink.a_type == "note_block")
                        & (ObjectLink.a_id == context.id)
                        & (ObjectLink.b_type == "media")
                    ),
                    (
                        (ObjectLink.a_type == "media")
                        & (ObjectLink.b_type == "note_block")
                        & (ObjectLink.b_id == context.id)
                    ),
                )
            )
        )
        if media_link is not None:
            return media_link.b_id if media_link.a_type == "note_block" else media_link.a_id
        highlight_link = db.scalar(
            select(ObjectLink).where(
                or_(
                    (
                        (ObjectLink.a_type == "note_block")
                        & (ObjectLink.a_id == context.id)
                        & (ObjectLink.b_type == "highlight")
                    ),
                    (
                        (ObjectLink.a_type == "highlight")
                        & (ObjectLink.b_type == "note_block")
                        & (ObjectLink.b_id == context.id)
                    ),
                )
            )
        )
        if highlight_link is not None:
            highlight_id = (
                highlight_link.b_id
                if highlight_link.a_type == "note_block"
                else highlight_link.a_id
            )
            highlight = db.get(Highlight, highlight_id)
            if highlight is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
            return _highlight_media_id(highlight)
        return None

    return None


def insert_context(
    db: Session,
    *,
    message_id: UUID,
    ordinal: int,
    context: ContextItem,
) -> MessageContextItem:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    if context.kind == "reader_selection":
        return _insert_reader_selection_context(
            db=db,
            message=message,
            message_id=message_id,
            ordinal=ordinal,
            context=context,
        )

    return _insert_object_ref_context(
        db=db,
        message=message,
        message_id=message_id,
        ordinal=ordinal,
        context=context,
    )


def _insert_object_ref_context(
    db: Session,
    *,
    message: Message,
    message_id: UUID,
    ordinal: int,
    context: MessageContextRef,
) -> MessageContextItem:
    hydrated = hydrate_object_ref(
        db,
        message.conversation.owner_user_id,
        ObjectRef(object_type=context.type, object_id=context.id),
    )
    media_id = resolve_media_id_for_context(db, context)
    if media_id is not None and not can_read_media(
        db, message.conversation.owner_user_id, media_id
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Context not found")
    if context.type == "artifact_part":
        row = (
            db.execute(
                text(
                    """
                SELECT
                    part.artifact_id,
                    part.source_version,
                    part.locator
                FROM message_artifact_parts part
                JOIN message_artifacts artifact ON artifact.id = part.artifact_id
                WHERE part.id = :artifact_part_id
                  AND artifact.conversation_id = :conversation_id
                """
                ),
                {
                    "artifact_part_id": context.id,
                    "conversation_id": message.conversation_id,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        locator = (
            retrieval_locator_json(context.locator.model_dump(mode="json"))
            if context.locator is not None
            else None
        )
        stored_locator = retrieval_locator_json(
            row["locator"] if isinstance(row["locator"], dict) else None
        )
        if (
            context.artifact_id != row["artifact_id"]
            or context.source_version != row["source_version"]
            or locator != stored_locator
        ):
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact part context provenance does not match the stored part",
            )

    context_snapshot = hydrated.model_dump(mode="json", by_alias=True)
    context_snapshot["kind"] = "object_ref"
    if context.type == "content_chunk" and context.evidence_span_ids:
        context_snapshot["evidence_span_ids"] = [
            str(span_id) for span_id in context.evidence_span_ids
        ]
    if context.type in CITABLE_OBJECT_CONTEXT_TYPES:
        result = get_search_result(
            db,
            message.conversation.owner_user_id,
            context.type,
            str(context.id),
            context.evidence_span_ids if context.type == "content_chunk" else None,
        )
        source_version = getattr(result, "source_version", None)
        locator = getattr(result, "locator", None)
        if not isinstance(source_version, str) or locator is None:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Context provenance cannot be verified",
            )
        locator_json = retrieval_locator_json(
            locator.model_dump(mode="json") if isinstance(locator, BaseModel) else locator
        )
        if locator_json is None:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Context provenance cannot be verified",
            )
        context_snapshot["source_version"] = source_version
        context_snapshot["locator"] = locator_json
        result_evidence_span_ids = getattr(result, "evidence_span_ids", None)
        if isinstance(result_evidence_span_ids, list) and result_evidence_span_ids:
            context_snapshot["evidence_span_ids"] = [
                str(span_id) for span_id in result_evidence_span_ids
            ]
        result_evidence_span_id = getattr(result, "evidence_span_id", None)
        if result_evidence_span_id is not None and not context_snapshot.get("evidence_span_ids"):
            context_snapshot["evidence_span_ids"] = [str(result_evidence_span_id)]
        result_media_id = getattr(result, "media_id", None)
        if result_media_id is not None:
            context_snapshot["media_id"] = str(result_media_id)
        result_media_kind = getattr(result, "media_kind", None)
        if isinstance(result_media_kind, str) and result_media_kind:
            context_snapshot["media_kind"] = result_media_kind
    if context.type == "artifact_part":
        context_snapshot["artifact_id"] = str(context.artifact_id)
        context_snapshot["source_version"] = context.source_version
        context_snapshot["locator"] = (
            context.locator.model_dump(mode="json") if context.locator else None
        )
        context_snapshot["evidence_span_ids"] = [
            str(span_id) for span_id in context.evidence_span_ids
        ]
        if context.artifact_key is not None:
            context_snapshot["artifact_key"] = context.artifact_key
        if context.artifact_version is not None:
            context_snapshot["artifact_version"] = context.artifact_version
        if context.artifact_part_provenance:
            context_snapshot["artifact_part_provenance"] = (
                context.artifact_part_provenance.model_dump(mode="json")
            )

    row = MessageContextItem(
        message_id=message_id,
        user_id=message.conversation.owner_user_id,
        ordinal=ordinal,
        context_kind="object_ref",
        object_type=context.type,
        object_id=context.id,
        source_media_id=media_id if context.type in CITABLE_OBJECT_CONTEXT_TYPES else None,
        locator_json=None,
        context_snapshot_json=context_snapshot,
    )
    db.add(row)
    db.flush()

    context_order_key = f"{ordinal + 1:010d}"
    existing_link = db.scalar(
        select(ObjectLink).where(
            ObjectLink.user_id == message.conversation.owner_user_id,
            ObjectLink.relation_type == "used_as_context",
            or_(
                (
                    (ObjectLink.a_type == "message")
                    & (ObjectLink.a_id == message_id)
                    & (ObjectLink.b_type == context.type)
                    & (ObjectLink.b_id == context.id)
                ),
                (
                    (ObjectLink.a_type == context.type)
                    & (ObjectLink.a_id == context.id)
                    & (ObjectLink.b_type == "message")
                    & (ObjectLink.b_id == message_id)
                ),
            ),
            ObjectLink.a_locator_json.is_(None),
            ObjectLink.b_locator_json.is_(None),
        )
    )
    if existing_link is None:
        db.add(
            ObjectLink(
                user_id=message.conversation.owner_user_id,
                relation_type="used_as_context",
                a_type="message",
                a_id=message_id,
                b_type=context.type,
                b_id=context.id,
                a_order_key=context_order_key,
                b_order_key=None,
                a_locator_json=None,
                b_locator_json=None,
                metadata_json={},
            )
        )
    elif existing_link.a_type == "message" and existing_link.a_id == message_id:
        if existing_link.a_order_key is None:
            existing_link.a_order_key = context_order_key
    elif existing_link.b_order_key is None:
        existing_link.b_order_key = context_order_key

    if media_id is not None:
        upsert_conversation_media(db, message.conversation_id, media_id)
    return row


def _insert_reader_selection_context(
    db: Session,
    *,
    message: Message,
    message_id: UUID,
    ordinal: int,
    context: ReaderSelectionContext,
) -> MessageContextItem:
    media = db.get(Media, context.media_id)
    if media is None or not can_read_media(
        db, message.conversation.owner_user_id, context.media_id
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Context not found")
    if media.kind == "pdf" and not is_pdf_quote_text_ready(db, media.id):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "PDF quote text is not ready")

    verified = _verified_reader_selection(db, media=media, context=context)
    context_snapshot = {
        "kind": "reader_selection",
        "client_context_id": str(context.client_context_id),
        "media_id": str(media.id),
        "source_media_id": str(media.id),
        "media_kind": context.media_kind,
        "media_title": context.media_title,
        "title": context.media_title,
        "route": f"/media/{media.id}",
        "exact": verified["exact"],
        "prefix": verified["prefix"],
        "suffix": verified["suffix"],
        "locator": verified["locator"],
        "source_version": verified["source_version"],
        "evidence_verification": "source_text_exact_match_v1",
    }

    row = MessageContextItem(
        message_id=message_id,
        user_id=message.conversation.owner_user_id,
        ordinal=ordinal,
        context_kind="reader_selection",
        object_type=None,
        object_id=None,
        source_media_id=media.id,
        locator_json=verified["locator"],
        context_snapshot_json=context_snapshot,
    )
    db.add(row)
    db.flush()

    context_order_key = f"{ordinal + 1:010d}"
    db.add(
        ObjectLink(
            user_id=message.conversation.owner_user_id,
            relation_type="used_as_context",
            a_type="message",
            a_id=message_id,
            b_type="media",
            b_id=media.id,
            a_order_key=context_order_key,
            b_order_key=None,
            a_locator_json=None,
            b_locator_json=verified["locator"],
            metadata_json={
                "context_kind": "reader_selection",
                "context_item_id": str(row.id),
                "client_context_id": str(context.client_context_id),
                "source_version": verified["source_version"],
                "evidence_verification": "source_text_exact_match_v1",
            },
        )
    )
    upsert_conversation_media(db, message.conversation_id, media.id)
    return row


def _verified_reader_selection(
    db: Session,
    *,
    media: Media,
    context: ReaderSelectionContext,
) -> dict[str, object]:
    locator = _locator_json(context.locator, "reader_selection locator")
    if str(locator.get("media_id")) != str(media.id):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator media mismatch")
    exact = context.exact.strip()
    if locator["type"] in {"web_text_offsets", "epub_fragment_offsets"}:
        verified = _verified_fragment_offsets_selection(
            db,
            media.id,
            locator,
            exact,
            context.source_version,
        )
    elif locator["type"] == "pdf_page_geometry":
        verified = _verified_pdf_selection(
            db,
            media.id,
            locator,
            exact,
            context.source_version,
        )
    elif locator["type"] in {
        "transcript_time_range",
        "audio_time_range",
        "video_time_range",
    }:
        verified = _verified_transcript_selection(
            db,
            media.id,
            locator,
            exact,
            context.source_version,
        )
    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is unsupported")
    verified_locator = dict(locator)
    verified_locator["text_quote_selector"] = {
        "exact": verified["exact"],
        "prefix": verified["prefix"],
        "suffix": verified["suffix"],
    }
    if locator["type"] == "pdf_page_geometry":
        verified_locator["exact"] = verified["exact"]
        verified_locator["prefix"] = verified["prefix"]
        verified_locator["suffix"] = verified["suffix"]
    normalized_locator = retrieval_locator_json(verified_locator)
    if normalized_locator is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is invalid")
    return {
        "exact": verified["exact"],
        "prefix": verified["prefix"],
        "suffix": verified["suffix"],
        "locator": normalized_locator,
        "source_version": verified["source_version"],
    }


def _verified_fragment_offsets_selection(
    db: Session,
    media_id: UUID,
    locator: Mapping[str, object],
    exact: str,
    expected_source_version: str,
) -> dict[str, str]:
    fragment_id = locator.get("fragment_id")
    start_offset = locator.get("start_offset")
    end_offset = locator.get("end_offset")
    if (
        not isinstance(fragment_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
    ):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is invalid")
    rows = (
        db.execute(
            text(
                """
                SELECT cb.canonical_text,
                       cb.locator,
                       ss.source_version
                FROM media_content_index_states mcis
                JOIN content_blocks cb
                  ON cb.media_id = mcis.media_id
                 AND cb.index_run_id = mcis.active_run_id
                JOIN source_snapshots ss ON ss.id = cb.source_snapshot_id
                WHERE mcis.media_id = :media_id
                  AND mcis.status = 'ready'
                  AND cb.locator->>'fragment_id' = :fragment_id
                  AND cb.locator->>'kind' IN ('web_text', 'epub_text')
                ORDER BY CAST(cb.locator->>'start_offset' AS integer), cb.block_idx
                """
            ),
            {"media_id": media_id, "fragment_id": fragment_id},
        )
        .mappings()
        .all()
    )
    if not rows:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
    text_parts: list[str] = []
    cursor = 0
    source_version = str(rows[0]["source_version"])
    for row in rows:
        block_locator = row["locator"] if isinstance(row["locator"], dict) else {}
        block_start = block_locator.get("start_offset")
        block_end = block_locator.get("end_offset")
        if not isinstance(block_start, int) or not isinstance(block_end, int):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
        if block_start != cursor or block_end < block_start:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
        block_text = str(row["canonical_text"] or "")
        if len(block_text) != block_end - block_start:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
        if str(row["source_version"]) != source_version:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
        text_parts.append(block_text)
        cursor = block_end
    text_value = "".join(text_parts)
    if end_offset > len(text_value):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
    if text_value[start_offset:end_offset] != exact:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader selection quote does not match source"
        )
    _check_reader_selection_source_version(source_version, expected_source_version)
    return {
        **_quote_with_context(text_value, start_offset, end_offset),
        "source_version": source_version,
    }


def _verified_pdf_selection(
    db: Session,
    media_id: UUID,
    locator: Mapping[str, object],
    exact: str,
    expected_source_version: str,
) -> dict[str, str]:
    page_number = locator.get("page_number")
    if not isinstance(page_number, int):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is invalid")
    rows = (
        db.execute(
            text(
                """
                SELECT cb.canonical_text,
                       cb.locator,
                       ss.source_version
                FROM media_content_index_states mcis
                JOIN content_blocks cb
                  ON cb.media_id = mcis.media_id
                 AND cb.index_run_id = mcis.active_run_id
                JOIN source_snapshots ss ON ss.id = cb.source_snapshot_id
                WHERE mcis.media_id = :media_id
                  AND mcis.status = 'ready'
                  AND cb.locator->>'kind' = 'pdf_text'
                  AND CAST(cb.locator->>'page_number' AS integer) = :page_number
                ORDER BY cb.block_idx
                """
            ),
            {"media_id": media_id, "page_number": page_number},
        )
        .mappings()
        .all()
    )
    if not rows:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection source text is missing")
    source_version = str(rows[0]["source_version"])
    page_text = "\n\n".join(str(row["canonical_text"] or "") for row in rows)
    if any(str(row["source_version"]) != source_version for row in rows):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
    match = compute_match(
        exact,
        page_number,
        page_text,
        0,
        len(page_text),
    )
    if match.status != MatchStatus.unique or match.start_offset is None or match.end_offset is None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader selection quote does not match source"
        )
    _check_reader_selection_source_version(source_version, expected_source_version)
    return {
        **_quote_with_context(page_text, match.start_offset, match.end_offset),
        "source_version": source_version,
    }


def _verified_transcript_selection(
    db: Session,
    media_id: UUID,
    locator: Mapping[str, object],
    exact: str,
    expected_source_version: str,
) -> dict[str, str]:
    t_start_ms = locator.get("t_start_ms")
    t_end_ms = locator.get("t_end_ms")
    if not isinstance(t_start_ms, int) or not isinstance(t_end_ms, int) or t_end_ms <= t_start_ms:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is invalid")
    rows = (
        db.execute(
            text(
                """
                SELECT cb.canonical_text,
                       ss.source_version
                FROM media_content_index_states mcis
                JOIN content_blocks cb
                  ON cb.media_id = mcis.media_id
                 AND cb.index_run_id = mcis.active_run_id
                JOIN source_snapshots ss ON ss.id = cb.source_snapshot_id
                WHERE mcis.media_id = :media_id
                  AND mcis.status = 'ready'
                  AND cb.locator->>'kind' = 'transcript_time_text'
                  AND CAST(cb.locator->>'t_start_ms' AS integer) < :t_end_ms
                  AND CAST(cb.locator->>'t_end_ms' AS integer) > :t_start_ms
                ORDER BY cb.block_idx
                """
            ),
            {"media_id": media_id, "t_start_ms": t_start_ms, "t_end_ms": t_end_ms},
        )
        .mappings()
        .all()
    )
    if not rows:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
    source_version = str(rows[0]["source_version"])
    if any(str(row["source_version"]) != source_version for row in rows):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection locator is stale")
    text_value = " ".join(
        str(row["canonical_text"] or "").strip()
        for row in rows
        if str(row["canonical_text"] or "").strip()
    )
    start = text_value.find(exact)
    if start < 0:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader selection quote does not match source"
        )
    _check_reader_selection_source_version(source_version, expected_source_version)
    return {
        **_quote_with_context(text_value, start, start + len(exact)),
        "source_version": source_version,
    }


def _check_reader_selection_source_version(
    source_version: str,
    expected_source_version: str,
) -> None:
    if expected_source_version != source_version:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Reader selection source version is stale")


def _quote_with_context(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - QUOTE_CONTEXT_WINDOW) : start_offset],
        "suffix": text_value[end_offset : min(len(text_value), end_offset + QUOTE_CONTEXT_WINDOW)],
    }


def _locator_json(value: object, label: str) -> dict[str, object]:
    if isinstance(value, BaseModel):
        raw = value.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
    elif isinstance(value, Mapping):
        raw = dict(value)
    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"{label} must be a non-empty object")
    normalized = retrieval_locator_json(raw)
    if not normalized:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"{label} must be a non-empty object")
    return normalized


def insert_contexts_batch(
    db: Session,
    *,
    message_id: UUID,
    contexts: Sequence[ContextItem],
) -> list[MessageContextItem]:
    return [
        insert_context(db=db, message_id=message_id, ordinal=ordinal, context=context)
        for ordinal, context in enumerate(contexts)
    ]


def upsert_conversation_media(
    db: Session,
    conversation_id: UUID,
    media_id: UUID,
) -> ConversationMedia:
    now = datetime.now(UTC)
    existing = db.scalar(
        select(ConversationMedia).where(
            ConversationMedia.conversation_id == conversation_id,
            ConversationMedia.media_id == media_id,
        )
    )
    if existing is not None:
        existing.last_message_at = now
        db.flush()
        return existing

    row = ConversationMedia(
        conversation_id=conversation_id,
        media_id=media_id,
        last_message_at=now,
    )
    db.add(row)
    db.flush()
    return row


def recompute_conversation_media(db: Session, conversation_id: UUID) -> None:
    current_media_ids = {
        row[0]
        for row in db.execute(
            select(ConversationMedia.media_id).where(
                ConversationMedia.conversation_id == conversation_id
            )
        ).fetchall()
    }

    context_rows = (
        db.execute(
            select(MessageContextItem)
            .join(Message, Message.id == MessageContextItem.message_id)
            .where(Message.conversation_id == conversation_id)
        )
        .scalars()
        .all()
    )

    expected_media_ids: set[UUID] = set()
    for row in context_rows:
        if row.context_kind == "reader_selection":
            media_id = row.source_media_id
        else:
            media_id = resolve_media_id_for_context(
                db,
                MessageContextRef.model_validate(
                    {"kind": "object_ref", "type": row.object_type, "id": row.object_id}
                ),
            )
        if media_id is not None:
            expected_media_ids.add(media_id)

    to_remove = current_media_ids - expected_media_ids
    if to_remove:
        db.execute(
            delete(ConversationMedia).where(
                ConversationMedia.conversation_id == conversation_id,
                ConversationMedia.media_id.in_(to_remove),
            )
        )

    for media_id in expected_media_ids - current_media_ids:
        db.add(
            ConversationMedia(
                conversation_id=conversation_id,
                media_id=media_id,
                last_message_at=datetime.now(UTC),
            )
        )
    db.flush()


def get_conversation_media(db: Session, conversation_id: UUID) -> list[ConversationMedia]:
    return list(
        db.scalars(
            select(ConversationMedia).where(ConversationMedia.conversation_id == conversation_id)
        )
    )
