"""Where opening a resource goes: a workspace route, an outside url, or nowhere.

Routing owns no visibility: a caller passes the refs its own hydration found missing,
and those get a ``none`` activation (a route for an unproven ref would leak its
parent's identity). Every read is one set query per scheme, never one per ref.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any, assert_never, cast
from urllib.parse import quote, urlencode
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.reader_apparatus import ReaderApparatusLocatorStatus
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceRef

_STATIC_PREFIXES = {
    "page": "/pages",
    "note_block": "/notes",
    "media": "/media",
    "conversation": "/conversations",
    "library": "/libraries",
    "oracle_reading": "/oracle",
    "podcast": "/podcasts",
}


def route_for_visible_apparatus_item(
    *,
    media_id: UUID,
    item_id: UUID,
    stable_key: str,
    locator_present: bool,
    locator_status: ReaderApparatusLocatorStatus,
    locator_current: bool,
) -> str | None:
    """The route for an apparatus item already proven visible."""
    if not locator_present or not locator_current:
        return None
    match locator_status:
        case "exact" | "container":
            params = urlencode({"apparatus": stable_key, "apparatus_id": str(item_id)})
            return f"/media/{media_id}?{params}"
        case "missing":
            return None
        case _ as unreachable:
            assert_never(unreachable)


def resource_activations_for_refs(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    missing_ref_uris: set[str] | frozenset[str] = frozenset(),
) -> dict[str, ResourceActivationOut]:
    """One activation per distinct ref; a ref in ``missing_ref_uris`` gets ``none``."""
    unique = {ref.uri: ref for ref in refs}
    visible = [ref for uri, ref in unique.items() if uri not in missing_ref_uris]
    by_scheme: dict[str, list[ResourceRef]] = defaultdict(list)
    for ref in visible:
        by_scheme[ref.scheme].append(ref)
    routes = {
        ref.uri: f"{_STATIC_PREFIXES[ref.scheme]}/{ref.id}"
        for ref in visible
        if ref.scheme in _STATIC_PREFIXES
    }
    routes.update(_dynamic_routes(db, viewer_id=viewer_id, by_scheme=by_scheme))
    external = _external_urls(db, viewer_id=viewer_id, refs=by_scheme["external_snapshot"])
    activations: dict[str, ResourceActivationOut] = {}
    for ref in unique.values():
        if (href := routes.get(ref.uri)) is not None:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri, kind="route", href=href
            )
        elif (url := external.get(ref.uri)) is not None:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri, kind="external", href=url
            )
        else:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri, kind="none", href=None
            )
    return activations


def resource_activation_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool
) -> ResourceActivationOut:
    """``missing`` is the caller's own hydration verdict; it has no default on purpose."""
    missing_uris = frozenset({ref.uri}) if missing else frozenset()
    return resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=[ref], missing_ref_uris=missing_uris
    )[ref.uri]


def route_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool) -> str | None:
    activation = resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref, missing=missing)
    return activation.href if activation.kind == "route" else None


def _ids(refs: Sequence[ResourceRef]) -> list[UUID]:
    return [ref.id for ref in refs]


def _external_urls(db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]) -> dict[str, str]:
    if not refs:
        return {}
    rows = db.execute(
        text(
            "SELECT id, url FROM resource_external_snapshots"
            " WHERE id = ANY(:ids) AND user_id = :viewer_id"
        ),
        {"ids": _ids(refs), "viewer_id": viewer_id},
    ).all()
    return {f"external_snapshot:{row[0]}": str(row[1]) for row in rows if row[1]}


def _dynamic_routes(
    db: Session, *, viewer_id: UUID, by_scheme: dict[str, list[ResourceRef]]
) -> dict[str, str]:
    # Imported here: the dossier binding table sits above resource routing.
    from nexus.services.dossier.subjects import head_visible_sql

    def rows(sql: str, refs: Sequence[ResourceRef]) -> Sequence[Any]:
        if not refs:
            return []
        return db.execute(text(sql), {"ids": _ids(refs), "viewer_id": viewer_id}).all()

    routes: dict[str, str] = {}
    for id_, media_id in rows(
        "SELECT id, anchor_media_id FROM highlights WHERE id = ANY(:ids)", by_scheme["highlight"]
    ):
        routes[f"highlight:{id_}"] = f"/media/{media_id}#highlight-{id_}"
    for id_, conversation_id in rows(
        "SELECT id, conversation_id FROM messages WHERE id = ANY(:ids)", by_scheme["message"]
    ):
        routes[f"message:{id_}"] = f"/conversations/{conversation_id}?message={id_}"
    for id_, media_id in rows(
        "SELECT id, media_id FROM fragments WHERE id = ANY(:ids)", by_scheme["fragment"]
    ):
        routes[f"fragment:{id_}"] = f"/media/{media_id}#fragment-{id_}"
    for row in rows(_APPARATUS_SQL, by_scheme["reader_apparatus_item"]):
        route = route_for_visible_apparatus_item(
            media_id=row[1],
            item_id=row[0],
            stable_key=str(row[2]),
            locator_present=bool(row[3]),
            locator_status=cast(ReaderApparatusLocatorStatus, str(row[4])),
            locator_current=bool(row[5]),
        )
        if route is not None:
            routes[f"reader_apparatus_item:{row[0]}"] = route
    for (id_,) in rows(
        f"SELECT a.id FROM artifacts a WHERE a.id = ANY(:ids) AND {head_visible_sql('a')}",
        by_scheme["artifact"],
    ):
        routes[f"artifact:{id_}"] = f"/artifacts/artifact:{id_}"
    for revision_id, artifact_id in rows(
        "SELECT a.revision_id, a.id FROM artifacts a"
        f" WHERE a.revision_id = ANY(:ids) AND {head_visible_sql('a')}",
        by_scheme["artifact_revision"],
    ):
        routes[f"artifact_revision:{revision_id}"] = f"/artifacts/artifact:{artifact_id}"
    for id_, handle in rows(
        "SELECT id, handle FROM contributors WHERE id = ANY(:ids)", by_scheme["contributor"]
    ):
        routes[f"contributor:{id_}"] = f"/authors/{quote(str(handle), safe='')}"
    for id_, owner_scheme, owner_id in rows(
        "SELECT id, owner_scheme, owner_id FROM passage_anchors"
        " WHERE id = ANY(:ids) AND user_id = :viewer_id",
        by_scheme["passage_anchor"],
    ):
        prefix = {"media": "/media", "note_block": "/notes"}.get(owner_scheme)
        if prefix is not None:
            routes[f"passage_anchor:{id_}"] = f"{prefix}/{owner_id}#passage-{id_}"
    routes.update(_passage_routes(db, by_scheme=by_scheme))
    return routes


def _passage_routes(db: Session, *, by_scheme: dict[str, list[ResourceRef]]) -> dict[str, str]:
    """Evidence spans, content chunks, and the oracle anchors resolved onto either."""
    oracle_targets: dict[UUID, tuple[str, UUID]] = {}
    if by_scheme["oracle_passage_anchor"]:
        for anchor_id, span_id, chunk_id in db.execute(
            text(
                "SELECT id, current_evidence_span_id, current_content_chunk_id"
                " FROM oracle_passage_anchors"
                " WHERE id = ANY(:ids) AND resolution_status = 'resolved'"
            ),
            {"ids": _ids(by_scheme["oracle_passage_anchor"])},
        ):
            if span_id is not None:
                oracle_targets[anchor_id] = ("evidence_span", span_id)
            elif chunk_id is not None:
                oracle_targets[anchor_id] = ("content_chunk", chunk_id)

    chunk_ids = set(_ids(by_scheme["content_chunk"]))
    chunk_ids.update(id_ for scheme, id_ in oracle_targets.values() if scheme == "content_chunk")
    chunks: dict[UUID, Any] = {}
    if chunk_ids:
        chunks = {
            row[0]: row
            for row in db.execute(
                text(
                    "SELECT id, owner_kind, owner_id, primary_evidence_span_id, summary_locator"
                    " FROM content_chunks WHERE id = ANY(:ids)"
                ),
                {"ids": list(chunk_ids)},
            )
        }
    span_ids = set(_ids(by_scheme["evidence_span"]))
    span_ids.update(id_ for scheme, id_ in oracle_targets.values() if scheme == "evidence_span")
    span_ids.update(row[3] for row in chunks.values() if row[3] is not None)
    span_routes: dict[UUID, str] = {}
    if span_ids:
        for id_, owner_kind, owner_id, selector, resolver_kind in db.execute(
            text(
                "SELECT id, owner_kind, owner_id, selector, resolver_kind"
                " FROM evidence_spans WHERE id = ANY(:ids)"
            ),
            {"ids": list(span_ids)},
        ):
            if owner_kind == "media":
                span_routes[id_] = f"/media/{owner_id}#evidence-{id_}"
            elif owner_kind == "note_block" and resolver_kind == "note":
                span_routes[id_] = f"/notes/{selector['note_block_id']}"
    chunk_routes: dict[UUID, str] = {}
    for id_, owner_kind, owner_id, primary_span_id, locator in chunks.values():
        if primary_span_id is not None:
            route = span_routes.get(primary_span_id)
        elif owner_kind == "media":
            route = f"/media/{owner_id}"
        elif owner_kind == "note_block":
            route = f"/notes/{locator['note_block_id']}"
        else:
            route = None
        if route is not None:
            chunk_routes[id_] = route

    routes = {
        f"evidence_span:{ref.id}": span_routes[ref.id]
        for ref in by_scheme["evidence_span"]
        if ref.id in span_routes
    }
    routes.update(
        (f"content_chunk:{ref.id}", chunk_routes[ref.id])
        for ref in by_scheme["content_chunk"]
        if ref.id in chunk_routes
    )
    for anchor_id, (scheme, target_id) in oracle_targets.items():
        target_routes = span_routes if scheme == "evidence_span" else chunk_routes
        if target_id in target_routes:
            routes[f"oracle_passage_anchor:{anchor_id}"] = target_routes[target_id]
    return routes


_APPARATUS_SQL = f"""
WITH visible_media AS ({visible_media_ids_cte_sql()})
SELECT rai.id,
       rai.media_id,
       rai.stable_key,
       rai.locator IS NOT NULL AS locator_present,
       rai.locator_status,
       CASE
         WHEN rai.locator IS NULL THEN FALSE
         WHEN rai.locator->>'media_id' IS DISTINCT FROM rai.media_id::text THEN FALSE
         WHEN rai.locator->>'type' IN ('web_text_offsets', 'epub_fragment_offsets') THEN EXISTS (
           SELECT 1 FROM fragments f
           WHERE f.media_id = rai.media_id AND f.id::text = rai.locator->>'fragment_id'
         )
         WHEN rai.locator->>'type' = 'pdf_page_geometry' THEN (
           m.page_count IS NOT NULL
           AND rai.locator->>'page_number' ~ '^[0-9]+$'
           AND (rai.locator->>'page_number')::integer BETWEEN 1 AND m.page_count
         )
         ELSE TRUE
       END AS locator_current
FROM reader_apparatus_items rai
JOIN reader_apparatus_states ras ON ras.id = rai.state_id
JOIN media m ON m.id = rai.media_id
JOIN visible_media vm ON vm.media_id = rai.media_id
WHERE rai.id = ANY(:ids) AND ras.status IN ('ready', 'partial')
"""
