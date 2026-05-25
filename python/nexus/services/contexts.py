"""Message context persistence and snapshot service."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import or_, select, text
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
from nexus.evidence_span_ids import (
    EvidenceSpanIdError,
    trusted_evidence_span_ids,
)
from nexus.schemas.conversation import (
    ContextItem,
    MessageContextRef,
    MessageContextSnapshot,
    ReaderSelectionContext,
)
from nexus.schemas.notes import ObjectRef
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.message_context_snapshots import (
    object_ref_context_snapshot_from_hydrated,
)
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


def reader_selection_context_from_row(row: MessageContextItem) -> ReaderSelectionContext:
    """Return the canonical ReaderSelectionContext for a persisted row."""
    return ReaderSelectionContext.model_validate(_reader_selection_context_payload_from_row(row))


def reader_selection_message_snapshot_from_row(
    row: MessageContextItem,
) -> MessageContextSnapshot:
    """Return the canonical message-list snapshot for a persisted row."""
    return MessageContextSnapshot.model_validate(
        _reader_selection_message_snapshot_payload_from_row(row)
    )


def _reader_selection_context_payload_from_row(row: MessageContextItem) -> dict[str, object]:
    snapshot = _reader_selection_snapshot_mapping(row)
    source_media_id = _reader_selection_source_media_id(row)
    media_id = _reader_selection_snapshot_required_uuid(snapshot, "media_id")
    snapshot_source_media_id = _reader_selection_snapshot_required_uuid(
        snapshot,
        "source_media_id",
    )
    if media_id != source_media_id or snapshot_source_media_id != source_media_id:
        raise ValueError("reader_selection persisted media ids are inconsistent")

    locator = _reader_selection_snapshot_locator(snapshot)
    payload: dict[str, object] = {
        "kind": "reader_selection",
        "client_context_id": _reader_selection_snapshot_required_uuid(
            snapshot,
            "client_context_id",
        ),
        "media_id": source_media_id,
        "media_kind": _reader_selection_snapshot_required_string(snapshot, "media_kind"),
        "media_title": _reader_selection_snapshot_required_string(snapshot, "media_title"),
        "exact": _reader_selection_snapshot_required_string(snapshot, "exact"),
        "locator": locator,
        "source_version": _reader_selection_snapshot_required_string(snapshot, "source_version"),
    }
    for key in ("prefix", "suffix"):
        value = snapshot.get(key)
        if value is not None:
            payload[key] = _reader_selection_snapshot_optional_string(value)
    return payload


def _reader_selection_message_snapshot_payload_from_row(
    row: MessageContextItem,
) -> dict[str, object]:
    snapshot = _reader_selection_snapshot_mapping(row)
    payload = _reader_selection_context_payload_from_row(row)
    media_id = payload["media_id"]
    payload["source_media_id"] = media_id
    for key in ("title", "route"):
        value = snapshot.get(key)
        if value is not None:
            payload[key] = _reader_selection_snapshot_optional_string(value)
    return payload


def _reader_selection_snapshot_mapping(row: MessageContextItem) -> Mapping[str, object]:
    snapshot = row.context_snapshot_json
    if not isinstance(snapshot, Mapping):
        raise ValueError("reader_selection snapshot is missing")
    return snapshot


def _reader_selection_source_media_id(row: MessageContextItem) -> UUID:
    if row.source_media_id is None:
        raise ValueError("reader_selection source media is missing")
    return row.source_media_id


def _reader_selection_snapshot_locator(snapshot: Mapping[str, object]) -> dict[str, Any]:
    raw = snapshot["locator"]
    if not isinstance(raw, dict) or not raw:
        raise ValueError("reader_selection locator is missing")
    locator = retrieval_locator_json(raw)
    if locator is None:
        raise ValueError("reader_selection locator is missing")
    return locator


def _reader_selection_snapshot_required_uuid(
    snapshot: Mapping[str, object],
    key: str,
) -> UUID:
    return UUID(_reader_selection_snapshot_required_string(snapshot, key))


def _reader_selection_snapshot_required_string(
    snapshot: Mapping[str, object],
    key: str,
) -> str:
    value = snapshot[key]
    if isinstance(value, str) and value.strip():
        return value
    raise ValueError("reader_selection snapshot field is missing")


def _reader_selection_snapshot_optional_string(value: object) -> str:
    if isinstance(value, str):
        return value
    raise ValueError("reader_selection snapshot field is invalid")


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


def validate_content_chunk_evidence_span_ids(
    db: Session,
    chunk_id: UUID,
    evidence_span_ids: Sequence[UUID | str],
) -> list[UUID]:
    try:
        trusted_ids = trusted_evidence_span_ids(list(evidence_span_ids))
    except EvidenceSpanIdError as exc:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Evidence span is not valid for context",
        ) from exc
    if not trusted_ids:
        return []
    matched_ids = set(
        db.execute(
            text(
                """
                SELECT es.id
                FROM content_chunks cc
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.active_run_id = cc.index_run_id
                JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                JOIN evidence_spans es ON es.media_id = cc.media_id
                    AND es.index_run_id = cc.index_run_id
                WHERE cc.id = :chunk_id
                  AND es.id = ANY(:evidence_span_ids)
                """
            ),
            {"chunk_id": chunk_id, "evidence_span_ids": trusted_ids},
        ).scalars()
    )
    if matched_ids != set(trusted_ids):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence span is not valid for context")
    return trusted_ids


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
    evidence_span_ids: list[UUID] = []
    if context.type == "content_chunk":
        evidence_span_ids = validate_content_chunk_evidence_span_ids(
            db,
            context.id,
            context.evidence_span_ids,
        )
    source_version: str | None = None
    locator_json: dict[str, object] | None = None
    result_media_id: UUID | str | None = None
    result_media_kind: str | None = None
    result_media_title: str | None = None
    if context.type in CITABLE_OBJECT_CONTEXT_TYPES:
        result = get_search_result(
            db,
            message.conversation.owner_user_id,
            context.type,
            str(context.id),
            evidence_span_ids if context.type == "content_chunk" else None,
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
        result_evidence_span_ids = getattr(result, "evidence_span_ids", None)
        if isinstance(result_evidence_span_ids, list) and result_evidence_span_ids:
            try:
                evidence_span_ids = trusted_evidence_span_ids(result_evidence_span_ids)
            except EvidenceSpanIdError as exc:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Context provenance cannot be verified",
                ) from exc
        result_evidence_span_id = getattr(result, "evidence_span_id", None)
        if result_evidence_span_id is not None and not evidence_span_ids:
            evidence_span_ids = [result_evidence_span_id]
        result_media_id = getattr(result, "media_id", None)
        result_media_kind = getattr(result, "media_kind", None)
        if not isinstance(result_media_kind, str) or not result_media_kind:
            result_media_kind = None
        result_title = getattr(result, "title", None)
        if isinstance(result_title, str) and result_title:
            result_media_title = result_title

    context_snapshot = object_ref_context_snapshot_from_hydrated(
        hydrated,
        evidence_span_ids=evidence_span_ids,
        media_id=result_media_id,
        media_kind=result_media_kind,
        media_title=result_media_title,
        locator=locator_json,
        source_version=source_version,
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
        _upsert_conversation_media(db, message.conversation_id, media_id)
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
    _upsert_conversation_media(db, message.conversation_id, media.id)
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


def _upsert_conversation_media(
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
