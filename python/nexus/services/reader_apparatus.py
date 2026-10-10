"""Reader apparatus store: one state row, its items and edges, keyed by stable_key."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from typing import Any, cast
from urllib.parse import unquote, urlsplit
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.media import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.reader_apparatus import (
    NoteBodyRegion,
    NoteGroupRegion,
    NoteRegion,
    NotesGroup,
    ReaderApparatusEdgeOut,
    ReaderApparatusItemOut,
    ReaderApparatusResponse,
)
from nexus.schemas.retrieval import RetrievalLocator, retrieval_locator_json
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.capabilities import is_document_status_ready
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.refs import ResourceRef

SUPPORTED_MEDIA_KINDS = frozenset({"web_article", "epub", "pdf"})

_ITEM_UPSERT = text(
    """
    INSERT INTO reader_apparatus_items (
        media_id, state_id, stable_key, kind, label, body_text, body_html_sanitized,
        locator, locator_status, confidence, extraction_method, source_ref, sort_key
    )
    VALUES (
        :media_id, :state_id, :stable_key, :kind, :label, :body_text, :body_html_sanitized,
        :locator, :locator_status, :confidence, :extraction_method, :source_ref, :sort_key
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
    RETURNING id
    """
).bindparams(
    bindparam("locator", type_=JSONB(none_as_null=True)),
    bindparam("source_ref", type_=JSONB),
)

_EDGE_UPSERT = text(
    """
    INSERT INTO reader_apparatus_edges (
        media_id, state_id, stable_key, from_item_id, to_item_id, relation,
        confidence, extraction_method, source_ref, sort_key
    )
    VALUES (
        :media_id, :state_id, :stable_key, :from_item_id, :to_item_id, :relation,
        :confidence, :extraction_method, :source_ref, :sort_key
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
).bindparams(bindparam("source_ref", type_=JSONB))


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


def visible_reader_apparatus_item_ids(
    db: Session, *, viewer_id: UUID, item_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied item ids the viewer can read, in one set query.

    Mirrors the per-ref gate: the item's state must be ``ready`` or ``partial``, it
    must carry a present, non-missing locator, and its media must be readable.
    """
    ordered = list(dict.fromkeys(item_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT rai.id
            FROM reader_apparatus_items rai
            JOIN reader_apparatus_states ras ON ras.id = rai.state_id
            WHERE rai.id = ANY(:item_ids)
              AND ras.status IN ('ready', 'partial')
              AND rai.locator IS NOT NULL
              AND rai.locator_status != 'missing'
              AND rai.media_id IN ({visible_media_ids_cte_sql()})
            """
        ),
        {"viewer_id": viewer_id, "item_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def get_media_apparatus(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderApparatusResponse:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = (
        db.execute(
            text("SELECT kind, processing_status FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .fetchone()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if str(media["kind"]) not in SUPPORTED_MEDIA_KINDS:
        return ReaderApparatusResponse(media_id=media_id, status="unsupported", items=[], edges=[])
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

    item_rows = (
        db.execute(
            text(
                """
                SELECT id, stable_key, kind, label, body_text, body_html_sanitized, locator, locator_status,
                       confidence, extraction_method, source_ref, sort_key
                FROM reader_apparatus_items
                WHERE state_id = :state_id
                ORDER BY sort_key, stable_key
                """
            ),
            {"state_id": state["id"]},
        )
        .mappings()
        .all()
    )
    edge_rows = (
        db.execute(
            text(
                """
                SELECT edge.stable_key,
                       source.stable_key AS from_stable_key,
                       target.stable_key AS to_stable_key,
                       edge.relation, edge.confidence, edge.extraction_method,
                       edge.source_ref, edge.sort_key
                FROM reader_apparatus_edges edge
                JOIN reader_apparatus_items source
                  ON source.id = edge.from_item_id AND source.state_id = edge.state_id
                JOIN reader_apparatus_items target
                  ON target.id = edge.to_item_id AND target.state_id = edge.state_id
                WHERE edge.state_id = :state_id
                ORDER BY edge.sort_key, edge.stable_key
                """
            ),
            {"state_id": state["id"]},
        )
        .mappings()
        .all()
    )
    body_html_by_key = _source_body_html(db, media_id=media_id, items=item_rows)
    return ReaderApparatusResponse(
        media_id=media_id,
        status=state["status"],
        items=[
            ReaderApparatusItemOut(
                id=row["id"],
                resource_ref=f"reader_apparatus_item:{row['id']}",
                stable_key=str(row["stable_key"]),
                kind=row["kind"],
                label=row["label"],
                body_text=row["body_text"],
                body_html_sanitized=body_html_by_key.get(str(row["stable_key"])),
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
            for row in item_rows
        ],
        edges=[
            ReaderApparatusEdgeOut(
                stable_key=str(row["stable_key"]),
                from_stable_key=str(row["from_stable_key"]),
                to_stable_key=str(row["to_stable_key"]),
                relation=row["relation"],
                confidence=row["confidence"],
                extraction_method=str(row["extraction_method"]),
                source_ref=dict(row["source_ref"] or {}),
                sort_key=str(row["sort_key"]),
            )
            for row in edge_rows
        ],
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

    ids_by_key: dict[str, UUID] = {}
    for item in items:
        locator = (
            retrieval_locator_json(_object_dict(item.get("locator")))
            if item.get("locator")
            else None
        )
        ids_by_key[str(item["stable_key"])] = db.execute(
            _ITEM_UPSERT,
            {
                "media_id": media_id,
                "state_id": state_id,
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
            },
        ).scalar_one()

    db.execute(
        text(
            """
            DELETE FROM reader_apparatus_edges
            WHERE media_id = :media_id AND stable_key <> ALL(CAST(:keys AS text[]))
            """
        ),
        {"media_id": media_id, "keys": edge_keys},
    )
    for edge in edges:
        from_key = str(edge["from_stable_key"])
        to_key = str(edge["to_stable_key"])
        if from_key not in ids_by_key or to_key not in ids_by_key:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge points to missing item")
        db.execute(
            _EDGE_UPSERT,
            {
                "media_id": media_id,
                "state_id": state_id,
                "stable_key": str(edge["stable_key"]),
                "from_item_id": ids_by_key[from_key],
                "to_item_id": ids_by_key[to_key],
                "relation": edge["relation"],
                "confidence": edge["confidence"],
                "extraction_method": edge["extraction_method"],
                "source_ref": edge.get("source_ref") or {},
                "sort_key": edge["sort_key"],
            },
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
    if marker and source.get("package_href") and source.get("target_id"):
        # Old EPUB markers recorded only the local id. The current extractor
        # records the resolved href as well; these denote the same authored link.
        local_ref = f"{source['package_href']}#{source['target_id']}"
        if target == local_ref:
            target = str(source["target_id"])
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
        source = _object_dict(row.get("source_ref"))
        if context := source.get("quote_context"):
            document = str(source.get("package_href") or source.get("document_href") or "web")
            by_context[(str(row["kind"]), document, json.dumps(context, sort_keys=True))].append(
                row
            )
        if row.get("locator_status") == "exact" and row.get("locator"):
            target = source.get("target_ref") or source.get("target_id") or source.get("target_ids")
            key = (
                str(row["kind"]),
                json.dumps(row["locator"], sort_keys=True),
                str(row.get("body_text")),
                json.dumps(target, sort_keys=True),
            )
            by_locator[key].append(row)
    identities = Counter(_source_identity(item) for item in items)
    contexts: Counter[tuple[str, str, str]] = Counter()
    locators: Counter[tuple[str, str, str, str]] = Counter()
    for item in items:
        source = _object_dict(item.get("source_ref"))
        if context := source.get("quote_context"):
            document = str(source.get("package_href") or source.get("document_href") or "web")
            contexts[(str(item["kind"]), document, json.dumps(context, sort_keys=True))] += 1
        if item.get("locator_status") == "exact" and item.get("locator"):
            target = source.get("target_ref") or source.get("target_id") or source.get("target_ids")
            key = (
                str(item["kind"]),
                json.dumps(item["locator"], sort_keys=True),
                str(item.get("body_text")),
                json.dumps(target, sort_keys=True),
            )
            locators[key] += 1
    matches: dict[str, str] = {}
    claimed: set[str] = set()
    for item in items:
        identity = _source_identity(item)
        candidates = by_identity.get(identity, []) if identity and identities[identity] == 1 else []
        source = _object_dict(item.get("source_ref"))
        own_id = source.get("marker_id" if str(item["kind"]).endswith("_ref") else "target_id")
        if _object_dict(source.get("identity")).get("kind") == "Anonymous":
            own_id = None
        if not candidates and not own_id and (context := source.get("quote_context")):
            document = str(source.get("package_href") or source.get("document_href") or "web")
            key = (str(item["kind"]), document, json.dumps(context, sort_keys=True))
            if contexts[key] == 1:
                candidates = by_context.get(key, [])
        if not candidates and item.get("locator_status") == "exact" and item.get("locator"):
            target = source.get("target_ref") or source.get("target_id") or source.get("target_ids")
            key = (
                str(item["kind"]),
                json.dumps(item["locator"], sort_keys=True),
                str(item.get("body_text")),
                json.dumps(target, sort_keys=True),
            )
            if locators[key] == 1:
                candidates = by_locator.get(key, [])
        if len(candidates) != 1 or str(candidates[0]["kind"]) != str(item["kind"]):
            continue
        old_key = str(candidates[0]["stable_key"])
        if old_key not in claimed:
            matches[str(item["stable_key"])] = old_key
            claimed.add(old_key)
    return matches


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
            from uuid import uuid4

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
    db: Session, *, media_id: UUID, items: Sequence[Mapping[Any, Any]]
) -> dict[str, str]:
    """Resolve copied-source links against the current publication before DOM ids leave it."""
    bodies = {
        str(row["stable_key"]): str(row["body_html_sanitized"])
        for row in items
        if row["body_html_sanitized"] is not None
    }
    if not bodies:
        return {}
    fragments = (
        db.execute(
            text("""
        SELECT f.id, f.html_sanitized, s.package_href FROM fragments f
        LEFT JOIN epub_fragment_sources s ON s.fragment_id=f.id
        WHERE f.media_id=:id
    """),
            {"id": media_id},
        )
        .mappings()
        .all()
    )
    by_path = {str(row["package_href"]): row for row in fragments if row["package_href"]}
    fragment_ids = {str(row["id"]) for row in fragments}
    anchors: dict[str, Any] = {}
    source_locations: dict[str, str] = {}
    for row in items:
        locator = dict(row["locator"] or {})
        if (
            str(locator.get("fragment_id")) not in fragment_ids
            or locator.get("start_offset") is None
        ):
            continue
        href = f"/media/{media_id}#text-{locator['fragment_id']}:{locator['start_offset']}:{locator.get('end_offset', locator['start_offset'])}"
        source = dict(row["source_ref"] or {})
        element_id = (
            source.get("marker_id")
            if str(row["kind"]).endswith("_ref")
            else source.get("target_id")
        )
        if element_id:
            document = (
                str(source.get("package_href") or source.get("target_href") or "")
                if source.get("format") == "xhtml"
                else ""
            )
            source_locations[f"{document}#{element_id}"] = href
    for row in items:
        key = str(row["stable_key"])
        if key not in bodies:
            continue
        root = parse_html_document(bodies[key])
        source = dict(row["source_ref"] or {})
        is_epub = source.get("format") == "xhtml"
        package_path = (
            str(source.get("package_href") or source.get("target_href") or "") if is_epub else ""
        )
        for link in root.xpath("//a[@href]"):
            raw = str(link.get("href"))
            parsed = urlsplit(raw)
            internal = (
                not parsed.scheme and not parsed.netloc
                if is_epub
                else (
                    bool(parsed.fragment)
                    and (
                        not parsed.scheme
                        or raw.split("#", 1)[0]
                        == str(source.get("document_href") or "").split("#", 1)[0]
                    )
                )
            )
            if not internal:
                continue
            path = parsed.path or package_path
            anchor = unquote(parsed.fragment)
            destination = source_locations.get(f"{path if is_epub else ''}#{anchor}")
            fragment = by_path.get(path)
            if destination is None and fragment is not None:
                if path not in anchors:
                    anchors[path] = canonicalize_structure(fragment["html_sanitized"])
                structure = anchors[path]
                index = structure.anchors.get(anchor) if anchor else None
                offset = structure.elements[index].start_offset if index is not None else 0
                if not anchor or index is not None:
                    destination = f"/media/{media_id}#text-{fragment['id']}:{offset}:{offset}"
            if destination is not None:
                link.set("href", destination)
                link.attrib.pop("target", None)
            elif is_epub:
                link.attrib.pop("href", None)
        body = root.body
        if body is not None:
            bodies[key] = inner_html(body)
    return bodies
