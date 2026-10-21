# Frozen for migration 0293 from d6f04890c:python/nexus/services/reader_apparatus.py (its replacement).
"""Reader apparatus store: one state row, its items and edges, keyed by stable_key.

Replacement stays in the caller's transaction; a retry keeps matched item ids.
Each upsert's JSON is bounded by 128 rows and 512 KiB, or one larger valid row.
The byte envelope is max(512 KiB, the largest encoded row plus array brackets).
The map reads bounded owner summaries and ordered target refs, never note bodies.
An opened owner reads its complete targets under the caller's publication fence.
Only that detail read binds copied HTML, using aliases across the publication;
repair provenance stays in storage. Neither read changes content or progress.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterator, Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from .resource_graph import ResourceRef, delete_edges_for_deleted_resources
from .schemas import NotesGroup, retrieval_locator_json
from .support import ApiError, ApiErrorCode, NotFoundError

_UPSERT_MAX_ROWS = 128
_UPSERT_MAX_BYTES = 512 * 1024


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
