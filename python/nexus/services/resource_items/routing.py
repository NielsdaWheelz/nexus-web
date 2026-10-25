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
from collections.abc import Mapping, Sequence
from typing import Any, assert_never
from urllib.parse import quote, urlencode
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.reader_apparatus import ReaderApparatusLocatorStatus
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import locator_resolver
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.locations import (
    ScopedMediaPassage,
    media_passages,
)

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
    reading_media_ids: Mapping[str, UUID] | None = None,
) -> dict[str, ResourceActivationOut]:
    """One activation per ref; missing refs get ``none``.

    A per-ref reading selects within current authority. Absent entries use the
    authorized preferred reading; the map cannot authorize an otherwise hidden ref.
    """
    visible = [
        ref for ref in {ref.uri: ref for ref in refs}.values() if ref.uri not in missing_ref_uris
    ]
    scoped = media_passages(
        db, viewer_id=viewer_id, refs=visible, reading_media_ids=reading_media_ids
    )
    return _activations_from_resolved_passages(
        db, viewer_id=viewer_id, refs=refs, missing_ref_uris=missing_ref_uris, scoped=scoped
    )


def _activations_from_resolved_passages(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    missing_ref_uris: set[str] | frozenset[str],
    scoped: Mapping[str, ScopedMediaPassage],
) -> dict[str, ResourceActivationOut]:
    """Use hydration's authorized passage facts for this viewer, reading and snapshot.

    Absent entries are authoritative; never replace them with another media reading.
    Missing refs suppress every activation, including an otherwise resolved passage.
    """
    unique = {ref.uri: ref for ref in refs}
    visible = [ref for uri, ref in unique.items() if uri not in missing_ref_uris]
    by_scheme: dict[str, list[ResourceRef]] = defaultdict(list)
    for ref in visible:
        if (
            ref.scheme not in {"highlight", "fragment", "reader_apparatus_item"}
            and ref.uri not in scoped
        ):
            by_scheme[ref.scheme].append(ref)
    routes = {
        ref.uri: f"{_STATIC_PREFIXES[ref.scheme]}/{ref.id}"
        for ref in visible
        if ref.scheme in _STATIC_PREFIXES
    }
    routes.update(_dynamic_routes(db, viewer_id=viewer_id, by_scheme=by_scheme))
    canonical_schemes = {
        "highlight",
        "fragment",
        "reader_apparatus_item",
        "content_chunk",
        "evidence_span",
        "oracle_passage_anchor",
    }
    apparatus_ids = [
        ref.id for ref in visible if ref.scheme == "reader_apparatus_item" and ref.uri in scoped
    ]
    apparatus = {
        row.id: row
        for row in db.execute(
            text("SELECT id,stable_key FROM reader_apparatus_items WHERE id=ANY(:ids)"),
            {"ids": apparatus_ids},
        )
    }
    for ref in visible:
        if ref.scheme not in canonical_schemes and ref.scheme != "passage_anchor":
            continue
        passage = scoped.get(ref.uri)
        if passage is None:
            if ref.scheme in canonical_schemes or routes.get(ref.uri, "").startswith("/media/"):
                routes.pop(ref.uri, None)
            continue
        if ref.scheme == "reader_apparatus_item":
            row = apparatus[ref.id]
            routes[ref.uri] = (
                f"/media/{passage.owner.id}?{urlencode({'apparatus': row.stable_key, 'apparatus_id': str(ref.id)})}"
            )
        elif passage.locator is not None:
            fragment = {
                "highlight": "highlight",
                "fragment": "fragment",
                "passage_anchor": "passage",
            }.get(ref.scheme, _PASSAGE_ANCHORS.get(ref.scheme))
            routes[ref.uri] = f"/media/{passage.owner.id}#{fragment}-{ref.id}"
        else:
            routes.pop(ref.uri, None)
    external = _external_urls(db, viewer_id=viewer_id, refs=by_scheme["external_snapshot"])
    activations: dict[str, ResourceActivationOut] = {}
    for uri in unique:
        if (href := routes.get(uri)) is not None:
            owner = scoped[uri].owner.uri if uri in scoped else uri
            activations[uri] = ResourceActivationOut(resource_ref=owner, kind="route", href=href)
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
    for id_, conversation_id in rows(
        "SELECT id, conversation_id FROM messages WHERE id = ANY(:ids)", by_scheme["message"]
    ):
        routes[f"message:{id_}"] = f"/conversations/{conversation_id}?message={id_}"
    for id_, handle in rows(
        "SELECT id, handle FROM contributors WHERE id = ANY(:ids)", by_scheme["contributor"]
    ):
        routes[f"contributor:{id_}"] = f"/authors/{quote(str(handle), safe='')}"
    anchors = rows(
        "SELECT id, owner_scheme, owner_id, selector FROM passage_anchors"
        " WHERE id = ANY(:ids) AND user_id = :viewer_id AND owner_scheme != 'media'",
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
    return routes
