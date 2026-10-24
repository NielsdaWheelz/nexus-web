"""Where opening a resource goes: a workspace route, an outside url, or nowhere.

Routing owns no visibility: a caller passes the refs its own hydration found missing,
and those get a ``none`` activation (a route for an unproven ref would leak its
parent's identity). A route names the occurrence (I5): ``#highlight-``, ``#fragment-``,
``#evidence-``, ``#chunk-``, ``#passage-``, ``#oracle-passage-``, ``?apparatus_id``,
``?message``. A passage routes only while it lands (``locations``). Every read is one
set query per scheme, never one per ref.
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
from nexus.services import locator_resolver
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.locations import current_passages

_STATIC_PREFIXES = {
    "page": "/pages",
    "note_block": "/notes",
    "media": "/media",
    "conversation": "/conversations",
    "library": "/libraries",
    "oracle_reading": "/oracle",
    "podcast": "/podcasts",
}
_OWNER_PREFIXES = {"media": "/media", "note_block": "/notes"}
_PASSAGE_ANCHORS = {
    "evidence_span": "evidence",
    "content_chunk": "chunk",
    "oracle_passage_anchor": "oracle-passage",
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
    for uri in unique:
        if (href := routes.get(uri)) is not None:
            activations[uri] = ResourceActivationOut(resource_ref=uri, kind="route", href=href)
        elif (url := external.get(uri)) is not None:
            activations[uri] = ResourceActivationOut(resource_ref=uri, kind="external", href=url)
        else:
            activations[uri] = ResourceActivationOut(
                resource_ref=uri,
                kind="none",
                href=None,
                unavailable_reason="source_unavailable"
                if uri in missing_ref_uris
                else "location_unavailable",
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


def _external_urls(db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]) -> dict[str, str]:
    if not refs:
        return {}
    rows = db.execute(
        text(
            "SELECT id, url FROM resource_external_snapshots"
            " WHERE id = ANY(:ids) AND user_id = :viewer_id"
        ),
        {"ids": [ref.id for ref in refs], "viewer_id": viewer_id},
    ).all()
    return {f"external_snapshot:{row[0]}": str(row[1]) for row in rows if row[1]}


def _dynamic_routes(
    db: Session, *, viewer_id: UUID, by_scheme: dict[str, list[ResourceRef]]
) -> dict[str, str]:
    def rows(sql: str, refs: Sequence[ResourceRef]) -> Sequence[Any]:
        if not refs:
            return []
        return db.execute(
            text(sql), {"ids": [ref.id for ref in refs], "viewer_id": viewer_id}
        ).all()

    routes: dict[str, str] = {}
    highlights = [ref.id for ref in by_scheme["highlight"]]
    for id_, source in locator_resolver.read_highlight_reader_sources(
        db, highlight_ids=highlights
    ).items():
        if source.target is not None:
            routes[f"highlight:{id_}"] = f"/media/{source.media_id}#highlight-{id_}"
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
            media_id=row.media_id,
            item_id=row.id,
            stable_key=str(row.stable_key),
            locator_present=bool(row.locator_present),
            locator_status=cast(ReaderApparatusLocatorStatus, str(row.locator_status)),
            locator_current=bool(row.locator_current),
        )
        if route is not None:
            routes[f"reader_apparatus_item:{row.id}"] = route
    for id_, handle in rows(
        "SELECT id, handle FROM contributors WHERE id = ANY(:ids)", by_scheme["contributor"]
    ):
        routes[f"contributor:{id_}"] = f"/authors/{quote(str(handle), safe='')}"
    anchors = rows(
        "SELECT id, owner_scheme, owner_id, selector FROM passage_anchors"
        " WHERE id = ANY(:ids) AND user_id = :viewer_id",
        by_scheme["passage_anchor"],
    )
    sources = (
        locator_resolver.read_passage_sources(db, [(row[1], row[2]) for row in anchors])
        if anchors
        else None
    )
    for id_, owner_scheme, owner_id, selector in anchors:
        found = locator_resolver.resolve_passage_selector(
            db,
            owner_scheme=owner_scheme,
            owner_id=owner_id,
            exact=selector["quote"]["exact"],
            prefix=selector["quote"].get("prefix", ""),
            suffix=selector["quote"].get("suffix", ""),
            locator_hint=selector.get("locator_hint"),
            source_reads=sources,
        )
        if owner_scheme in _OWNER_PREFIXES and found.locator is not None:
            routes[f"passage_anchor:{id_}"] = (
                f"{_OWNER_PREFIXES[owner_scheme]}/{owner_id}#passage-{id_}"
            )
    passages = [ref for scheme in _PASSAGE_ANCHORS for ref in by_scheme[scheme]]
    if passages:
        located = current_passages(db, viewer_id=viewer_id, refs=passages)
        for ref in passages:
            passage = located.get(ref.uri)
            if passage is not None and passage.locator is not None:
                prefix = _OWNER_PREFIXES[passage.owner.scheme]
                fragment = f"{_PASSAGE_ANCHORS[ref.scheme]}-{ref.id}"
                routes[ref.uri] = f"{prefix}/{passage.owner.id}#{fragment}"
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
