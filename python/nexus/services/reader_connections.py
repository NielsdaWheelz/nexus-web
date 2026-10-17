"""Media-reader projection for graph connections."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_graph import (
    ConnectionFiltersRequest,
    ConnectionOut,
    ConnectionQueryRequest,
    EdgeOrigin,
)
from nexus.schemas.resource_items import (
    CitationSourceTargetKey,
    LocatedSourceLocationOut,
    ResourceSourceTargetKey,
)
from nexus.services.reader_locations import (
    order_key_from_locator,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.evidence import resolve_source_target

READER_CONNECTION_ORIGINS: tuple[EdgeOrigin, ...] = (
    "citation",
    "note_body",
    "highlight_note",
    "user",
    "discovery",
    "system",
    "document_embed",
    "assistant",
)


@dataclass(frozen=True, slots=True)
class ReaderConnectionAnchor:
    locator: dict[str, object]
    order_key: str | None
    passage_anchor_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ReaderConnectionRow:
    connection: ConnectionOut
    anchor: ReaderConnectionAnchor | None


def list_reader_connections(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[ReaderConnectionRow]:
    """Every reader-projected connection for one media, in reader order."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    fragment_indexes = {
        str(row[0]): int(row[1])
        for row in db.execute(
            text("SELECT id, idx FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    }
    anchors: dict[str, ReaderConnectionAnchor | None] = {}
    rows: list[ReaderConnectionRow] = []

    def anchor_for(connection: ConnectionOut, uri: str) -> ReaderConnectionAnchor | None:
        key = (
            f"citation:{connection.edge_id}"
            if connection.ordinal is not None and connection.target.ref == uri
            else uri
        )
        if key not in anchors:
            anchors[key] = _anchor_for_ref(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                ref=assert_resource_ref(uri),
                connection=connection,
                fragment_indexes=fragment_indexes,
            )
        return anchors[key]

    cursor: str | None = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQueryRequest(
                refs=[f"media:{media_id}"],
                direction="both",
                rollup="owner",
                filters=ConnectionFiltersRequest(origins=list(READER_CONNECTION_ORIGINS)),
                cursor=cursor,
            ),
        )
        for connection in page.items:
            # A neutral Link is undirected: when BOTH endpoints anchor in this media
            # the reader emits one row per local endpoint, each activating the other.
            source_anchor = target_anchor = None
            if connection.direction == "undirected":
                source_anchor = anchor_for(connection, connection.source.ref)
                target_anchor = anchor_for(connection, connection.target.ref)
            if source_anchor is not None and target_anchor is not None:
                rows.append(
                    ReaderConnectionRow(
                        connection.model_copy(update={"other": connection.target}), source_anchor
                    )
                )
                rows.append(
                    ReaderConnectionRow(
                        connection.model_copy(update={"other": connection.source}), target_anchor
                    )
                )
                continue
            local_ref = (
                connection.source.ref
                if connection.other.ref == connection.target.ref
                else connection.target.ref
            )
            rows.append(ReaderConnectionRow(connection, anchor_for(connection, local_ref)))
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    rows.sort(key=_row_order_key)
    return rows


def _row_order_key(row: ReaderConnectionRow) -> tuple[int, str]:
    if row.anchor is not None and row.anchor.order_key is not None:
        return (0, row.anchor.order_key)
    return (1, row.connection.created_at.isoformat())


def _anchor_for_ref(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    connection: ConnectionOut,
    fragment_indexes: dict[str, int],
) -> ReaderConnectionAnchor | None:
    key = (
        CitationSourceTargetKey(edge_id=connection.edge_id)
        if connection.ordinal is not None and connection.target.ref == ref.uri
        else ResourceSourceTargetKey(resource_ref=ref.uri)
    )
    try:
        target = resolve_source_target(db, viewer_id=viewer_id, target=key)
    except NotFoundError:
        return None
    if (
        target.source_activation is None
        or target.source_activation.resource_ref != f"media:{media_id}"
        or not isinstance(target.location, LocatedSourceLocationOut)
    ):
        return None
    locator = target.location.locator.model_dump(mode="json")
    return ReaderConnectionAnchor(
        locator,
        order_key_from_locator(locator, fragment_indexes),
        passage_anchor_id=ref.id if ref.scheme == "passage_anchor" else None,
    )
