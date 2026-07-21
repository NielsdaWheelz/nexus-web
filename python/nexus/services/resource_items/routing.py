"""Resource route and activation policy."""

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
from nexus.services.resource_graph.resolve import (
    oracle_anchor_current_target,
    reader_target_for_citation_target,
)

_BATCHED_ROUTE_SCHEMES = frozenset({"highlight", "message", "fragment", "reader_apparatus_item"})


def route_for_visible_apparatus_item(
    *,
    media_id: UUID,
    item_id: UUID,
    stable_key: str,
    locator_present: bool,
    locator_status: ReaderApparatusLocatorStatus,
    locator_current: bool,
) -> str | None:
    """Build the canonical route for an apparatus item already proven visible."""

    if not locator_present or not locator_current:
        return None
    match locator_status:
        case "exact" | "container":
            pass
        case "missing":
            return None
        case _ as unreachable:
            assert_never(unreachable)
    params = urlencode({"apparatus": stable_key, "apparatus_id": str(item_id)})
    return f"/media/{media_id}?{params}"


def _artifact_subject_route(row: Any, *, revision_id: UUID | None) -> str | None:
    """Route an artifact head/revision by its subject scheme (§4.1).

    ``library`` -> the dossier tab (unchanged, D-7); ``conversation`` -> the
    conversation with the distillate forced open (§4.5).
    """
    if row is None:
        return None
    subject_scheme, subject_id = row[0], row[1]
    if subject_scheme == "library":
        base = f"/libraries/{subject_id}?tab=intelligence"
        return f"{base}&revision={revision_id}" if revision_id is not None else base
    if subject_scheme == "conversation":
        return f"/conversations/{subject_id}?distillate=1"
    return None


def resource_activation_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool = False
) -> ResourceActivationOut:
    if missing:
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="none",
            href=None,
            unresolved_reason="missing",
        )

    if ref.scheme == "external_snapshot":
        url = db.scalar(
            text(
                """
                SELECT url
                FROM resource_external_snapshots
                WHERE id = :id AND user_id = :viewer_id
                """
            ),
            {"id": ref.id, "viewer_id": viewer_id},
        )
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="external" if isinstance(url, str) and url else "none",
            href=url if isinstance(url, str) and url else None,
            unresolved_reason=None if isinstance(url, str) and url else "not_routeable",
        )

    route = route_for_ref(db, viewer_id=viewer_id, ref=ref)
    return ResourceActivationOut(
        resource_ref=ref.uri,
        kind="route" if route is not None else "none",
        href=route,
        unresolved_reason=None if route is not None else "not_routeable",
    )


def resource_activations_for_refs(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    missing_ref_uris: set[str] | frozenset[str] = frozenset(),
) -> dict[str, ResourceActivationOut]:
    """Batch deterministic high-volume graph routes and delegate the rest.

    Visibility comes from canonical resource hydration via missing_ref_uris.
    Locator-sensitive schemes stay on resource_activation_for_ref so this
    optimization cannot fork their current/stale routing semantics.
    """

    unique = {ref.uri: ref for ref in refs}
    visible = [ref for ref in unique.values() if ref.uri not in missing_ref_uris]

    routes = {ref.uri: route for ref in visible if (route := _static_route(ref)) is not None}
    routes.update(_routes_for_refs(db, viewer_id=viewer_id, refs=visible))
    activations: dict[str, ResourceActivationOut] = {}
    for ref in unique.values():
        if ref.uri in missing_ref_uris:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unresolved_reason="missing",
            )
            continue
        href = routes.get(ref.uri)
        if href is not None:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="route",
                href=href,
                unresolved_reason=None,
            )
        elif ref.scheme in _BATCHED_ROUTE_SCHEMES or _static_route(ref) is not None:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unresolved_reason="not_routeable",
            )
        else:
            activations[ref.uri] = resource_activation_for_ref(
                db,
                viewer_id=viewer_id,
                ref=ref,
            )
    return activations


def _static_route(ref: ResourceRef) -> str | None:
    prefixes = {
        "page": "/pages",
        "note_block": "/notes",
        "media": "/media",
        "conversation": "/conversations",
        "library": "/libraries",
        "oracle_reading": "/oracle",
        "podcast": "/podcasts",
    }
    prefix = prefixes.get(ref.scheme)
    return f"{prefix}/{ref.id}" if prefix is not None else None


def _routes_for_refs(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
) -> dict[str, str]:
    by_scheme: dict[str, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        if ref.scheme in _BATCHED_ROUTE_SCHEMES:
            by_scheme[ref.scheme].append(ref)

    routes: dict[str, str] = {}
    highlight_refs = by_scheme["highlight"]
    if highlight_refs:
        rows = db.execute(
            text("SELECT id, anchor_media_id FROM highlights WHERE id = ANY(:ids)"),
            {"ids": [ref.id for ref in highlight_refs]},
        ).all()
        routes.update(
            {f"highlight:{row[0]}": f"/media/{row[1]}#highlight-{row[0]}" for row in rows}
        )

    message_refs = by_scheme["message"]
    if message_refs:
        rows = db.execute(
            text("SELECT id, conversation_id FROM messages WHERE id = ANY(:ids)"),
            {"ids": [ref.id for ref in message_refs]},
        ).all()
        routes.update(
            {f"message:{row[0]}": f"/conversations/{row[1]}?message={row[0]}" for row in rows}
        )

    fragment_refs = by_scheme["fragment"]
    if fragment_refs:
        rows = db.execute(
            text("SELECT id, media_id FROM fragments WHERE id = ANY(:ids)"),
            {"ids": [ref.id for ref in fragment_refs]},
        ).all()
        routes.update({f"fragment:{row[0]}": f"/media/{row[1]}#fragment-{row[0]}" for row in rows})

    apparatus_refs = by_scheme["reader_apparatus_item"]
    if apparatus_refs:
        rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT rai.id,
                       rai.media_id,
                       rai.stable_key,
                       rai.locator IS NOT NULL AS locator_present,
                       rai.locator_status,
                       CASE
                         WHEN rai.locator IS NULL THEN FALSE
                         WHEN rai.locator->>'media_id' IS DISTINCT FROM rai.media_id::text
                           THEN FALSE
                         WHEN rai.locator->>'type' IN (
                           'web_text_offsets', 'epub_fragment_offsets'
                         ) THEN EXISTS (
                           SELECT 1
                           FROM fragments f
                           WHERE f.media_id = rai.media_id
                             AND f.id::text = rai.locator->>'fragment_id'
                         )
                         WHEN rai.locator->>'type' = 'pdf_page_geometry' THEN (
                           m.page_count IS NOT NULL
                           AND rai.locator->>'page_number' ~ '^[0-9]+$'
                           AND (rai.locator->>'page_number')::integer
                               BETWEEN 1 AND m.page_count
                         )
                         ELSE TRUE
                       END AS locator_current
                FROM reader_apparatus_items rai
                JOIN reader_apparatus_states ras ON ras.id = rai.state_id
                JOIN media m ON m.id = rai.media_id
                JOIN visible_media vm ON vm.media_id = rai.media_id
                WHERE rai.id = ANY(:ids)
                  AND ras.status IN ('ready', 'partial')
                """
            ),
            {
                "ids": [ref.id for ref in apparatus_refs],
                "viewer_id": viewer_id,
            },
        ).all()
        for row in rows:
            route = route_for_visible_apparatus_item(
                media_id=UUID(str(row[1])),
                item_id=UUID(str(row[0])),
                stable_key=str(row[2]),
                locator_present=bool(row[3]),
                locator_status=cast(ReaderApparatusLocatorStatus, str(row[4])),
                locator_current=bool(row[5]),
            )
            if route is not None:
                routes[f"reader_apparatus_item:{row[0]}"] = route
    return routes


def route_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> str | None:
    static_route = _static_route(ref)
    if static_route is not None:
        return static_route
    if ref.scheme in _BATCHED_ROUTE_SCHEMES:
        return _routes_for_refs(db, viewer_id=viewer_id, refs=[ref]).get(ref.uri)
    if ref.scheme == "content_chunk":
        span_id = db.scalar(
            text("SELECT primary_evidence_span_id FROM content_chunks WHERE id = :id"),
            {"id": ref.id},
        )
        if span_id is not None:
            return route_for_ref(
                db,
                viewer_id=viewer_id,
                ref=ResourceRef(scheme="evidence_span", id=span_id),
            )
        media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
        if media_id is not None:
            if isinstance(locator, dict) and isinstance(locator.get("fragment_id"), str):
                return f"/media/{media_id}#fragment-{locator['fragment_id']}"
            return f"/media/{media_id}"
        if isinstance(locator, dict) and isinstance(locator.get("block_id"), str):
            return f"/notes/{locator['block_id']}"
        return None
    if ref.scheme == "evidence_span":
        media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
        if media_id is not None:
            return f"/media/{media_id}#evidence-{ref.id}"
        if isinstance(locator, dict) and isinstance(locator.get("block_id"), str):
            return f"/notes/{locator['block_id']}"
        return None
    if ref.scheme == "artifact":
        row = db.execute(
            text("SELECT subject_scheme, subject_id FROM artifacts WHERE id = :id"),
            {"id": ref.id},
        ).first()
        return _artifact_subject_route(row, revision_id=None)
    if ref.scheme == "artifact_revision":
        row = db.execute(
            text(
                """
                SELECT a.subject_scheme, a.subject_id
                FROM artifact_revisions r
                JOIN artifacts a ON a.id = r.artifact_id
                WHERE r.id = :id
                """
            ),
            {"id": ref.id},
        ).first()
        return _artifact_subject_route(row, revision_id=ref.id)
    if ref.scheme == "contributor":
        handle = db.scalar(text("SELECT handle FROM contributors WHERE id = :id"), {"id": ref.id})
        return f"/authors/{quote(str(handle), safe='')}" if handle is not None else None
    if ref.scheme == "oracle_passage_anchor":
        current = oracle_anchor_current_target(db, ref.id)
        return route_for_ref(db, viewer_id=viewer_id, ref=current) if current is not None else None
    if ref.scheme == "external_snapshot":
        return None
    assert_never(ref.scheme)
