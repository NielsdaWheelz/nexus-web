"""Reader apparatus store: one state row, its items and edges, keyed by stable_key.

replacement stays in the caller's publication-locked transaction; a retry keeps matched
item ids. old and new item identities refresh together, including empty replacements.
Each upsert's JSON is bounded by 128 rows and 512 KiB, or one larger valid row.
The byte envelope is max(512 KiB, the largest encoded row plus array brackets).
The map reads bounded owner summaries and ordered target refs, never note bodies.
An opened owner reads its complete targets under the caller's publication fence.
Only that detail read binds copied HTML, using aliases across the publication;
repair provenance stays in storage. Neither read changes content or progress.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid4

from pydantic import JsonValue
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.reader import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.reader_apparatus import (
    NoteBodyRegion,
    NoteGroupRegion,
    NoteRegion,
    NotesGroup,
    ReaderApparatusConfidence,
    ReaderApparatusEdgeOut,
    ReaderApparatusItemKind,
    ReaderApparatusItemOut,
    ReaderApparatusLocatorStatus,
    ReaderApparatusRelation,
    ReaderApparatusStatus,
)
from nexus.schemas.reader_document_map import (
    ReaderApparatusDetailOut,
    ReaderEvidenceAnchorOut,
    ReaderEvidenceResolutionOut,
    ReaderEvidenceResolvedOut,
    ReaderEvidenceSourceTargetOut,
    ReaderEvidenceUnavailableOut,
    ReaderSourceHtmlOut,
    ReaderSourceTextOut,
    ReaderSourceUnavailableOut,
    SourceContent,
)
from nexus.schemas.retrieval import MediaRetrievalLocator, RetrievalLocator, retrieval_locator_json
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.capabilities import is_document_status_ready
from nexus.services.epub_read import bind_epub_fragment_link
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.reader_locations import (
    locator_is_current_for_media,
    locator_json,
    order_key_from_locator,
)
from nexus.services.reader_publication import read_publication_generation
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.items import resource_items_out
from nexus.services.resource_items.routing import route_for_visible_apparatus_item
from nexus.services.search import projection

SUPPORTED_MEDIA_KINDS = frozenset({"web_article", "epub", "pdf"})
_UPSERT_MAX_ROWS = 128
_UPSERT_MAX_BYTES = 512 * 1024
_OWNER_ITEMS_CTE = """
    WITH forward_edges AS (
        SELECT edge.id, edge.from_item_id, edge.to_item_id
        FROM reader_apparatus_edges edge
        JOIN reader_apparatus_items source
          ON source.id = edge.from_item_id AND source.state_id = edge.state_id
        JOIN reader_apparatus_items target
          ON target.id = edge.to_item_id AND target.state_id = edge.state_id
        WHERE edge.state_id = :state_id AND edge.relation IN (
            'points_to_note', 'points_to_endnote', 'points_to_sidenote',
            'points_to_margin_note', 'cites_bibliography_entry'
        )
    ), owners AS (
        SELECT item.id FROM reader_apparatus_items item
        WHERE item.state_id = :state_id AND (
            right(item.kind, 4) = '_ref'
            OR item.id IN (SELECT from_item_id FROM forward_edges)
            OR item.id NOT IN (SELECT to_item_id FROM forward_edges)
        )
    )
"""


@dataclass(slots=True)
class ReaderApparatusItem:
    """One validated summary or selected target; only detail contains copied HTML."""

    id: UUID
    resource_ref: str
    stable_key: str
    kind: ReaderApparatusItemKind
    label: str | None
    body_text: str | None
    body_html_sanitized: str | None
    locator: RetrievalLocator | None
    locator_status: ReaderApparatusLocatorStatus
    confidence: ReaderApparatusConfidence
    source_ref: dict[str, JsonValue]
    sort_key: str


@dataclass(frozen=True, slots=True)
class ReaderApparatusEdge:
    from_stable_key: str
    to_stable_key: str
    to_item_id: UUID
    to_resource_ref: str
    relation: ReaderApparatusRelation
    sort_key: str


@dataclass(frozen=True, slots=True)
class ReaderApparatusResponse:
    """Already-visible owners or selected targets in one snapshot; never serialized."""

    media_id: UUID
    status: ReaderApparatusStatus
    items: list[ReaderApparatusItem]
    edges: list[ReaderApparatusEdge]


@dataclass(frozen=True, slots=True)
class _ApparatusState:
    id: UUID | None
    status: ReaderApparatusStatus
    media_kind: str
    page_count: int | None


_ITEM_UPSERT = text(
    """
    INSERT INTO reader_apparatus_items (
        media_id, state_id, stable_key, kind, label, body_text, body_html_sanitized,
        locator, locator_status, confidence, extraction_method, source_ref, sort_key
    )
    SELECT :media_id, :state_id, item.stable_key, item.kind, item.label,
        item.body_text, item.body_html_sanitized, item.locator, item.locator_status,
        item.confidence, item.extraction_method, item.source_ref, item.sort_key
    FROM jsonb_to_recordset(CAST(:items AS jsonb)) AS item(
        stable_key text, kind text, label text, body_text text, body_html_sanitized text,
        locator jsonb, locator_status text, confidence text, extraction_method text,
        source_ref jsonb, sort_key text
    )
    ON CONFLICT (media_id, stable_key) DO UPDATE SET
        kind = EXCLUDED.kind,
        label = EXCLUDED.label,
        body_text = EXCLUDED.body_text,
        body_html_sanitized = EXCLUDED.body_html_sanitized,
        locator = EXCLUDED.locator,
        locator_status = EXCLUDED.locator_status,
        confidence = EXCLUDED.confidence,
        extraction_method = EXCLUDED.extraction_method,
        source_ref = EXCLUDED.source_ref,
        sort_key = EXCLUDED.sort_key
    RETURNING stable_key, id
    """
)

_EDGE_UPSERT = text(
    """
    INSERT INTO reader_apparatus_edges (
        media_id, state_id, stable_key, from_item_id, to_item_id, relation,
        confidence, extraction_method, source_ref, sort_key
    )
    SELECT :media_id, :state_id, edge.stable_key, edge.from_item_id, edge.to_item_id,
        edge.relation, edge.confidence, edge.extraction_method, edge.source_ref, edge.sort_key
    FROM jsonb_to_recordset(CAST(:edges AS jsonb)) AS edge(
        stable_key text, from_item_id uuid, to_item_id uuid, relation text,
        confidence text, extraction_method text, source_ref jsonb, sort_key text
    )
    ON CONFLICT (media_id, stable_key) DO UPDATE SET
        from_item_id = EXCLUDED.from_item_id,
        to_item_id = EXCLUDED.to_item_id,
        relation = EXCLUDED.relation,
        confidence = EXCLUDED.confidence,
        extraction_method = EXCLUDED.extraction_method,
        source_ref = EXCLUDED.source_ref,
        sort_key = EXCLUDED.sort_key
    """
)


def _upsert_json_batches(rows: Sequence[Mapping[str, object]]) -> Iterator[str]:
    batch: list[str] = []
    size = 2  # Array brackets.
    for row in rows:
        encoded = json.dumps(row)
        row_bytes = len(encoded.encode("utf-8"))
        if batch and (len(batch) == _UPSERT_MAX_ROWS or size + 1 + row_bytes > _UPSERT_MAX_BYTES):
            yield "[" + ",".join(batch) + "]"
            batch = []
            size = 2
        batch.append(encoded)
        size += row_bytes + (1 if len(batch) > 1 else 0)
    if batch:
        yield "[" + ",".join(batch) + "]"


def stable_token(value: str) -> str:
    """An opaque key segment derived from the entire source identity."""
    return hashlib.sha256(value.encode()).hexdigest()


def note_regions_from_publication(
    items: list[dict[str, object]], note_groups: list[NotesGroup]
) -> list[NoteRegion]:
    """Combine structural groups with the existing exact note-body locators."""
    regions: list[NoteRegion] = [
        NoteGroupRegion(range=group.range, heading=group.heading, provenance=group.provenance)
        for group in note_groups
    ]
    for item in items:
        if item.get("kind") not in {"footnote", "endnote", "sidenote", "margin_note"}:
            continue
        if item.get("locator_status") != "exact":
            continue
        locator = _object_dict(item.get("locator"))
        if locator.get("type") not in {"epub_fragment_offsets", "web_text_offsets"}:
            continue
        fragment_id = UUID(str(locator["fragment_id"]))
        start = int(locator["start_offset"])
        end = int(locator["end_offset"])
        if start >= end:
            continue
        regions.append(
            NoteBodyRegion(
                range=NavigationTextRangeOut(
                    start=NavigationTextPointOut(fragment_id=fragment_id, offset=start),
                    end=NavigationTextPointOut(fragment_id=fragment_id, offset=end),
                )
            )
        )
    return regions


def read_note_regions(db: Session, media_id: UUID) -> list[NoteRegion]:
    """Read one publication's note evidence in the caller's transaction snapshot."""
    state = (
        db.execute(
            text("SELECT id, note_groups FROM reader_apparatus_states WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if state is None:
        raise ApiError(
            ApiErrorCode.E_READER_APPARATUS_STATE_MISSING, "Reader apparatus state is missing"
        )
    raw_groups = state["note_groups"]
    if not isinstance(raw_groups, list):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader note groups must be a list")
    groups = [NotesGroup.model_validate(group) for group in raw_groups]
    rows = (
        db.execute(
            text(
                """
            SELECT kind, locator, locator_status FROM reader_apparatus_items
            WHERE state_id = :state_id AND kind IN ('footnote', 'endnote', 'sidenote', 'margin_note')
            """
            ),
            {"state_id": state["id"]},
        )
        .mappings()
        .all()
    )
    return note_regions_from_publication([dict(row) for row in rows], groups)


def _read_state(db: Session, *, viewer_id: UUID, media_id: UUID) -> _ApparatusState:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = (
        db.execute(
            text("SELECT kind, processing_status, page_count FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .fetchone()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if str(media["kind"]) not in SUPPORTED_MEDIA_KINDS:
        return _ApparatusState(None, "unsupported", str(media["kind"]), None)
    if not is_document_status_ready(str(media["processing_status"])):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    state = (
        db.execute(
            text("SELECT id, status FROM reader_apparatus_states WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .fetchone()
    )
    if state is None:
        raise ApiError(
            ApiErrorCode.E_READER_APPARATUS_STATE_MISSING, "Reader apparatus state is missing"
        )
    return _ApparatusState(
        id=state["id"],
        status=cast(ReaderApparatusStatus, state["status"]),
        media_kind=str(media["kind"]),
        page_count=int(media["page_count"]) if media["page_count"] is not None else None,
    )


def get_media_apparatus(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderApparatusResponse:
    """Only reference/forward owners and untargeted orphans enter the map."""
    state = _read_state(db, viewer_id=viewer_id, media_id=media_id)
    if state.id is None:
        return ReaderApparatusResponse(media_id=media_id, status=state.status, items=[], edges=[])
    item_rows = db.execute(
        text(
            _OWNER_ITEMS_CTE
            + """
            SELECT item.id, item.stable_key, item.kind, item.label,
                   left(item.body_text, 601) AS body_text, NULL AS body_html_sanitized,
                   item.locator, item.locator_status, item.confidence, item.extraction_method,
                   jsonb_build_object('marker_id', item.source_ref->'marker_id') AS source_ref,
                   item.sort_key
            FROM reader_apparatus_items item JOIN owners ON owners.id = item.id
            ORDER BY CASE WHEN right(item.kind, 4) = '_ref'
                          OR item.id IN (SELECT from_item_id FROM forward_edges)
                     THEN 0 ELSE 1 END,
                     item.sort_key, item.stable_key
        """
        ),
        {"state_id": state.id},
        execution_options={"yield_per": 128},
    ).mappings()
    items = [_item_from_row(row) for row in item_rows]
    item_rows.close()
    # Keep the existing stable tie order: reference/forward owners, then orphans.
    items.sort(key=lambda item: item.sort_key)
    return ReaderApparatusResponse(
        media_id=media_id,
        status=state.status,
        items=items,
        edges=_read_edges(db, state_id=state.id),
    )


def _item_from_row(row: RowMapping) -> ReaderApparatusItem:
    item = ReaderApparatusItemOut(
        id=row["id"],
        resource_ref=f"reader_apparatus_item:{row['id']}",
        stable_key=str(row["stable_key"]),
        kind=row["kind"],
        label=row["label"],
        body_text=row["body_text"],
        body_html_sanitized=row["body_html_sanitized"],
        locator=cast(
            RetrievalLocator | None,
            retrieval_locator_json(_object_dict(row["locator"]) or None),
        ),
        locator_status=row["locator_status"],
        confidence=row["confidence"],
        extraction_method=str(row["extraction_method"]),
        source_ref=dict(row["source_ref"] or {}),
        sort_key=str(row["sort_key"]),
    )
    return ReaderApparatusItem(
        id=item.id,
        resource_ref=item.resource_ref,
        stable_key=item.stable_key,
        kind=item.kind,
        label=item.label,
        body_text=item.body_text,
        body_html_sanitized=item.body_html_sanitized,
        locator=item.locator,
        locator_status=item.locator_status,
        confidence=item.confidence,
        source_ref=item.source_ref,
        sort_key=item.sort_key,
    )


def _read_edges(
    db: Session, *, state_id: UUID, from_item_id: UUID | None = None
) -> list[ReaderApparatusEdge]:
    edges: list[ReaderApparatusEdge] = []
    edge_rows = db.execute(
        text(
            _OWNER_ITEMS_CTE
            + """
            SELECT edge.stable_key, edge.to_item_id,
                   source.stable_key AS from_stable_key,
                   target.stable_key AS to_stable_key,
                   edge.relation, edge.confidence, edge.extraction_method,
                   edge.source_ref, edge.sort_key
            FROM reader_apparatus_edges edge
            JOIN forward_edges forward_edge ON forward_edge.id = edge.id
            JOIN reader_apparatus_items source
              ON source.id = edge.from_item_id AND source.state_id = edge.state_id
            JOIN reader_apparatus_items target
              ON target.id = edge.to_item_id AND target.state_id = edge.state_id
            WHERE edge.state_id = :state_id
            """
            + (" AND edge.from_item_id = :from_item_id" if from_item_id is not None else "")
            + """
            ORDER BY edge.sort_key, edge.stable_key
            """
        ),
        {"state_id": state_id, "from_item_id": from_item_id},
        execution_options={"yield_per": 128},
    ).mappings()
    for row in edge_rows:
        edge = ReaderApparatusEdgeOut(
            stable_key=str(row["stable_key"]),
            from_stable_key=str(row["from_stable_key"]),
            to_stable_key=str(row["to_stable_key"]),
            relation=row["relation"],
            confidence=row["confidence"],
            extraction_method=str(row["extraction_method"]),
            source_ref=dict(row["source_ref"] or {}),
            sort_key=str(row["sort_key"]),
        )
        edges.append(
            ReaderApparatusEdge(
                from_stable_key=edge.from_stable_key,
                to_stable_key=edge.to_stable_key,
                to_item_id=row["to_item_id"],
                to_resource_ref=f"reader_apparatus_item:{row['to_item_id']}",
                relation=edge.relation,
                sort_key=edge.sort_key,
            )
        )
    edge_rows.close()
    edges.sort(key=lambda edge: edge.sort_key)
    return edges


def get_reader_apparatus_detail(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    item_id: UUID,
    expected_identity: str,
) -> ReaderApparatusDetailOut:
    """Read one owner's ordered complete targets in a read-only publication snapshot."""
    state = _read_state(db, viewer_id=viewer_id, media_id=media_id)
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None or expected_identity != f"g{generation}":
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
    if state.id is None or state.status not in ("ready", "partial"):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source reference not found")
    owner_kind = db.scalar(
        text(
            _OWNER_ITEMS_CTE
            + """
            SELECT item.kind FROM reader_apparatus_items item
            JOIN owners ON owners.id = item.id WHERE item.id = :item_id
        """
        ),
        {"state_id": state.id, "item_id": item_id},
    )
    if owner_kind is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source reference not found")
    target_ids = list(
        dict.fromkeys(
            edge.to_item_id for edge in _read_edges(db, state_id=state.id, from_item_id=item_id)
        )
    )
    if not target_ids and not str(owner_kind).endswith("_ref"):
        target_ids = [item_id]
    target_rows = db.execute(
        text("""
            SELECT id, stable_key, kind, label, body_text, body_html_sanitized,
                   locator, locator_status, confidence, extraction_method,
                   jsonb_build_object(
                       'format', source_ref->'format',
                       'package_href', source_ref->'package_href',
                       'target_href', source_ref->'target_href',
                       'target_id', source_ref->'target_id',
                       'marker_id', source_ref->'marker_id',
                       'fragment_idx', source_ref->'fragment_idx',
                       'document_href', source_ref->'document_href'
                   ) AS source_ref,
                   sort_key
            FROM reader_apparatus_items
            WHERE state_id = :state_id AND id = ANY(CAST(:target_ids AS uuid[]))
            ORDER BY array_position(CAST(:target_ids AS uuid[]), id)
        """),
        {"state_id": state.id, "target_ids": target_ids},
        execution_options={"yield_per": 128},
    ).mappings()
    targets = [_item_from_row(row) for row in target_rows]
    target_rows.close()
    _source_body_html(
        db, media_id=media_id, state_id=state.id, state_status=state.status, items=targets
    )
    previews = resource_items_out(
        db,
        viewer_id=viewer_id,
        refs=[ResourceRef("reader_apparatus_item", target.id) for target in targets],
    )
    fragment_indexes = {
        str(row.id): int(row.idx)
        for row in db.execute(
            text("SELECT id, idx FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    }
    targets_out: list[ReaderEvidenceSourceTargetOut] = []
    for target, preview in zip(targets, previews, strict=True):
        content: SourceContent
        if target.body_html_sanitized is not None:
            content = ReaderSourceHtmlOut(
                html_sanitized=target.body_html_sanitized, text=target.body_text or ""
            )
        elif state.media_kind == "pdf" and target.body_text:
            content = ReaderSourceTextOut(text=target.body_text)
        else:
            content = ReaderSourceUnavailableOut()
        targets_out.append(
            ReaderEvidenceSourceTargetOut(
                item=preview,
                stable_key=target.stable_key,
                apparatus_kind=target.kind,
                content=content,
                resolution=apparatus_resolution(
                    target,
                    media_id=media_id,
                    fragment_indexes=fragment_indexes,
                    page_count=state.page_count,
                ),
            )
        )
    return ReaderApparatusDetailOut(
        media_id=media_id,
        identity=f"g{generation}",
        reference_ref=f"reader_apparatus_item:{item_id}",
        targets=targets_out,
    )


def apparatus_resolution(
    item: ReaderApparatusItem,
    *,
    media_id: UUID,
    fragment_indexes: dict[str, int],
    page_count: int | None,
) -> ReaderEvidenceResolutionOut:
    locator = locator_json(item.locator)
    if locator is None:
        return ReaderEvidenceUnavailableOut(reason="Missing", sort_order_key=item.sort_key)
    if not locator_is_current_for_media(
        locator, media_id=media_id, fragment_indexes=fragment_indexes, page_count=page_count
    ):
        return ReaderEvidenceUnavailableOut(reason="Stale", sort_order_key=item.sort_key)
    return ReaderEvidenceResolvedOut(
        anchor=ReaderEvidenceAnchorOut(
            locator=cast(MediaRetrievalLocator, item.locator), passage_anchor_id=None
        ),
        order_key=order_key_from_locator(locator, fragment_indexes) or item.sort_key,
    )


def replace_media_apparatus(
    db: Session,
    *,
    media_id: UUID,
    items: list[dict[str, object]] | None = None,
    edges: list[dict[str, object]] | None = None,
    note_groups: list[NotesGroup],
    status: str | None = None,
) -> None:
    """Install one extraction's rows, keeping the id of every unchanged ``stable_key``.

    Saved connections, retrievals and view states key on the item UUID, so matched
    rows are updated in place and only rows this extraction no longer produces are
    deleted — with their dependents, and before the items they hang off.
    """
    old_ids = list(
        db.scalars(
            text("SELECT id FROM reader_apparatus_items WHERE media_id=:id"), {"id": media_id}
        )
    )
    items = items or []
    edges = edges or []
    if status is None:
        status = "ready" if items else "empty"
    _validate_replacement(status=status, items=items, edges=edges)

    if (
        db.scalar(
            text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    candidate_keys = [str(item["stable_key"]) for item in items]
    if len(candidate_keys) != len(set(candidate_keys)):
        raise ApiError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "Source notes have ambiguous identities; the previous publication was retained.",
        )
    _reconcile_items(db, media_id=media_id, items=items, edges=edges)
    item_keys = [str(item["stable_key"]) for item in items]
    edge_keys = [str(edge["stable_key"]) for edge in edges]
    if len(item_keys) != len(set(item_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus item keys must be unique")
    if len(edge_keys) != len(set(edge_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge keys must be unique")

    state_id = db.execute(
        text(
            """
            INSERT INTO reader_apparatus_states (media_id, status, note_groups)
            VALUES (:media_id, :status, :note_groups)
            ON CONFLICT (media_id) DO UPDATE SET
                status = EXCLUDED.status, note_groups = EXCLUDED.note_groups
            RETURNING id
            """
        ).bindparams(bindparam("note_groups", type_=JSONB)),
        {
            "media_id": media_id,
            "status": status,
            "note_groups": [group.model_dump(mode="json") for group in note_groups],
        },
    ).scalar_one()

    item_rows = []
    for item in items:
        locator = (
            retrieval_locator_json(_object_dict(item.get("locator")))
            if item.get("locator")
            else None
        )
        item_rows.append(
            {
                "stable_key": str(item["stable_key"]),
                "kind": item["kind"],
                "label": item.get("label"),
                "body_text": item.get("body_text"),
                "body_html_sanitized": item.get("body_html_sanitized"),
                "locator": locator,
                "locator_status": item.get("locator_status", "exact" if locator else "missing"),
                "confidence": item["confidence"],
                "extraction_method": item["extraction_method"],
                "source_ref": item.get("source_ref") or {},
                "sort_key": item["sort_key"],
            }
        )
    ids_by_key: dict[str, UUID] = {}
    for payload in _upsert_json_batches(item_rows):
        for row in db.execute(
            _ITEM_UPSERT,
            {"media_id": media_id, "state_id": state_id, "items": payload},
        ):
            ids_by_key[row.stable_key] = row.id

    db.execute(
        text(
            """
            DELETE FROM reader_apparatus_edges
            WHERE media_id = :media_id AND stable_key <> ALL(CAST(:keys AS text[]))
            """
        ),
        {"media_id": media_id, "keys": edge_keys},
    )
    edge_rows = []
    for edge in edges:
        from_key = str(edge["from_stable_key"])
        to_key = str(edge["to_stable_key"])
        if from_key not in ids_by_key or to_key not in ids_by_key:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge points to missing item")
        edge_rows.append(
            {
                "stable_key": str(edge["stable_key"]),
                "from_item_id": str(ids_by_key[from_key]),
                "to_item_id": str(ids_by_key[to_key]),
                "relation": edge["relation"],
                "confidence": edge["confidence"],
                "extraction_method": edge["extraction_method"],
                "source_ref": edge.get("source_ref") or {},
                "sort_key": edge["sort_key"],
            }
        )
    for payload in _upsert_json_batches(edge_rows):
        db.execute(
            _EDGE_UPSERT,
            {"media_id": media_id, "state_id": state_id, "edges": payload},
        )

    removed = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                """
                SELECT id FROM reader_apparatus_items
                WHERE media_id = :media_id AND stable_key <> ALL(CAST(:keys AS text[]))
                """
            ),
            {"media_id": media_id, "keys": item_keys},
        ).all()
    ]
    if removed:
        _delete_apparatus_item_dependents(db, removed)
        db.execute(
            text("DELETE FROM reader_apparatus_items WHERE id = ANY(:ids)"), {"ids": removed}
        )
    db.flush()
    new_ids = list(
        db.scalars(
            text("SELECT id FROM reader_apparatus_items WHERE media_id=:id"), {"id": media_id}
        )
    )
    projection.refresh(db, "reader_apparatus_item", [*old_ids, *new_ids])


def delete_media_apparatus(db: Session, media_id: UUID) -> None:
    item_ids = [
        UUID(str(row))
        for row in db.execute(
            text("SELECT id FROM reader_apparatus_items WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).scalars()
    ]
    _delete_apparatus_item_dependents(db, item_ids)
    for table in ("reader_apparatus_edges", "reader_apparatus_items", "reader_apparatus_states"):
        db.execute(text(f"DELETE FROM {table} WHERE media_id = :media_id"), {"media_id": media_id})
    db.flush()
    projection.refresh(db, "reader_apparatus_item", item_ids)


def _delete_apparatus_item_dependents(db: Session, item_ids: list[UUID]) -> None:
    if not item_ids:
        return
    delete_edges_for_deleted_resources(
        db,
        refs=[ResourceRef(scheme="reader_apparatus_item", id=item_id) for item_id in item_ids],
    )
    db.execute(
        text(
            """
            DELETE FROM message_retrievals
            WHERE result_type = 'reader_apparatus_item' AND source_id = ANY(:source_ids)
            """
        ),
        {"source_ids": [str(item_id) for item_id in item_ids]},
    )
    db.execute(
        text(
            """
            DELETE FROM resource_versions
            WHERE resource_scheme = 'reader_apparatus_item' AND resource_id = ANY(:ids)
            """
        ),
        {"ids": item_ids},
    )
    db.execute(
        text(
            """
            DELETE FROM resource_view_states
            WHERE target_scheme = 'reader_apparatus_item' AND target_id = ANY(:ids)
            """
        ),
        {"ids": item_ids},
    )


def _validate_replacement(
    *, status: str, items: list[dict[str, object]], edges: list[dict[str, object]]
) -> None:
    if status not in {"ready", "empty", "partial", "unsupported", "failed"}:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Invalid reader apparatus status")
    if status in {"empty", "unsupported", "failed"} and (items or edges):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Terminal empty apparatus states cannot carry rows")
    if status in {"ready", "partial"} and not items:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus state needs items")


def _object_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}


def _source_identity(item: Mapping[str, Any]) -> tuple[str, ...] | None:
    source = dict(item.get("source_ref") or {})
    marker = str(item["kind"]).endswith("_ref")
    role = "marker" if marker else "target"
    document = str(source.get("package_href") or ("web:" + str(source.get("fragment_idx", 0))))
    authored = source.get("marker_id" if marker else "target_id")
    if _object_dict(source.get("identity")).get("kind") == "Anonymous":
        authored = None
    target = (
        str(
            (source.get("target_ref") if source.get("package_href") else None)
            or source.get("target_id")
            or ""
        )
        if marker
        else ""
    )
    if source.get("target_ids"):
        target = json.dumps(source["target_ids"])
    if authored:
        return role, document, str(authored), target
    if source.get("format") == "pdf":
        return (
            role,
            "pdf",
            str(source.get("named_destination")) if marker else "",
            json.dumps(
                source.get("source_rect") if marker else source.get("reference_block"),
                sort_keys=True,
            ),
            str(source.get("page_number") if marker else source.get("target_page_number")),
        )
    identity = source.get("identity")
    if isinstance(identity, dict):
        return role, document, json.dumps(identity, sort_keys=True), target
    return None


def match_apparatus_source_items(
    old: Sequence[Mapping[str, Any]], items: Sequence[Mapping[str, object]]
) -> dict[str, str]:
    """Match only unique authored, contextual, or unchanged exact source occurrences."""
    by_identity: dict[tuple[str, ...], list[Mapping[str, Any]]] = defaultdict(list)
    by_context: dict[tuple[str, str, str], list[Mapping[str, Any]]] = defaultdict(list)
    by_locator: dict[tuple[str, str, str, str], list[Mapping[str, Any]]] = defaultdict(list)
    for row in old:
        if identity := _source_identity(row):
            by_identity[identity].append(row)
        if context := _context_key(row):
            by_context[context].append(row)
        if locator := _locator_key(row):
            by_locator[locator].append(row)
    identities = Counter(_source_identity(item) for item in items)
    contexts = Counter(key for item in items if (key := _context_key(item)))
    locators = Counter(key for item in items if (key := _locator_key(item)))
    matches: dict[str, str] = {}
    claimed: set[str] = set()
    for item in items:
        identity = _source_identity(item)
        candidates = by_identity.get(identity, []) if identity and identities[identity] == 1 else []
        source = _object_dict(item.get("source_ref"))
        own_id = source.get("marker_id" if str(item["kind"]).endswith("_ref") else "target_id")
        if _object_dict(source.get("identity")).get("kind") == "Anonymous":
            own_id = None
        if not candidates and not own_id and (context := _context_key(item)):
            if contexts[context] == 1:
                candidates = by_context.get(context, [])
        if not candidates and (locator := _locator_key(item)) and locators[locator] == 1:
            candidates = by_locator.get(locator, [])
        if len(candidates) != 1 or str(candidates[0]["kind"]) != str(item["kind"]):
            continue
        old_key = str(candidates[0]["stable_key"])
        if old_key not in claimed:
            matches[str(item["stable_key"])] = old_key
            claimed.add(old_key)
    return matches


def _context_key(row: Mapping[str, Any]) -> tuple[str, str, str] | None:
    source = _object_dict(row.get("source_ref"))
    if not (context := source.get("quote_context")):
        return None
    document = str(source.get("package_href") or source.get("document_href") or "web")
    return str(row["kind"]), document, json.dumps(context, sort_keys=True)


def _locator_key(row: Mapping[str, Any]) -> tuple[str, str, str, str] | None:
    if row.get("locator_status") != "exact" or not row.get("locator"):
        return None
    source = _object_dict(row.get("source_ref"))
    target = source.get("target_ref") or source.get("target_id") or source.get("target_ids")
    return (
        str(row["kind"]),
        json.dumps(row["locator"], sort_keys=True),
        str(row.get("body_text")),
        json.dumps(target, sort_keys=True),
    )


def _reconcile_items(
    db: Session,
    *,
    media_id: UUID,
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
) -> None:
    """Keep occurrence identities by source correspondence, never by extraction order."""
    old = [
        dict(row)
        for row in (
            db.execute(
                text(
                    "SELECT id, stable_key, kind, body_text, locator, locator_status, source_ref"
                    " FROM reader_apparatus_items WHERE media_id=:id"
                ),
                {"id": media_id},
            )
            .mappings()
            .all()
        )
    ]
    matches = match_apparatus_source_items(old, items)
    old_by_key = {str(row["stable_key"]): row for row in old}
    old_keys = {str(row["stable_key"]) for row in old}
    retained: set[UUID] = set()
    replacements: dict[str, str] = {}
    for item in items:
        matched_key = matches.get(str(item["stable_key"]))
        if matched_key is not None:
            row = old_by_key[matched_key]
            retained.add(row["id"])
            replacements[str(item["stable_key"])] = str(row["stable_key"])
            item["stable_key"] = str(row["stable_key"])
        elif str(item["stable_key"]) in old_keys:
            previous_key = str(item["stable_key"])
            item["stable_key"] = f"item:{uuid4()}"
            replacements[previous_key] = str(item["stable_key"])
    removed = [row["id"] for row in old if row["id"] not in retained]
    if removed and db.scalar(
        text("""
            SELECT EXISTS (
                SELECT 1 FROM resource_edges
                WHERE (source_scheme='reader_apparatus_item' AND source_id=ANY(:ids))
                   OR (target_scheme='reader_apparatus_item' AND target_id=ANY(:ids))
                UNION ALL SELECT 1 FROM message_retrievals
                WHERE result_type='reader_apparatus_item' AND source_id=ANY(:strings)
                UNION ALL SELECT 1 FROM resource_view_states
                WHERE target_scheme='reader_apparatus_item' AND target_id=ANY(:ids)
                UNION ALL SELECT 1 FROM resource_versions
                WHERE resource_scheme='reader_apparatus_item' AND resource_id=ANY(:ids)
            )
        """),
        {"ids": removed, "strings": [str(value) for value in removed]},
    ):
        raise ApiError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "Source refresh cannot preserve a referenced note. The previous publication was retained.",
        )
    for edge in edges:
        edge["from_stable_key"] = replacements.get(
            str(edge["from_stable_key"]), str(edge["from_stable_key"])
        )
        edge["to_stable_key"] = replacements.get(
            str(edge["to_stable_key"]), str(edge["to_stable_key"])
        )
        edge["stable_key"] = f"{edge['from_stable_key']}->{edge['to_stable_key']}"
    replacements = {key: value for key, value in replacements.items() if key != value}
    if replacements:
        for fragment in db.execute(
            text("SELECT id, html_sanitized FROM fragments WHERE media_id=:id"), {"id": media_id}
        ).mappings():
            html = str(fragment["html_sanitized"])
            # Keys contain no HTML metacharacters. Only our stamped attribute changes;
            # reserializing the source DOM could change its canonical byte contract.
            updated = re.sub(
                r'(data-reader-apparatus-item-id=")([^"]+)(")',
                lambda match: match[1] + replacements.get(match[2], match[2]) + match[3],
                html,
            )
            if updated != html:
                db.execute(
                    text("UPDATE fragments SET html_sanitized=:html WHERE id=:id"),
                    {"html": updated, "id": fragment["id"]},
                )


def _source_body_html(
    db: Session,
    *,
    media_id: UUID,
    state_id: UUID,
    state_status: str,
    items: Sequence[ReaderApparatusItem],
) -> None:
    """Bind selected bodies against all publication aliases with the original raw gates."""
    if not any(item.body_html_sanitized is not None for item in items):
        return
    fragments = (
        db.execute(
            text("""
        SELECT f.id, f.idx, s.package_href FROM fragments f
        LEFT JOIN epub_fragment_sources s ON s.fragment_id=f.id
        WHERE f.media_id=:id
    """),
            {"id": media_id},
        )
        .mappings()
        .all()
    )
    by_path = {str(row["package_href"]): row for row in fragments if row["package_href"]}
    by_index = {row["idx"]: row for row in fragments}
    fragment_ids_by_path = {path: row["id"] for path, row in by_path.items()}
    fragment_ids = {str(row["id"]) for row in fragments}
    anchors: dict[str, Any] = {}
    source_locations: dict[str, str] = {}
    aliases = db.execute(
        text("""
            SELECT id, stable_key, kind, locator_status,
                   locator->>'fragment_id' AS binding_fragment_id,
                   locator->>'media_id' AS binding_media_id,
                   locator->>'start_offset' AS binding_start_offset,
                   jsonb_build_object(
                       'format', source_ref->'format',
                       'package_href', source_ref->'package_href',
                       'target_href', source_ref->'target_href',
                       'target_id', source_ref->'target_id',
                       'marker_id', source_ref->'marker_id',
                       'fragment_idx', source_ref->'fragment_idx'
                   ) AS source_ref
            FROM reader_apparatus_items WHERE state_id = :state_id
            ORDER BY sort_key, stable_key
        """),
        {"state_id": state_id},
        execution_options={"yield_per": 128},
    ).mappings()
    for alias in aliases:
        if (
            alias["binding_start_offset"] is None
            or alias["binding_fragment_id"] not in fragment_ids
        ):
            continue
        href = route_for_visible_apparatus_item(
            media_id=media_id,
            item_id=alias["id"],
            stable_key=str(alias["stable_key"]),
            locator_present=True,
            locator_status=alias["locator_status"],
            locator_current=state_status in {"ready", "partial"}
            and alias["binding_media_id"] == str(media_id),
        )
        if href is None:
            continue
        source = dict(alias["source_ref"])
        element_id = (
            source.get("marker_id")
            if str(alias["kind"]).endswith("_ref")
            else source.get("target_id")
        )
        if element_id:
            if source.get("format") == "xhtml":
                document = str(source.get("package_href") or source.get("target_href") or "")
            elif source.get("format") == "html":
                source_index = source.get("fragment_idx")
                owner = by_index.get(source_index) if type(source_index) is int else None
                if owner is None or str(owner["id"]) != alias["binding_fragment_id"]:
                    continue
                document = str(source_index)
            else:
                continue
            source_locations[f"{document}#{element_id}"] = href
    aliases.close()
    for item in items:
        if item.body_html_sanitized is None:
            continue
        root = parse_html_document(item.body_html_sanitized)
        source = item.source_ref
        is_epub = source.get("format") == "xhtml"
        source_index = source.get("fragment_idx")
        article_fragment = (
            by_index.get(source_index)
            if source.get("format") == "html" and type(source_index) is int
            else None
        )
        if is_epub:
            bound_fragment_ids = fragment_ids_by_path
        elif article_fragment is not None:
            bound_fragment_ids = {"": article_fragment["id"]}
        else:
            bound_fragment_ids = {}
        package_path = (
            str(source.get("package_href") or source.get("target_href") or "") if is_epub else ""
        )
        for link in root.xpath("//a[@href]"):
            raw = str(link.get("href"))
            parsed = urlsplit(raw)
            if parsed.query and not parsed.path:
                continue
            internal = (
                not parsed.scheme and not parsed.netloc
                if is_epub
                else (
                    source.get("format") == "html"
                    and bool(parsed.fragment)
                    and (
                        raw.startswith("#")
                        or raw.split("#", 1)[0]
                        == str(source.get("document_href") or "").split("#", 1)[0]
                    )
                )
            )
            if not internal:
                continue
            path = parsed.path or package_path
            anchor = unquote(parsed.fragment)
            destination = source_locations.get(f"{path if is_epub else source_index}#{anchor}")
            fragment = by_path.get(path) if is_epub else article_fragment
            if destination is None and fragment is not None:
                fragment_key = str(fragment["id"])
                if fragment_key not in anchors:
                    html = db.execute(
                        text("SELECT html_sanitized FROM fragments WHERE id = :id"),
                        {"id": fragment["id"]},
                    ).scalar_one()
                    anchors[fragment_key] = canonicalize_structure(html)
                structure = anchors[fragment_key]
                index = structure.anchors.get(anchor) if anchor else None
                if not anchor or index is not None:
                    if not is_epub:
                        link.set("href", f"#{parsed.fragment}")
                    bind_epub_fragment_link(
                        link, href_path=package_path, fragment_ids_by_path=bound_fragment_ids
                    )
                    link.attrib.pop("target", None)
                    continue
            if destination is not None:
                link.set("href", destination)
                link.attrib.pop("target", None)
            else:
                link.attrib.pop("href", None)
        body = root.body
        if body is not None:
            item.body_html_sanitized = inner_html(body)
