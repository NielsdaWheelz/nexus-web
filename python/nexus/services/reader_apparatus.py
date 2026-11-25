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

import gzip
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Callable, Generator, Iterable, Iterator, Mapping, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID, uuid4

from pydantic import JsonValue
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError, ResourceLimitError
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
    ReaderEvidenceSourceItemOut,
    ReaderEvidenceSourceTargetOut,
    ReaderEvidenceUnavailableOut,
    ReaderSourceHtmlOut,
    ReaderSourceTextOut,
    ReaderSourceUnavailableOut,
    SourceContent,
)
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    MediaRetrievalLocator,
    RetrievalLocator,
    WebTextOffsetsLocator,
    retrieval_locator_json,
)
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.capabilities import is_document_status_ready
from nexus.services.epub_read import bind_epub_fragment_link
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.media_text_scope import (
    MediaTextScope,
    read_media_text_scope,
    text_scope_rows_sql,
)
from nexus.services.reader_locations import (
    locator_is_current_for_media,
    locator_json,
    order_key_from_locator,
)
from nexus.services.reader_publication import (
    read_publication_generation,
    read_ready_publication_generation,
)
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.items import passage_link_revision, source_attributions
from nexus.services.resource_items.locations import media_passages
from nexus.services.resource_items.routing import (
    activations_from_resolved_passages,
    route_for_visible_apparatus_item,
)
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
    """Visible source-reference owners, read once inside the apparatus scope."""

    status: ReaderApparatusStatus
    items: Iterable[ReaderApparatusItem]


@dataclass(frozen=True, slots=True)
class _ApparatusState:
    id: UUID | None
    status: ReaderApparatusStatus
    media_kind: str
    page_count: int | None
    scope: MediaTextScope | None = None


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


def _upsert_json_batches(rows: Iterable[Mapping[str, object]]) -> Iterator[str]:
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


def iter_publication_note_regions(
    items: Iterable[Mapping[str, object]], note_groups: list[NotesGroup]
) -> Iterator[NoteRegion]:
    """Combine structural groups with the existing exact note-body locators."""
    for group in note_groups:
        yield NoteGroupRegion(range=group.range, heading=group.heading, provenance=group.provenance)
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
        yield NoteBodyRegion(
            range=NavigationTextRangeOut(
                start=NavigationTextPointOut(fragment_id=fragment_id, offset=start),
                end=NavigationTextPointOut(fragment_id=fragment_id, offset=end),
            )
        )


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
    with db.execute(
        text("""
            SELECT kind, locator, locator_status FROM reader_apparatus_items
            WHERE state_id = :state_id AND kind IN ('footnote', 'endnote', 'sidenote', 'margin_note')
            """),
        {"state_id": state["id"]},
        execution_options={"yield_per": _UPSERT_MAX_ROWS},
    ).mappings() as rows:
        return list(iter_publication_note_regions((dict(row) for row in rows), groups))


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
    scope = read_media_text_scope(db, media_id) if str(media["kind"]) == "text_part" else None
    source_id = scope.source_media_id if scope is not None else media_id
    if str(media["kind"]) not in SUPPORTED_MEDIA_KINDS and scope is None:
        return _ApparatusState(None, "unsupported", str(media["kind"]), None)
    if not is_document_status_ready(str(media["processing_status"])):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    state = (
        db.execute(
            text("SELECT id, status FROM reader_apparatus_states WHERE media_id = :media_id"),
            {"media_id": source_id},
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
        media_kind=scope.source_format if scope is not None else str(media["kind"]),
        scope=scope,
        page_count=int(media["page_count"]) if media["page_count"] is not None else None,
    )


@contextmanager
def read_media_apparatus(
    db: Session, viewer_id: UUID, media_id: UUID
) -> Iterator[ReaderApparatusResponse]:
    """Borrow the caller's snapshot for the ordered owner rows."""
    state = _read_state(db, viewer_id=viewer_id, media_id=media_id)
    with closing(_media_apparatus(db, state=state)) as items:
        yield ReaderApparatusResponse(status=state.status, items=items)


def note_reference_for_locator(
    db: Session, *, viewer_id: UUID, media_id: UUID, locator: RetrievalLocator
) -> UUID | None:
    """The first retained in-body reference disclosing this exact outside-body note."""
    if not isinstance(locator, (EpubFragmentOffsetsLocator, WebTextOffsetsLocator)):
        return None
    part = db.execute(
        text("""SELECT part.source_media_id,part.source_generation,state.id AS apparatus_state
            FROM media_parts part LEFT JOIN reader_apparatus_states state
                ON state.media_id=part.source_media_id WHERE part.media_id=:id"""),
        {"id": media_id},
    ).first()
    if part is None:
        return None
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if read_ready_publication_generation(db, media_id=media_id) is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    if (
        read_ready_publication_generation(db, media_id=part.source_media_id)
        != part.source_generation
    ):
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "source publication changed")
    if part.apparatus_state is None:
        raise ApiError(
            ApiErrorCode.E_READER_APPARATUS_STATE_MISSING, "Reader apparatus state is missing"
        )
    if str(locator.media_id) != str(part.source_media_id):
        return None
    body = text_scope_rows_sql("SELECT CAST(:reading AS uuid) AS media_id")
    return db.scalar(
        text(f"""
            WITH body AS ({body})
            SELECT marker.id
            FROM body
            JOIN reader_apparatus_items marker ON marker.media_id=body.source_media_id
                AND marker.locator_status='exact'
                AND marker.locator->>'type' IN ('web_text_offsets','epub_fragment_offsets')
                AND marker.locator->>'media_id'=body.source_media_id::text
                AND marker.locator->>'fragment_id'=body.fragment_id::text
                AND (marker.locator->>'start_offset')::integer>=body.start_offset
                AND (marker.locator->>'end_offset')::integer<=body.end_offset
            JOIN reader_apparatus_edges edge ON edge.from_item_id=marker.id
                AND edge.media_id=marker.media_id
            JOIN reader_apparatus_items target ON target.id=edge.to_item_id
                AND target.media_id=marker.media_id
            WHERE marker.kind IN ('footnote_ref','endnote_ref','sidenote_ref',
                    'margin_note_ref','bibliography_ref')
              AND ((edge.relation='points_to_note' AND target.kind='footnote')
                OR (edge.relation='points_to_endnote' AND target.kind='endnote')
                OR (edge.relation='points_to_sidenote' AND target.kind='sidenote')
                OR (edge.relation='points_to_margin_note' AND target.kind='margin_note')
                OR (edge.relation='cites_bibliography_entry' AND target.kind='bibliography_entry'))
              AND target.locator_status='exact'
              AND target.locator->>'type' IN ('web_text_offsets','epub_fragment_offsets')
              AND target.locator->>'media_id'=body.source_media_id::text
              AND target.locator->>'fragment_id'=:fragment
              AND (target.locator->>'start_offset')::integer<=:start
              AND (target.locator->>'end_offset')::integer>=:end
              AND NOT EXISTS (SELECT 1 FROM body bounded
                  WHERE bounded.fragment_id::text=:fragment
                    AND bounded.start_offset<=:start AND bounded.end_offset>=:end)
            ORDER BY body.fragment_idx,(marker.locator->>'start_offset')::integer,
                (marker.locator->>'end_offset')::integer,marker.stable_key LIMIT 1
        """),
        {
            "reading": media_id,
            "fragment": str(locator.fragment_id),
            "start": locator.start_offset,
            "end": locator.end_offset,
        },
    )


def _media_apparatus(db: Session, *, state: _ApparatusState) -> Generator[ReaderApparatusItem]:
    if state.id is None:
        return
    with db.execute(
        text(
            _OWNER_ITEMS_CTE
            + """
            SELECT item.id, item.stable_key, item.kind, item.label,
                   left(item.body_text, 601) AS body_text, NULL AS body_html_sanitized,
                   item.locator, item.locator_status, item.confidence, item.extraction_method,
                   jsonb_build_object('marker_id', item.source_ref->'marker_id') AS source_ref,
                   item.sort_key
            FROM reader_apparatus_items item JOIN owners ON owners.id = item.id
            ORDER BY item.sort_key COLLATE "C",
                     CASE WHEN right(item.kind, 4) = '_ref'
                          OR item.id IN (SELECT from_item_id FROM forward_edges)
                     THEN 0 ELSE 1 END,
                     item.stable_key
        """
        ),
        {"state_id": state.id},
        execution_options={"yield_per": 128},
    ).mappings() as item_rows:
        for row in item_rows:
            if state.scope is None or row["id"] in state.scope.permitted_apparatus:
                yield _item_from_row(row)


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
    if generation is None:
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
    if expected_identity != f"g{generation}":
        # Only web articles can add a viewer-specific X manifest to this generation.
        if state.scope is not None or state.media_kind != "web_article":
            raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
        from nexus.services.reader_document import read_reader_document

        if read_reader_document(db, viewer_id, media_id).identity != expected_identity:
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
    if owner_kind is None or (
        state.scope is not None and item_id not in state.scope.permitted_apparatus
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source reference not found")
    target_ids = list(
        dict.fromkeys(
            edge.to_item_id for edge in _read_edges(db, state_id=state.id, from_item_id=item_id)
        )
    )
    if not target_ids and not str(owner_kind).endswith("_ref"):
        target_ids = [item_id]
    if state.scope is not None:
        target_ids = [id for id in target_ids if id in state.scope.permitted_apparatus]
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
    source_media_id = state.scope.source_media_id if state.scope is not None else media_id
    _source_body_html(
        db, media_id=source_media_id, state_id=state.id, state_status=state.status, items=targets
    )
    if state.scope is not None:
        _bound_scope_body_html(db, scope=state.scope, targets=targets)
    reading_ref = ResourceRef("media", media_id)
    refs = [ResourceRef("reader_apparatus_item", target.id) for target in targets]
    passages = media_passages(
        db,
        viewer_id=viewer_id,
        refs=refs,
        reading_media_ids={ref.uri: media_id for ref in refs},
        include_excerpts=False,
    )
    activations = activations_from_resolved_passages(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris=frozenset(),
        scoped=passages,
    )
    attribution = (
        source_attributions(db, viewer_id=viewer_id, refs=[reading_ref]).get(reading_ref.uri)
        if targets
        else None
    )
    can_read_original = state.scope is None or (
        bool(targets) and can_read_media(db, viewer_id, source_media_id)
    )
    fragment_indexes = {
        str(row.id): int(row.idx)
        for row in db.execute(
            text("SELECT id, idx FROM fragments WHERE media_id = :media_id"),
            {"media_id": source_media_id},
        )
    }
    targets_out: list[ReaderEvidenceSourceTargetOut] = []
    for target in targets:
        content: SourceContent
        if target.body_html_sanitized is not None:
            content = ReaderSourceHtmlOut(
                html_sanitized=target.body_html_sanitized, text=target.body_text or ""
            )
        elif state.media_kind == "pdf" and target.body_text:
            content = ReaderSourceTextOut(text=target.body_text)
        else:
            content = ReaderSourceUnavailableOut()
        activation = activations[target.resource_ref]
        passage = passages.get(target.resource_ref)
        source = attribution if activation.resource_ref == reading_ref.uri else None
        if source is not None and can_read_original and target.label:
            source = source.model_copy(update={"location_label": target.label})
        targets_out.append(
            ReaderEvidenceSourceTargetOut(
                item=ReaderEvidenceSourceItemOut(
                    ref=target.resource_ref,
                    action_ref=activation.resource_ref,
                    label=target.label or target.kind.replace("_", " "),
                    activation=activation,
                    source=source,
                    link_revision=passage_link_revision(
                        passage.owner, passage.quote, passage.locator
                    )
                    if passage is not None
                    else None,
                ),
                stable_key=target.stable_key,
                apparatus_kind=target.kind,
                content=content,
                resolution=apparatus_resolution(
                    target,
                    media_id=source_media_id,
                    fragment_indexes=fragment_indexes,
                    page_count=state.page_count,
                ),
            )
        )
    return ReaderApparatusDetailOut(
        media_id=media_id,
        identity=expected_identity,
        reference_ref=f"reader_apparatus_item:{item_id}",
        targets=targets_out,
    )


def read_scoped_apparatus_bodies(db: Session, scope: MediaTextScope) -> list[ReaderApparatusItem]:
    """Complete admitted note bodies for an already-authorized reading scope."""
    state = db.execute(
        text("SELECT id,status FROM reader_apparatus_states WHERE media_id=:id"),
        {"id": scope.source_media_id},
    ).one()
    rows = db.execute(
        text("""
        SELECT id,stable_key,kind,label,body_text,body_html_sanitized,locator,locator_status,
               confidence,extraction_method,source_ref,sort_key
        FROM reader_apparatus_items WHERE state_id=:state AND id=ANY(:ids)
        ORDER BY sort_key,stable_key
    """),
        {"state": state.id, "ids": list(scope.permitted_apparatus)},
    ).mappings()
    items = [_item_from_row(row) for row in rows]
    _source_body_html(
        db,
        media_id=scope.source_media_id,
        state_id=state.id,
        state_status=state.status,
        items=items,
    )
    _bound_scope_body_html(db, scope=scope, targets=items)
    return items


def _bound_scope_body_html(
    db: Session, *, scope: MediaTextScope, targets: Sequence[ReaderApparatusItem]
) -> None:
    source_media_id, media_id = scope.source_media_id, scope.reading_media_id
    intervals = {part.fragment_id: part for part in scope.fragment_intervals}
    anchor_offsets: dict[UUID, dict[str, int]] = {}
    permitted = {
        row.id: row
        for row in db.execute(
            text("SELECT id,locator,source_ref FROM reader_apparatus_items WHERE id=ANY(:ids)"),
            {"ids": list(scope.permitted_apparatus)},
        )
    }
    for target in targets:
        if target.body_html_sanitized is None:
            continue
        root = parse_html_document(target.body_html_sanitized)
        for node in root.iter():
            for attr, value in list(node.attrib.items()):
                node.set(
                    attr,
                    value.replace(
                        f"/media/{source_media_id}/assets/", f"/media/{media_id}/assets/"
                    ),
                )
            destination = node.get("data-nexus-fragment-id")
            if destination is not None:
                fragment_id = UUID(destination)
                interval = intervals.get(fragment_id)
                anchor = node.get("data-nexus-anchor-id")
                allowed = interval is not None
                if interval is not None and anchor is not None:
                    if fragment_id not in anchor_offsets:
                        html = db.scalar(
                            text("SELECT html_sanitized FROM fragments WHERE id=:id"),
                            {"id": fragment_id},
                        )
                        structure = canonicalize_structure(html) if html is not None else None
                        anchor_offsets[fragment_id] = (
                            {
                                name: structure.elements[index].start_offset
                                for name, index in structure.anchors.items()
                            }
                            if structure is not None
                            else {}
                        )
                    offset = anchor_offsets[fragment_id].get(anchor)
                    allowed = (
                        offset is not None and interval.start_offset <= offset < interval.end_offset
                    )
                if not allowed:
                    for attr in ("href", "data-nexus-fragment-id", "data-nexus-anchor-id"):
                        node.attrib.pop(attr, None)
            href = node.get("href")
            if href and urlsplit(href).path == f"/media/{source_media_id}":
                ids = parse_qs(urlsplit(href).query).get("apparatus_id", [])
                binding = permitted.get(UUID(ids[0])) if len(ids) == 1 else None
                if binding is None:
                    node.attrib.pop("href", None)
                    continue
                locator = binding.locator
                node.set("href", "#")
                if (
                    locator is not None
                    and locator.get("type") in ("web_text_offsets", "epub_fragment_offsets")
                    and scope.contains(
                        UUID(locator["fragment_id"]), locator["start_offset"], locator["end_offset"]
                    )
                ):
                    node.set("data-nexus-fragment-id", locator["fragment_id"])
                    anchor = binding.source_ref.get("marker_id") or binding.source_ref.get(
                        "target_id"
                    )
                    if anchor:
                        node.set("data-nexus-anchor-id", anchor)
                    node.attrib.pop("data-reader-apparatus-item-id", None)
                else:
                    node.set("data-reader-apparatus-item-id", str(binding.id))
        body = root.body if root.body is not None else root
        target.body_html_sanitized = inner_html(body)


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


@dataclass(frozen=True)
class ApparatusOutput:
    """Repeatable logical rows in stable-key order within the producer's scope."""

    status: str
    items: Callable[[], Iterator[dict[str, object]]]
    edges: Callable[[], Iterator[dict[str, object]]]
    note_groups: list[dict[str, object]]


@dataclass(frozen=True)
class ApparatusCandidate:
    output: ApparatusOutput
    _replacements: dict[str, str]


@dataclass(frozen=True, slots=True)
class ApparatusMatch:
    """Source correspondence keys without retaining the underlying body or provenance."""

    stable_key: str
    kind: str
    identity: bytes | None
    context: bytes | None
    locator: bytes | None
    allow_context: bool


def _match_key(value: tuple[str, ...] | None) -> bytes | None:
    if value is None:
        return None
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).digest()


def _apparatus_match(item: Mapping[str, Any]) -> ApparatusMatch:
    kind = str(item["kind"])
    source = _object_dict(item.get("source_ref"))
    own_id = source.get("marker_id" if kind.endswith("_ref") else "target_id")
    anonymous = _object_dict(source.get("identity")).get("kind") == "Anonymous"
    return ApparatusMatch(
        str(item["stable_key"]),
        kind,
        _match_key(_source_identity(item)),
        _match_key(_context_key(item)),
        _match_key(_locator_key(item)),
        not own_id or anonymous,
    )


def _apparatus_correspondence_items(
    items: Iterable[Mapping[str, object]],
) -> list[ApparatusMatch]:
    return [_apparatus_match(item) for item in items]


def _apparatus_item_row(item: Mapping[str, object], key: str) -> dict[str, object]:
    locator = retrieval_locator_json(_object_dict(item["locator"])) if item.get("locator") else None
    return {
        "stable_key": key,
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


def _apparatus_edge_row(
    edge: Mapping[str, object], replacements: Mapping[str, str] | None = None
) -> dict[str, object]:
    from_key, to_key = str(edge["from_stable_key"]), str(edge["to_stable_key"])
    key = str(edge["stable_key"])
    if replacements is not None:
        from_key = replacements.get(from_key, from_key)
        to_key = replacements.get(to_key, to_key)
        key = f"{from_key}->{to_key}"
    return {
        "stable_key": key,
        "from_stable_key": from_key,
        "to_stable_key": to_key,
        "relation": edge["relation"],
        "confidence": edge["confidence"],
        "extraction_method": edge["extraction_method"],
        "source_ref": edge.get("source_ref") or {},
        "sort_key": edge["sort_key"],
    }


def stage_apparatus_output(
    directory: Path,
    *,
    item_rows: Callable[[], Iterator[Mapping[str, object]]],
    edges: Iterable[Mapping[str, object]],
    note_groups: Sequence[NotesGroup],
    previous_items: Sequence[ApparatusMatch],
) -> ApparatusCandidate:
    """Normalize and sort the operator's candidate without a full graph in memory."""
    items = _apparatus_correspondence_items(item_rows())
    status = "ready" if items else "empty"
    edges = iter(edges)
    if not items:
        _validate_replacement(
            status=status, has_items=False, has_edges=next(edges, None) is not None
        )
    replacements = _reconciled_apparatus_keys(previous_items, items, preserve_fragment_html=True)
    del items
    path = directory / "review-apparatus.sqlite3"

    def rows(table: Literal["items", "edges"]) -> Iterator[dict[str, object]]:
        with (
            closing(sqlite3.connect(path)) as db,
            closing(db.execute(f"SELECT payload FROM {table} ORDER BY stable_key")) as result,
        ):
            for (payload,) in result:
                yield json.loads(gzip.decompress(payload))

    with closing(sqlite3.connect(path)) as db:
        db.execute("PRAGMA page_size = 4096")
        db.execute("PRAGMA max_page_count = 16384")
        db.execute("PRAGMA journal_mode = OFF")
        for table in ("items", "edges"):
            db.execute(f"CREATE TABLE {table} (stable_key TEXT PRIMARY KEY, payload BLOB NOT NULL)")

        def packed(rows: Iterable[dict[str, object]]) -> Iterator[tuple[object, bytes]]:
            for row in rows:
                content = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()
                yield row["stable_key"], gzip.compress(content, compresslevel=1, mtime=0)

        try:
            db.executemany(
                "INSERT INTO items VALUES (?, ?)",
                packed(
                    _apparatus_item_row(
                        item, replacements.get(str(item["stable_key"]), str(item["stable_key"]))
                    )
                    for item in item_rows()
                ),
            )
            db.executemany(
                "INSERT INTO edges VALUES (?, ?)",
                packed(_apparatus_edge_row(edge, replacements) for edge in edges),
            )
        except sqlite3.IntegrityError as exc:
            if exc.sqlite_errorcode not in (
                sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY,
                sqlite3.SQLITE_CONSTRAINT_UNIQUE,
            ):
                raise
            raise ApiError(
                ApiErrorCode.E_INTERNAL, "EPUB repair candidate has duplicate apparatus keys"
            ) from exc
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode != sqlite3.SQLITE_FULL:
                raise
            raise ResourceLimitError(
                "EPUB repair graph scratch storage is full", dimension="Output"
            ) from exc
        db.commit()
    return ApparatusCandidate(
        ApparatusOutput(
            status,
            lambda: rows("items"),
            lambda: rows("edges"),
            [group.model_dump(mode="json") for group in note_groups],
        ),
        replacements,
    )


def read_apparatus_output(db: Session, *, media_id: UUID) -> ApparatusOutput | None:
    """The installed logical projection, consumed in the caller's database snapshot."""
    params = {"media_id": media_id}
    state = (
        db.execute(
            text(
                "SELECT status, note_groups FROM reader_apparatus_states WHERE media_id=:media_id"
            ),
            params,
        )
        .mappings()
        .one_or_none()
    )
    if state is None:
        return None

    def items() -> Iterator[dict[str, object]]:
        with db.execute(
            text("""
                SELECT stable_key, kind, label, body_text, body_html_sanitized, locator,
                       locator_status, confidence, extraction_method, source_ref, sort_key
                FROM reader_apparatus_items WHERE media_id=:media_id
                ORDER BY stable_key COLLATE "C"
            """),
            params,
            execution_options={"yield_per": _UPSERT_MAX_ROWS},
        ).mappings() as rows:
            for row in rows:
                yield _apparatus_item_row(dict(row), str(row["stable_key"]))

    def edges() -> Iterator[dict[str, object]]:
        with db.execute(
            text("""
                SELECT e.stable_key, src.stable_key AS from_stable_key, dst.stable_key AS to_stable_key,
                       e.relation, e.confidence, e.extraction_method, e.source_ref, e.sort_key
                FROM reader_apparatus_edges e
                JOIN reader_apparatus_items src ON src.id = e.from_item_id
                JOIN reader_apparatus_items dst ON dst.id = e.to_item_id
                WHERE e.media_id=:media_id
                ORDER BY e.stable_key COLLATE "C"
            """),
            params,
            execution_options={"yield_per": _UPSERT_MAX_ROWS},
        ).mappings() as rows:
            for row in rows:
                yield _apparatus_edge_row(dict(row))

    return ApparatusOutput(
        str(state["status"]),
        items,
        edges,
        [
            NotesGroup.model_validate(group).model_dump(mode="json")
            for group in state["note_groups"]
        ],
    )


def replace_media_apparatus(
    db: Session,
    *,
    media_id: UUID,
    item_rows: Callable[[], Iterator[Mapping[str, object]]] | None = None,
    edge_rows: Callable[[], Iterator[Mapping[str, object]]],
    note_groups: list[NotesGroup],
    status: str | None = None,
    preserve_fragment_html: bool = False,
) -> None:
    """Install one extraction's rows from repeatable readers of the same projection.

    Saved connections, retrievals and view states key on the item UUID, so matched
    rows are updated in place and only rows this extraction no longer produces are
    deleted — with their dependents, and before the items they hang off.
    """
    if (
        db.scalar(
            text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    previous = _read_apparatus_matches(db, media_id)
    source = item_rows() if item_rows is not None else iter(())
    items = _apparatus_correspondence_items(source) if previous else []
    candidate_keys = (
        [item.stable_key for item in items]
        if previous
        else [str(item["stable_key"]) for item in source]
    )
    if status is None:
        status = "ready" if candidate_keys else "empty"
    if len(candidate_keys) != len(set(candidate_keys)):
        raise ApiError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "Source notes have ambiguous identities; the previous publication was retained.",
        )
    replacements = _reconciled_apparatus_keys(
        [match for _, match in previous], items, preserve_fragment_html=preserve_fragment_html
    )
    item_keys = [replacements.get(key, key) for key in candidate_keys]
    edge_keys = [str(_apparatus_edge_row(edge, replacements)["stable_key"]) for edge in edge_rows()]
    _validate_replacement(status=status, has_items=bool(item_keys), has_edges=bool(edge_keys))
    if len(item_keys) != len(set(item_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus item keys must be unique")
    if len(edge_keys) != len(set(edge_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge keys must be unique")
    old_ids = {match.stable_key: item_id for item_id, match in previous}
    del items, previous
    _validate_apparatus_dependencies(
        db,
        media_id=media_id,
        old_ids=old_ids,
        replacements=replacements,
        preserve_fragment_html=preserve_fragment_html,
    )
    if not preserve_fragment_html:
        _rewrite_apparatus_stamps(db, media_id=media_id, replacements=replacements)

    state_id = db.execute(
        text(
            """
            INSERT INTO reader_apparatus_states (media_id, status, note_groups)
            VALUES (:media_id, :status, :note_groups)
            ON CONFLICT (media_id) DO UPDATE SET
                status = EXCLUDED.status, note_groups = EXCLUDED.note_groups,
                updated_at = clock_timestamp()
            RETURNING id
            """
        ).bindparams(bindparam("note_groups", type_=JSONB)),
        {
            "media_id": media_id,
            "status": status,
            "note_groups": [group.model_dump(mode="json") for group in note_groups],
        },
    ).scalar_one()

    ids_by_key: dict[str, UUID] = {}
    if item_rows is not None:
        rows = (
            _apparatus_item_row(
                item, replacements.get(str(item["stable_key"]), str(item["stable_key"]))
            )
            for item in item_rows()
        )
        for payload in _upsert_json_batches(rows):
            for row in db.execute(
                _ITEM_UPSERT,
                {"media_id": media_id, "state_id": state_id, "items": payload},
            ):
                if row.stable_key in ids_by_key:
                    raise ApiError(
                        ApiErrorCode.E_INTERNAL, "Reader apparatus item reader repeated a key"
                    )
                ids_by_key[row.stable_key] = row.id
    if len(ids_by_key) != len(item_keys) or any(key not in ids_by_key for key in item_keys):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus item keys changed between reads")

    db.execute(
        text(
            """
            DELETE FROM reader_apparatus_edges
            WHERE media_id = :media_id AND stable_key <> ALL(CAST(:keys AS text[]))
            """
        ),
        {"media_id": media_id, "keys": edge_keys},
    )

    def bound_edges() -> Iterator[dict[str, object]]:
        for edge, key in zip(edge_rows(), edge_keys, strict=True):
            row = _apparatus_edge_row(edge, replacements)
            if row["stable_key"] != key:
                raise ApiError(
                    ApiErrorCode.E_INTERNAL, "Reader apparatus edge keys changed between reads"
                )
            from_key = str(row.pop("from_stable_key"))
            to_key = str(row.pop("to_stable_key"))
            if from_key not in ids_by_key or to_key not in ids_by_key:
                raise ApiError(
                    ApiErrorCode.E_INTERNAL, "Reader apparatus edge points to missing item"
                )
            row["from_item_id"] = str(ids_by_key[from_key])
            row["to_item_id"] = str(ids_by_key[to_key])
            yield row

    for payload in _upsert_json_batches(bound_edges()):
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
    projection.refresh(db, "reader_apparatus_item", [*old_ids.values(), *new_ids])


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


def _validate_replacement(*, status: str, has_items: bool, has_edges: bool) -> None:
    if status not in {"ready", "empty", "partial", "unsupported", "failed"}:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Invalid reader apparatus status")
    if status in {"empty", "unsupported", "failed"} and (has_items or has_edges):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Terminal empty apparatus states cannot carry rows")
    if status in {"ready", "partial"} and not has_items:
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


def _match_apparatus_source_items(
    old: Sequence[ApparatusMatch], items: Sequence[ApparatusMatch]
) -> dict[str, str]:
    """Match only unique authored, contextual, or unchanged exact source occurrences."""
    by_identity: dict[bytes, list[ApparatusMatch]] = defaultdict(list)
    by_context: dict[bytes, list[ApparatusMatch]] = defaultdict(list)
    by_locator: dict[bytes, list[ApparatusMatch]] = defaultdict(list)
    for row in old:
        if row.identity is not None:
            by_identity[row.identity].append(row)
        if row.context is not None:
            by_context[row.context].append(row)
        if row.locator is not None:
            by_locator[row.locator].append(row)
    identities = Counter(item.identity for item in items)
    contexts = Counter(item.context for item in items)
    locators = Counter(item.locator for item in items)
    matches: dict[str, str] = {}
    claimed: set[str] = set()
    for item in items:
        candidates = (
            by_identity.get(item.identity, [])
            if item.identity is not None and identities[item.identity] == 1
            else []
        )
        if not candidates and item.allow_context and item.context is not None:
            if contexts[item.context] == 1:
                candidates = by_context.get(item.context, [])
        if not candidates and item.locator is not None and locators[item.locator] == 1:
            candidates = by_locator.get(item.locator, [])
        if len(candidates) != 1 or candidates[0].kind != item.kind:
            continue
        old_key = candidates[0].stable_key
        if old_key not in claimed:
            matches[item.stable_key] = old_key
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


def _reconciled_apparatus_keys(
    old: Sequence[ApparatusMatch],
    items: Sequence[ApparatusMatch],
    *,
    preserve_fragment_html: bool,
) -> dict[str, str]:
    keys = _match_apparatus_source_items(old, items)
    old_keys = {row.stable_key for row in old}
    for item in items:
        key = item.stable_key
        if key in old_keys and key not in keys:
            if preserve_fragment_html:
                raise ApiError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "Repair cannot prove correspondence for an existing note key.",
                )
            keys[key] = f"item:{uuid4()}"
    return keys


def _read_apparatus_matches(db: Session, media_id: UUID) -> list[tuple[UUID, ApparatusMatch]]:
    with db.execute(
        text(
            "SELECT id, stable_key, kind, body_text, locator, locator_status, source_ref"
            " FROM reader_apparatus_items WHERE media_id=:id"
        ),
        {"id": media_id},
        execution_options={"yield_per": _UPSERT_MAX_ROWS},
    ).mappings() as rows:
        return [(row["id"], _apparatus_match(dict(row))) for row in rows]


def read_apparatus_correspondence(db: Session, *, media_id: UUID) -> list[ApparatusMatch]:
    """Capture the same source facts reconciliation will use under its write lock."""
    return [match for _, match in _read_apparatus_matches(db, media_id)]


def _validate_apparatus_dependencies(
    db: Session,
    *,
    media_id: UUID,
    old_ids: Mapping[str, UUID],
    replacements: Mapping[str, str],
    preserve_fragment_html: bool,
) -> None:
    retained = set(replacements.values())
    withdrawn = {key: item_id for key, item_id in old_ids.items() if key not in retained}
    removed = list(withdrawn.values())
    if removed and db.scalar(
        text("""
            SELECT EXISTS (
                SELECT 1 FROM resource_edges
                WHERE ((source_scheme='reader_apparatus_item' AND source_id=ANY(:ids))
                   OR (target_scheme='reader_apparatus_item' AND target_id=ANY(:ids)))
                  AND (:preserve_fragment_html OR NOT (source_scheme='message' AND origin='citation'))
                UNION ALL SELECT 1 FROM resource_view_states
                WHERE target_scheme='reader_apparatus_item' AND target_id=ANY(:ids)
                UNION ALL SELECT 1 FROM resource_versions
                WHERE resource_scheme='reader_apparatus_item' AND resource_id=ANY(:ids)
            )
        """),
        {"ids": removed, "preserve_fragment_html": preserve_fragment_html},
    ):
        raise ApiError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "Source refresh cannot preserve a referenced note. The previous publication was retained.",
        )
    if preserve_fragment_html:
        affected = set(withdrawn) | {
            key for key, replacement in replacements.items() if key != replacement
        }
        if affected:
            with db.scalars(
                text("SELECT html_sanitized FROM fragments WHERE media_id=:id"),
                {"id": media_id},
                execution_options={"yield_per": 1},
            ) as html_rows:
                if any(
                    match[1] in affected
                    for html in html_rows
                    for match in re.finditer(r'data-reader-apparatus-item-id="([^"]+)"', html)
                ):
                    raise ApiError(
                        ApiErrorCode.E_RESOURCE_CONFLICT,
                        "Repair cannot preserve retained note stamps.",
                    )


def _projection_pairs(
    previous: Iterator[dict[str, object]],
    candidate: Iterator[dict[str, object]],
) -> Iterator[tuple[dict[str, object] | None, dict[str, object] | None]]:
    old, new = next(previous, None), next(candidate, None)
    while old is not None or new is not None:
        if old is None:
            yield None, new
            new = next(candidate, None)
        elif new is None:
            yield old, None
            old = next(previous, None)
        elif str(old["stable_key"]) < str(new["stable_key"]):
            yield old, None
            old = next(previous, None)
        elif str(old["stable_key"]) > str(new["stable_key"]):
            yield None, new
            new = next(candidate, None)
        else:
            yield old, new
            old, new = next(previous, None), next(candidate, None)


def review_apparatus_replacement(
    db: Session,
    *,
    media_id: UUID,
    previous: ApparatusOutput | None,
    candidate: ApparatusCandidate,
) -> dict[str, object]:
    """Check dependencies after the caller re-seals the installed projection used to stage this."""
    with db.execute(
        text("SELECT stable_key, id FROM reader_apparatus_items WHERE media_id=:id"),
        {"id": media_id},
        execution_options={"yield_per": _UPSERT_MAX_ROWS},
    ) as rows:
        ids = {row.stable_key: row.id for row in rows}
    replacements = candidate._replacements
    _validate_apparatus_dependencies(
        db,
        media_id=media_id,
        old_ids=ids,
        replacements=replacements,
        preserve_fragment_html=True,
    )
    kept = set(replacements.values())
    changes: list[dict[str, object]] = []
    for old, item in _projection_pairs(
        previous.items() if previous is not None else iter(()), candidate.output.items()
    ):
        if old is None or item is None:
            continue
        key = str(item["stable_key"])
        if key not in kept:
            continue
        body_changed = (
            item["body_text"] != old["body_text"]
            or item["body_html_sanitized"] != old["body_html_sanitized"]
        )
        locator_changed = (
            item["locator"] != old["locator"] or item["locator_status"] != old["locator_status"]
        )
        label_changed = item["label"] != old["label"]
        if body_changed or locator_changed or label_changed:
            changes.append(
                {
                    "id": ids[key],
                    "stable_key": key,
                    "body_changed": body_changed,
                    "locator_changed": locator_changed,
                    "label_changed": label_changed,
                }
            )
    added, removed, changed = [], [], []
    for old, new in _projection_pairs(
        previous.edges() if previous is not None else iter(()), candidate.output.edges()
    ):
        if old is None:
            assert new is not None
            added.append(str(new["stable_key"]))
        elif new is None:
            removed.append(str(old["stable_key"]))
        elif old != new:
            changed.append(str(new["stable_key"]))
    return {
        "changed_kept_items": changes,
        "added_edge_keys": added,
        "removed_edge_keys": removed,
        "changed_edge_keys": changed,
    }


def _rewrite_apparatus_stamps(
    db: Session,
    *,
    media_id: UUID,
    replacements: Mapping[str, str],
) -> None:
    rekeys = {key: value for key, value in replacements.items() if key != value}
    if not rekeys:
        return
    with db.execute(
        text("SELECT id, html_sanitized FROM fragments WHERE media_id=:id"),
        {"id": media_id},
        execution_options={"yield_per": 1},
    ).mappings() as fragments:
        for fragment in fragments:
            html = str(fragment["html_sanitized"])

            # Keys contain no HTML metacharacters. Only our stamped attribute changes;
            # reserializing the source DOM could change its canonical byte contract.
            updated = re.sub(
                r'(data-reader-apparatus-item-id=")([^"]+)(")',
                lambda match: match[1] + rekeys.get(match[2], match[2]) + match[3],
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
    anchor_names: set[str] = set()
    for item in items:
        if item.body_html_sanitized is not None:
            anchor_names.update(
                unquote(urlsplit(str(link.get("href"))).fragment)
                for link in parse_html_document(item.body_html_sanitized).xpath("//a[@href]")
            )
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
    fragment_anchors: dict[str, set[str]] = {}
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
            FROM reader_apparatus_items
            WHERE state_id = :state_id AND (
                source_ref->>'marker_id' = ANY(:anchor_names)
                OR source_ref->>'target_id' = ANY(:anchor_names)
            )
            ORDER BY sort_key, stable_key
        """),
        {"state_id": state_id, "anchor_names": list(anchor_names)},
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
                if anchor and fragment_key not in fragment_anchors:
                    html = db.execute(
                        text("SELECT html_sanitized FROM fragments WHERE id = :id"),
                        {"id": fragment["id"]},
                    ).scalar_one()
                    fragment_anchors[fragment_key] = (
                        canonicalize_structure(html).anchors.keys() & anchor_names
                    )
                    del html
                if not anchor or anchor in fragment_anchors[fragment_key]:
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
