"""Reader Document Map aggregate read model."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.media import DocumentEmbedOut
from nexus.schemas.reader import (
    ReaderConnectionAnchorOut,
    ReaderConnectionPageOut,
    ReaderConnectionRowOut,
)
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapAnchorOut,
    ReaderDocumentMapAnchorPrecision,
    ReaderDocumentMapApparatusItemOut,
    ReaderDocumentMapChatThreadItemOut,
    ReaderDocumentMapConnectionItemOut,
    ReaderDocumentMapDiagnosticsOut,
    ReaderDocumentMapEmbedItemOut,
    ReaderDocumentMapHighlightItemOut,
    ReaderDocumentMapItemOut,
    ReaderDocumentMapLensId,
    ReaderDocumentMapLensOut,
    ReaderDocumentMapMarkerOut,
    ReaderDocumentMapMarkerTone,
    ReaderDocumentMapOut,
    ReaderDocumentMapSectionItemOut,
    ReaderDocumentMapSourceVersionOut,
    ReaderDocumentMapStatus,
    ReaderDocumentMapTargetStatus,
)
from nexus.services import (
    document_embeds,
    highlights,
    reader_apparatus,
    reader_connections,
    reader_navigation,
)
from nexus.services.resource_graph import context as conversation_context
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.routing import resource_activation_for_ref


def get_reader_document_map(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    include_unanchored: bool,
    limit: int,
) -> ReaderDocumentMapOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = (
        db.execute(
            text(
                """
            SELECT id, kind, title, updated_at, page_count
            FROM media
            WHERE id = :media_id
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    fragments = (
        db.execute(
            text(
                """
            SELECT id, idx, COALESCE(length(canonical_text), 0) AS char_count
            FROM fragments
            WHERE media_id = :media_id
            ORDER BY idx ASC
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    fragment_indexes = {str(row["id"]): int(row["idx"]) for row in fragments}
    fragment_ranges: dict[str, tuple[int, int]] = {}
    fragment_cursor = 0
    for row in fragments:
        char_count = max(int(row["char_count"] or 0), 1)
        fragment_ranges[str(row["id"])] = (fragment_cursor, char_count)
        fragment_cursor += char_count
    page_count = int(media["page_count"]) if media["page_count"] is not None else None
    media_kind = str(media["kind"])

    navigation = None
    navigation_status: ReaderDocumentMapStatus = "unsupported"
    if media_kind in ("web_article", "epub"):
        try:
            navigation = reader_navigation.get_media_navigation_for_viewer(db, viewer_id, media_id)
            navigation_status = "ready"
        except ApiError as exc:
            if exc.code != ApiErrorCode.E_MEDIA_NOT_READY:
                raise
            navigation_status = "partial"

    media_highlights = highlights.list_highlights_for_media(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        mine_only=False,
    )
    apparatus = reader_apparatus.get_media_apparatus(db, viewer_id, media_id)
    connections = _read_connections(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        include_unanchored=include_unanchored,
        limit=limit,
    )
    connection_rows = [*connections.anchored, *connections.unanchored]
    embed_rows = (
        document_embeds.list_document_embeds_for_media(db, viewer_id=viewer_id, media_id=media_id)
        if media_kind == "web_article"
        else []
    )
    embed_summary = (
        document_embeds.document_embed_summary_for_media(db, media_id=media_id)
        if media_kind == "web_article"
        else None
    )

    chat_threads = conversation_context.list_conversations_with_any_edge_to_ref(
        db,
        viewer_id=viewer_id,
        target=ResourceRef(scheme="media", id=media_id),
        limit=25,
    ).conversations

    items: list[ReaderDocumentMapItemOut] = []
    markers: list[ReaderDocumentMapMarkerOut] = []

    if navigation is not None:
        for index, section in enumerate(navigation.sections):
            fraction = (index + 0.5) / len(navigation.sections) if navigation.sections else None
            anchor = None
            if section.fragment_id is not None:
                locator = {
                    "type": "web_text_offsets"
                    if media_kind == "web_article"
                    else "epub_fragment_offsets",
                    "media_id": str(media_id),
                    "fragment_id": str(section.fragment_id),
                    "start_offset": section.start_offset or 0,
                    "end_offset": section.end_offset or section.start_offset or 0,
                }
                fraction = _locator_fraction(locator, fragment_ranges, fragment_cursor, page_count)
                anchor = ReaderDocumentMapAnchorOut(
                    ref=f"fragment:{section.fragment_id}",
                    media_id=media_id,
                    locator=locator,
                    fragment_id=section.fragment_id,
                    order_key=_order_key_from_locator(locator, fragment_indexes),
                    precision="container",
                )
            item = ReaderDocumentMapSectionItemOut(
                id=f"section:{section.section_id}",
                lens_ids=["contents"],
                kind="section",
                source_domain="navigation",
                title=section.label,
                anchor=anchor,
                document_order_key=anchor.order_key
                if anchor
                else f"section:{section.ordinal:010d}",
                document_fraction=fraction,
                target_status="container" if anchor else "unanchorable",
                provenance={"owner": "reader_navigation"},
                actions=["navigate"],
                section_id=section.section_id,
                level=section.level,
            )
            items.append(item)
            if fraction is not None:
                markers.append(_marker(item, "contents", fraction, "neutral"))

    for embed in embed_rows:
        locator = _document_embed_locator(media_id, embed)
        fraction = _locator_fraction(locator, fragment_ranges, fragment_cursor, page_count)
        anchor = (
            _anchor_from_locator(
                ref=f"media:{media_id}",
                media_id=media_id,
                locator=locator,
                precision="exact",
                fragment_indexes=fragment_indexes,
            )
            if locator
            else None
        )
        item = ReaderDocumentMapEmbedItemOut(
            id=f"embed:{embed.id}",
            lens_ids=["embeds"],
            kind="document_embed",
            source_domain="document_embeds",
            title=embed.display.label,
            subtitle=embed.provider,
            excerpt=embed.display.description,
            href=embed.target.href,
            anchor=anchor,
            document_order_key=anchor.order_key if anchor else embed.locator.document_order_key,
            document_fraction=fraction,
            target_status=cast(ReaderDocumentMapTargetStatus, embed.target.status),
            provenance={"owner": "document_embeds", "occurrence_key": embed.occurrence_key},
            actions=["activate"] if anchor else [],
            document_embed_id=embed.id,
            occurrence_key=embed.occurrence_key,
            provider=embed.provider,
            embed_kind=embed.kind,
            resolution_status=embed.resolution_status,
        )
        items.append(item)
        if fraction is not None:
            tone: ReaderDocumentMapMarkerTone = (
                "warning" if embed.resolution_status in ("failed", "unsupported") else "neutral"
            )
            markers.append(_marker(item, "embeds", fraction, tone))

    for highlight in media_highlights:
        locator = highlight.anchor.model_dump(mode="json")
        fraction = _locator_fraction(locator, fragment_ranges, fragment_cursor, page_count)
        item = ReaderDocumentMapHighlightItemOut(
            id=f"highlight:{highlight.id}",
            lens_ids=["highlights"],
            kind="highlight",
            source_domain="highlight",
            title=highlight.exact or "Highlight",
            excerpt=highlight.exact,
            anchor=_anchor_from_locator(
                ref=f"highlight:{highlight.id}",
                media_id=media_id,
                locator=locator,
                precision="exact",
                fragment_indexes=fragment_indexes,
            ),
            document_order_key=_order_key_from_locator(locator, fragment_indexes),
            document_fraction=fraction,
            target_status="exact",
            provenance={"owner": "highlights"},
            actions=["activate", "quote_to_chat"],
            highlight_id=highlight.id,
            color=cast(HIGHLIGHT_COLORS, highlight.color),
            exact=highlight.exact,
            note_block_count=len(highlight.linked_note_blocks),
            linked_conversation_count=len(highlight.linked_conversations),
        )
        items.append(item)
        if fraction is not None:
            markers.append(_marker(item, "highlights", fraction, "highlight"))

    apparatus_targets: dict[str, list[str]] = {}
    for edge in apparatus.edges:
        apparatus_targets.setdefault(edge.from_stable_key, []).append(edge.to_stable_key)
    if apparatus.status in ("ready", "partial"):
        for app_item in apparatus.items:
            locator = _locator_json(app_item.locator)
            fraction = _locator_fraction(locator, fragment_ranges, fragment_cursor, page_count)
            item = ReaderDocumentMapApparatusItemOut(
                id=f"apparatus:{app_item.stable_key}",
                lens_ids=["citations"],
                kind="apparatus",
                source_domain="reader_apparatus",
                title=app_item.label or "Citation",
                subtitle=app_item.kind,
                excerpt=app_item.body_text,
                activation=resource_activation_for_ref(
                    db,
                    viewer_id=viewer_id,
                    ref=assert_resource_ref(app_item.resource_ref),
                ),
                anchor=_anchor_from_locator(
                    ref=app_item.resource_ref,
                    media_id=media_id,
                    locator=locator,
                    precision="exact" if app_item.locator_status == "exact" else "container",
                    fragment_indexes=fragment_indexes,
                )
                if locator
                else None,
                document_order_key=_order_key_from_locator(locator, fragment_indexes)
                if locator
                else app_item.sort_key,
                document_fraction=fraction,
                target_status=_target_status(app_item.locator_status),
                provenance={
                    "owner": "reader_apparatus",
                    "confidence": app_item.confidence,
                },
                actions=["activate"] if locator else [],
                resource_ref=app_item.resource_ref,
                stable_key=app_item.stable_key,
                apparatus_kind=app_item.kind,
                confidence=app_item.confidence,
                locator_status=app_item.locator_status,
                target_stable_keys=apparatus_targets.get(app_item.stable_key, []),
            )
            items.append(item)
            if fraction is not None:
                markers.append(_marker(item, "citations", fraction, "citation"))

    for row in connection_rows:
        locator = _locator_json(row.anchor.locator) if row.anchor else None
        fraction = _locator_fraction(locator, fragment_ranges, fragment_cursor, page_count)
        target_status: ReaderDocumentMapTargetStatus = "exact" if row.anchor else "unanchorable"
        if row.connection.citation is not None and not row.anchor:
            target_status = _connection_target_status(row.connection.citation.target_status)
        item = ReaderDocumentMapConnectionItemOut(
            id=f"connection:{row.connection.edge_id}",
            lens_ids=["connections"],
            kind="connection",
            source_domain="generated_citation"
            if row.connection.origin == "citation"
            else "resource_graph",
            title=row.title,
            subtitle=row.subtitle,
            excerpt=row.excerpt,
            activation=row.connection.other.activation,
            href=row.connection.other.activation.href,
            anchor=_document_map_anchor(row.anchor) if row.anchor else None,
            document_order_key=row.anchor.order_key if row.anchor else None,
            document_fraction=fraction,
            target_status=target_status,
            provenance={"owner": "resource_graph", "origin": row.connection.origin},
            actions=["open_source", "activate_target"] if row.anchor else ["open_source"],
            edge_id=row.connection.edge_id,
            direction=row.connection.direction,
            origin=row.connection.origin,
            edge_kind=row.connection.kind,
            source_category=row.source_category,
            other_ref=row.connection.other.ref,
        )
        items.append(item)
        if fraction is not None:
            markers.append(_marker(item, "connections", fraction, "connection"))

    for conversation in chat_threads:
        items.append(
            ReaderDocumentMapChatThreadItemOut(
                id=f"chat:{conversation.id}",
                lens_ids=["chat"],
                kind="chat_thread",
                source_domain="chat",
                title=conversation.title,
                subtitle=f"{conversation.message_count} messages",
                activation=resource_activation_for_ref(
                    db,
                    viewer_id=viewer_id,
                    ref=ResourceRef(scheme="conversation", id=conversation.id),
                ),
                href=f"/conversations/{conversation.id}",
                anchor=None,
                document_order_key=None,
                document_fraction=None,
                target_status="unanchorable",
                provenance={"owner": "conversations"},
                actions=["open_chat"],
                conversation_id=conversation.id,
                latest_message_at=conversation.updated_at,
            )
        )

    items.sort(
        key=lambda item: (item.document_order_key is None, item.document_order_key or item.id)
    )
    markers.sort(key=lambda marker: marker.position)
    lens_counts = {
        "contents": len(navigation.sections) if navigation is not None else 0,
        "embeds": len(embed_rows),
        "highlights": len(media_highlights),
        "citations": len(apparatus.items) if apparatus.status in ("ready", "partial") else 0,
        "connections": len(connection_rows),
        "chat": len(chat_threads),
    }
    anchored_counts = {
        lens_id: sum(1 for item in items if lens_id in item.lens_ids and item.anchor is not None)
        for lens_id in lens_counts
    }
    unanchored_counts = {
        lens_id: lens_counts[lens_id] - anchored_counts[lens_id] for lens_id in lens_counts
    }

    lenses = [
        _lens(
            "contents",
            "Contents",
            navigation_status,
            lens_counts,
            anchored_counts,
            unanchored_counts,
        ),
        _lens(
            "embeds",
            "Embeds",
            cast(ReaderDocumentMapStatus, embed_summary.status if embed_summary else "empty"),
            lens_counts,
            anchored_counts,
            unanchored_counts,
        ),
        _lens("highlights", "Highlights", "ready", lens_counts, anchored_counts, unanchored_counts),
        _lens(
            "citations",
            "Citations",
            apparatus.status,
            lens_counts,
            anchored_counts,
            unanchored_counts,
        ),
        _lens(
            "connections", "Connections", "ready", lens_counts, anchored_counts, unanchored_counts
        ),
        _lens("chat", "Chat", "ready", lens_counts, anchored_counts, unanchored_counts),
    ]

    return ReaderDocumentMapOut(
        media_id=media_id,
        media_kind=media_kind,
        title=str(media["title"]),
        status=_map_status(lenses),
        source_version=ReaderDocumentMapSourceVersionOut(
            media_updated_at=media["updated_at"],
            apparatus_source_fingerprint=apparatus.source_fingerprint,
            graph_max_updated_at=max(
                (row.connection.created_at for row in connection_rows),
                default=None,
            ),
            highlights_max_updated_at=max(
                (highlight.updated_at for highlight in media_highlights),
                default=None,
            ),
        ),
        lenses=lenses,
        items=items,
        markers=markers,
        navigation=navigation,
        highlights=media_highlights,
        apparatus=apparatus,
        connections=connections,
        chat_threads=chat_threads,
        diagnostics=ReaderDocumentMapDiagnosticsOut(
            partial_lenses=[
                lens.id for lens in lenses if lens.status in ("resolving", "partial", "failed")
            ]
        ),
    )


def _read_connections(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    include_unanchored: bool,
    limit: int,
) -> ReaderConnectionPageOut:
    anchored: list[ReaderConnectionRowOut] = []
    unanchored: list[ReaderConnectionRowOut] = []
    cursor: str | None = None
    remaining = min(max(limit, 1), 1000)
    while remaining > 0:
        page = reader_connections.list_reader_connections(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            origins=reader_connections.READER_CONNECTION_ORIGINS,
            source_schemes=None,
            limit=min(remaining, 100),
            cursor=cursor,
        )
        anchored.extend(page.anchored)
        if include_unanchored:
            unanchored.extend(page.unanchored)
        read_count = len(page.anchored) + len(page.unanchored)
        remaining -= read_count
        cursor = page.next_cursor
        if cursor is None or read_count == 0:
            break
    return ReaderConnectionPageOut(anchored=anchored, unanchored=unanchored, next_cursor=cursor)


def _locator_json(locator: BaseModel | Mapping[str, Any] | None) -> dict[str, Any] | None:
    if locator is None:
        return None
    if isinstance(locator, BaseModel):
        return locator.model_dump(mode="json")
    return dict(locator)


def _lens(
    lens_id: ReaderDocumentMapLensId,
    label: str,
    status: ReaderDocumentMapStatus,
    counts: dict[str, int],
    anchored_counts: dict[str, int],
    unanchored_counts: dict[str, int],
) -> ReaderDocumentMapLensOut:
    count = counts[lens_id]
    return ReaderDocumentMapLensOut(
        id=lens_id,
        label=label,
        status="empty" if status == "ready" and count == 0 else status,
        item_count=count,
        anchored_count=anchored_counts[lens_id],
        unanchored_count=unanchored_counts[lens_id],
    )


def _map_status(lenses: list[ReaderDocumentMapLensOut]) -> ReaderDocumentMapStatus:
    if any(lens.status in ("partial", "failed") for lens in lenses):
        return "partial"
    if sum(lens.item_count for lens in lenses) == 0:
        return "empty"
    if any(lens.status == "ready" for lens in lenses):
        return "ready"
    return "unsupported"


def _marker(
    item: ReaderDocumentMapItemOut,
    lens_id: ReaderDocumentMapLensId,
    position: float,
    tone: ReaderDocumentMapMarkerTone,
) -> ReaderDocumentMapMarkerOut:
    return ReaderDocumentMapMarkerOut(
        id=f"marker:{lens_id}:{item.id}",
        item_id=item.id,
        lens_id=lens_id,
        lane=lens_id,
        position=min(1, max(0, position)),
        status=item.target_status,
        tone=tone,
        label=item.title,
        preview=item.excerpt,
    )


def _document_map_anchor(anchor: ReaderConnectionAnchorOut) -> ReaderDocumentMapAnchorOut:
    return ReaderDocumentMapAnchorOut(
        ref=anchor.ref,
        media_id=anchor.media_id,
        locator=anchor.locator,
        page_number=anchor.page_number,
        fragment_id=anchor.fragment_id,
        highlight_id=anchor.highlight_id,
        evidence_span_id=anchor.evidence_span_id,
        order_key=anchor.order_key,
        precision="exact",
    )


def _anchor_from_locator(
    *,
    ref: str,
    media_id: UUID,
    locator: dict[str, object],
    precision: ReaderDocumentMapAnchorPrecision,
    fragment_indexes: dict[str, int],
) -> ReaderDocumentMapAnchorOut:
    return ReaderDocumentMapAnchorOut(
        ref=ref,
        media_id=media_id,
        locator=locator,
        page_number=_locator_page(locator),
        fragment_id=_locator_fragment(locator),
        highlight_id=UUID(ref.removeprefix("highlight:")) if ref.startswith("highlight:") else None,
        evidence_span_id=None,
        order_key=_order_key_from_locator(locator, fragment_indexes),
        precision=precision,
    )


def _locator_fraction(
    locator: dict[str, object] | None,
    fragment_ranges: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
) -> float | None:
    if not locator:
        return None
    page = _locator_page(locator)
    if page is not None and page_count and page_count > 0:
        return (page - 0.5) / page_count
    fragment_id = _locator_fragment(locator)
    if fragment_id is not None:
        fragment_range = fragment_ranges.get(str(fragment_id))
        if fragment_range is None or total_fragment_chars <= 0:
            return None
        fragment_start, fragment_length = fragment_range
        start = locator.get("start_offset")
        end = locator.get("end_offset")
        if isinstance(start, int) and isinstance(end, int):
            offset = (start + end) / 2
        elif isinstance(start, int):
            offset = start
        else:
            offset = fragment_length / 2
        return (fragment_start + min(max(offset, 0), fragment_length)) / total_fragment_chars
    return None


def _order_key_from_locator(
    locator: dict[str, object] | None,
    fragment_indexes: dict[str, int],
) -> str | None:
    if not locator:
        return None
    page = _locator_page(locator)
    if page is not None:
        return f"pdf:{page:08d}"
    fragment_id = _locator_fragment(locator)
    start = locator.get("start_offset")
    if fragment_id is not None:
        idx = fragment_indexes.get(str(fragment_id), 0)
        return f"fragment:{idx:010d}:{int(start) if isinstance(start, int) else 0:010d}"
    start_ms = locator.get("t_start_ms")
    if isinstance(start_ms, int):
        return f"time:{start_ms:012d}"
    return None


def _locator_page(locator: dict[str, object]) -> int | None:
    value = locator.get("page_number")
    return value if isinstance(value, int) else None


def _locator_fragment(locator: dict[str, object]) -> UUID | None:
    value = locator.get("fragment_id")
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def _target_status(status: str) -> ReaderDocumentMapTargetStatus:
    if status == "exact":
        return "exact"
    if status == "container":
        return "container"
    return "missing"


def _document_embed_locator(media_id: UUID, embed: DocumentEmbedOut) -> dict[str, object] | None:
    if (
        embed.locator.fragment_id is None
        or embed.locator.canonical_start_offset is None
        or embed.locator.canonical_end_offset is None
    ):
        return None
    return {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(embed.locator.fragment_id),
        "start_offset": embed.locator.canonical_start_offset,
        "end_offset": embed.locator.canonical_end_offset,
    }


def _connection_target_status(status: str) -> ReaderDocumentMapTargetStatus:
    if status == "current":
        return "unanchorable"
    if status in (
        "missing",
        "forbidden",
        "unanchorable",
        "stale",
        "unsupported",
        "partial",
    ):
        return status
    return "unanchorable"
