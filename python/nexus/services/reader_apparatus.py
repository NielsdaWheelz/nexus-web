"""Reader apparatus store: one state row, its items and edges, keyed by stable_key."""

from __future__ import annotations

import re
from typing import Any, cast
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.reader_apparatus import (
    ReaderApparatusEdgeOut,
    ReaderApparatusItemOut,
    ReaderApparatusResponse,
)
from nexus.schemas.retrieval import RetrievalLocator, retrieval_locator_json
from nexus.services.capabilities import is_document_status_ready
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.refs import ResourceRef

SUPPORTED_MEDIA_KINDS = frozenset({"web_article", "epub", "pdf"})

_ITEM_UPSERT = text(
    """
    INSERT INTO reader_apparatus_items (
        media_id, state_id, stable_key, kind, label, body_text,
        locator, locator_status, confidence, extraction_method, source_ref, sort_key
    )
    VALUES (
        :media_id, :state_id, :stable_key, :kind, :label, :body_text,
        :locator, :locator_status, :confidence, :extraction_method, :source_ref, :sort_key
    )
    ON CONFLICT (media_id, stable_key) DO UPDATE SET
        kind = EXCLUDED.kind,
        label = EXCLUDED.label,
        body_text = EXCLUDED.body_text,
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
    """The one sanitizer every ``stable_key`` segment passes through."""
    token = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return token[:96] or "item"


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
                SELECT id, stable_key, kind, label, body_text, locator, locator_status,
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

    item_keys = [str(item["stable_key"]) for item in items]
    edge_keys = [str(edge["stable_key"]) for edge in edges]
    if len(item_keys) != len(set(item_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus item keys must be unique")
    if len(edge_keys) != len(set(edge_keys)):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge keys must be unique")

    if (
        db.scalar(
            text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    state_id = db.execute(
        text(
            """
            INSERT INTO reader_apparatus_states (media_id, status)
            VALUES (:media_id, :status)
            ON CONFLICT (media_id) DO UPDATE SET status = EXCLUDED.status
            RETURNING id
            """
        ),
        {"media_id": media_id, "status": status},
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
