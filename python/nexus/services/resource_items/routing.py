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
from typing import Any, Literal, assert_never
from urllib.parse import quote, urlencode
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.reader_apparatus import ReaderApparatusLocatorStatus
from nexus.schemas.resource_evidence import CapturedPassageTarget, ResourceField
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import locator_resolver
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
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
    "feed": "/feeds",
}
_OWNER_PREFIXES = {"media": "/media", "note_block": "/notes", "highlight": "/highlights"}
_PASSAGE_ANCHORS = {
    "evidence_span": "evidence",
    "content_chunk": "chunk",
    "oracle_passage_anchor": "oracle-passage",
}


def captured_passage_activation(target: CapturedPassageTarget) -> ResourceActivationOut:
    """An already admitted passage's source route, without rereading its body.

    The occurrence's source-target key separately proves its exact current location.
    Callers supply evidence accepted by the evidence owner's disclosure gate.
    """
    owner = assert_resource_ref(target.owner_ref)
    if owner.scheme == "external_snapshot" and target.locator.type == "external_url":
        return ResourceActivationOut(
            field=target.field, resource_ref=owner.uri, kind="external", href=target.locator.url
        )
    if owner.scheme == "media":
        href = f"/media/{owner.id}"
    elif owner.scheme == "fragment" and target.locator.type == "x_capture_offsets":
        href = f"/x/captures/{target.locator.capture_id}"
    elif owner.scheme == "note_block":
        href = f"/notes/{owner.id}"
    elif owner.scheme == "highlight" and target.field == "annotation":
        href = f"/highlights/{owner.id}#annotation"
    elif owner.scheme == "conversation" and target.locator.type == "message_offsets":
        href = f"/conversations/{owner.id}?{urlencode({'message': str(target.locator.message_id)})}"
    else:
        # justify-defect: captured passage owners have one explicit source route.
        raise AssertionError("captured passage has no source route")
    return ResourceActivationOut(
        field=target.field, resource_ref=owner.uri, kind="route", href=href
    )


def source_activation_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, field: ResourceField
) -> ResourceActivationOut:
    """Open an already authorized source identity without projecting its passages."""
    href = None
    kind: Literal["route", "external"] = "route"
    if ref.scheme in _STATIC_PREFIXES:
        href = f"{_STATIC_PREFIXES[ref.scheme]}/{ref.id}"
    elif ref.scheme == "fragment":
        capture_id = db.scalar(
            text("SELECT x_post_capture_id FROM fragments WHERE id=:id"), {"id": ref.id}
        )
        if capture_id is not None:
            href = f"/x/captures/{capture_id}"
    elif ref.scheme == "highlight" and field == "annotation":
        href = f"/highlights/{ref.id}#annotation"
    elif ref.scheme == "external_snapshot":
        href = _external_urls(db, viewer_id=viewer_id, refs=[ref]).get(ref.uri)
        kind = "external"
    elif ref.scheme == "contributor":
        handle = db.scalar(text("SELECT handle FROM contributors WHERE id=:id"), {"id": ref.id})
        if handle is not None:
            href = f"/authors/{quote(str(handle), safe='')}"
    return ResourceActivationOut(
        field=field,
        resource_ref=ref.uri,
        kind=kind if href is not None else "none",
        href=href,
        unavailable_reason=None if href is not None else "location_unavailable",
    )


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
        db,
        include_excerpts=False,
        viewer_id=viewer_id,
        refs=visible,
        reading_media_ids=reading_media_ids,
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
    empty_capture_routes = {
        row.id: row.capture_id
        for row in db.execute(
            text("""
            SELECT id,x_post_capture_id AS capture_id FROM fragments
            WHERE id=ANY(:ids) AND x_post_capture_id IS NOT NULL AND canonical_text=''
        """),
            {
                "ids": [
                    ref.id for ref in visible if ref.scheme == "fragment" and ref.uri not in scoped
                ]
            },
        )
    }
    for ref in visible:
        if ref.scheme not in canonical_schemes and ref.scheme != "passage_anchor":
            continue
        passage = scoped.get(ref.uri)
        if passage is None:
            if ref.scheme == "fragment" and ref.id in empty_capture_routes:
                routes[ref.uri] = f"/x/captures/{empty_capture_routes[ref.id]}#fragment-{ref.id}"
                continue
            if ref.scheme in canonical_schemes or routes.get(ref.uri, "").startswith("/media/"):
                routes.pop(ref.uri, None)
            continue
        fragment = {
            "highlight": "highlight",
            "fragment": "fragment",
            "passage_anchor": "passage",
        }.get(ref.scheme, _PASSAGE_ANCHORS.get(ref.scheme))
        if passage.locator is not None and passage.locator.get("type") == "x_capture_offsets":
            capture_id = passage.locator["capture_id"]
            routes[ref.uri] = f"/x/captures/{capture_id}#{fragment}-{ref.id}"
        elif ref.scheme == "reader_apparatus_item":
            row = apparatus[ref.id]
            routes[ref.uri] = (
                f"/media/{passage.owner.id}?{urlencode({'apparatus': row.stable_key, 'apparatus_id': str(ref.id)})}"
            )
        elif passage.locator is not None:
            routes[ref.uri] = f"/media/{passage.owner.id}#{fragment}-{ref.id}"
        else:
            routes.pop(ref.uri, None)
    owned_highlights = list(
        db.scalars(
            text(
                "SELECT id FROM highlights WHERE id=ANY(:ids) AND user_id=:viewer_id AND authored_visible"
            ),
            {
                "ids": [ref.id for ref in visible if ref.scheme == "highlight"],
                "viewer_id": viewer_id,
            },
        )
    )
    for id_ in owned_highlights:
        uri = f"highlight:{id_}"
        if uri not in routes:
            routes[uri] = f"/highlights/{id_}"
    external = _external_urls(db, viewer_id=viewer_id, refs=by_scheme["external_snapshot"])
    activations: dict[str, ResourceActivationOut] = {}
    for uri in unique:
        if (href := routes.get(uri)) is not None:
            owner = (
                scoped[uri].owner.uri
                if uri in scoped and not href.startswith("/highlights/")
                else uri
            )
            field = None
            if href.startswith("/highlights/") and unique[uri].scheme != "highlight":
                owner = "highlight:" + href.split("/", 2)[2].split("#", 1)[0]
                field = "annotation"
            activations[uri] = ResourceActivationOut(
                field=field, resource_ref=owner, kind="route", href=href
            )
        elif (url := external.get(uri)) is not None:
            activations[uri] = ResourceActivationOut(
                field=None, resource_ref=uri, kind="external", href=url
            )
        else:
            activations[uri] = ResourceActivationOut(
                field=None,
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
    from nexus.services.resource_graph.citations import external_snapshot_visible_sql

    rows = db.execute(
        text(
            "SELECT s.id, s.url FROM resource_external_snapshots s"
            f" WHERE s.id = ANY(:ids) AND {external_snapshot_visible_sql('s')}"
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
    for scheme, table in (("content_chunk", "content_chunks"), ("evidence_span", "evidence_spans")):
        for id_, owner_id in rows(
            f"SELECT body.id,body.owner_id FROM {table} body JOIN highlights h ON h.id=body.owner_id JOIN content_index_states state ON state.owner_kind='highlight' AND state.owner_id=h.id WHERE body.id=ANY(:ids) AND body.owner_kind='highlight' AND h.user_id=:viewer_id AND h.authored_visible AND h.annotation_body_pm_json IS NOT NULL AND state.lexical_revision=state.revision",
            by_scheme[scheme],
        ):
            routes[f"{scheme}:{id_}"] = f"/highlights/{owner_id}#annotation"
    anchors = rows(
        "SELECT id, owner_scheme, owner_id, selector FROM passage_anchors"
        " WHERE id = ANY(:ids) AND user_id = :viewer_id AND owner_scheme != 'media'",
        by_scheme["passage_anchor"],
    )
    sources = (
        locator_resolver.read_passage_sources(
            db, [(row[1], row[2]) for row in anchors], viewer_id=viewer_id
        )
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
