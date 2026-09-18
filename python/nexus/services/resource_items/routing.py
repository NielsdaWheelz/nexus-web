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
from nexus.services.artifacts.registry import visible_persisted_subject_sql
from nexus.services.resource_graph.refs import ResourceRef

_BATCHED_ROUTE_SCHEMES = frozenset(
    {
        "highlight",
        "message",
        "fragment",
        "reader_apparatus_item",
        "content_chunk",
        "evidence_span",
        "artifact",
        "artifact_revision",
        "contributor",
        "oracle_passage_anchor",
        "passage_anchor",
    }
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


def resource_activation_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool
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

    route = route_for_ref(db, viewer_id=viewer_id, ref=ref, missing=False)
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
    """Batch every route admitted by the heterogeneous resource surface.

    Visibility comes from canonical resource hydration via missing_ref_uris.
    Query count is bounded by the finite set of schemes, never by ref count.
    """

    unique = {ref.uri: ref for ref in refs}
    visible = [ref for ref in unique.values() if ref.uri not in missing_ref_uris]

    routes = {ref.uri: route for ref in visible if (route := _static_route(ref)) is not None}
    routes.update(_routes_for_refs(db, viewer_id=viewer_id, refs=visible))
    external_urls = _external_urls_for_refs(db, viewer_id=viewer_id, refs=visible)
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
        elif ref.scheme == "external_snapshot":
            url = external_urls.get(ref.uri)
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="external" if url is not None else "none",
                href=url,
                unresolved_reason=None if url is not None else "not_routeable",
            )
        else:
            activations[ref.uri] = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unresolved_reason="not_routeable",
            )
    return activations


def _external_urls_for_refs(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
) -> dict[str, str]:
    snapshot_refs = [ref for ref in refs if ref.scheme == "external_snapshot"]
    if not snapshot_refs:
        return {}
    rows = db.execute(
        text(
            """
            SELECT id, url
            FROM resource_external_snapshots
            WHERE id = ANY(:ids) AND user_id = :viewer_id
            """
        ),
        {
            "ids": [ref.id for ref in snapshot_refs],
            "viewer_id": viewer_id,
        },
    ).all()
    return {
        f"external_snapshot:{row[0]}": str(row[1])
        for row in rows
        if isinstance(row[1], str) and row[1]
    }


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
    routes.update(_dynamic_routes_for_refs(db, viewer_id=viewer_id, by_scheme=by_scheme))
    return routes


def _dynamic_routes_for_refs(
    db: Session,
    *,
    viewer_id: UUID,
    by_scheme: dict[str, list[ResourceRef]],
) -> dict[str, str]:
    """Resolve non-static adjacency routes with one set query per scheme."""

    routes: dict[str, str] = {}
    artifact_refs = by_scheme["artifact"]
    if artifact_refs:
        rows = db.execute(
            text(
                f"""
                SELECT a.id
                FROM artifacts a
                WHERE a.id = ANY(:ids)
                  AND {visible_persisted_subject_sql("a")}
                """
            ),
            {
                "ids": [ref.id for ref in artifact_refs],
                "viewer_id": viewer_id,
                "viewer_id_text": str(viewer_id),
            },
        ).all()
        routes.update({f"artifact:{row[0]}": f"/artifacts/artifact:{row[0]}" for row in rows})

    revision_refs = by_scheme["artifact_revision"]
    if revision_refs:
        rows = db.execute(
            text(
                f"""
                SELECT r.id, a.id
                FROM artifact_revisions r
                JOIN artifact_builds b ON b.id = r.build_id
                JOIN artifacts a ON a.id = b.artifact_id
                WHERE r.id = ANY(:ids)
                  AND {visible_persisted_subject_sql("a")}
                """
            ),
            {
                "ids": [ref.id for ref in revision_refs],
                "viewer_id": viewer_id,
                "viewer_id_text": str(viewer_id),
            },
        ).all()
        routes.update(
            {
                f"artifact_revision:{row[0]}": (
                    f"/artifacts/artifact:{row[1]}?revision=artifact_revision:{row[0]}"
                )
                for row in rows
            }
        )

    oracle_targets: dict[UUID, ResourceRef] = {}
    oracle_refs = by_scheme["oracle_passage_anchor"]
    if oracle_refs:
        rows = db.execute(
            text(
                """
                SELECT id, current_evidence_span_id, current_content_chunk_id
                FROM oracle_passage_anchors
                WHERE id = ANY(:ids) AND resolution_status = 'resolved'
                """
            ),
            {"ids": [ref.id for ref in oracle_refs]},
        ).all()
        for row in rows:
            if row[1] is not None:
                oracle_targets[UUID(str(row[0]))] = ResourceRef(
                    scheme="evidence_span",
                    id=UUID(str(row[1])),
                )
            elif row[2] is not None:
                oracle_targets[UUID(str(row[0]))] = ResourceRef(
                    scheme="content_chunk",
                    id=UUID(str(row[2])),
                )

    chunk_ids = {ref.id for ref in by_scheme["content_chunk"]}
    chunk_ids.update(
        target.id for target in oracle_targets.values() if target.scheme == "content_chunk"
    )
    chunk_rows: dict[UUID, Any] = {}
    if chunk_ids:
        rows = db.execute(
            text(
                """
                SELECT id, owner_kind, owner_id, primary_evidence_span_id, summary_locator
                FROM content_chunks
                WHERE id = ANY(:ids)
                """
            ),
            {"ids": list(chunk_ids)},
        ).all()
        chunk_rows = {UUID(str(row[0])): row for row in rows}

    evidence_ids = {ref.id for ref in by_scheme["evidence_span"]}
    evidence_ids.update(
        target.id for target in oracle_targets.values() if target.scheme == "evidence_span"
    )
    evidence_ids.update(UUID(str(row[3])) for row in chunk_rows.values() if row[3] is not None)
    evidence_rows: dict[UUID, Any] = {}
    if evidence_ids:
        rows = db.execute(
            text(
                """
                SELECT id, owner_kind, owner_id, selector, resolver_kind
                FROM evidence_spans
                WHERE id = ANY(:ids)
                """
            ),
            {"ids": list(evidence_ids)},
        ).all()
        evidence_rows = {UUID(str(row[0])): row for row in rows}

    evidence_routes = {
        evidence_id: route
        for evidence_id, row in evidence_rows.items()
        if (route := _route_for_evidence_row(evidence_id, row)) is not None
    }
    routes.update(
        {
            f"evidence_span:{ref.id}": evidence_routes[ref.id]
            for ref in by_scheme["evidence_span"]
            if ref.id in evidence_routes
        }
    )

    chunk_routes = {
        chunk_id: route
        for chunk_id, row in chunk_rows.items()
        if (route := _route_for_content_chunk_row(row, evidence_routes=evidence_routes)) is not None
    }
    routes.update(
        {
            f"content_chunk:{ref.id}": chunk_routes[ref.id]
            for ref in by_scheme["content_chunk"]
            if ref.id in chunk_routes
        }
    )
    for anchor_id, target in oracle_targets.items():
        route = (
            evidence_routes.get(target.id)
            if target.scheme == "evidence_span"
            else chunk_routes.get(target.id)
        )
        if route is not None:
            routes[f"oracle_passage_anchor:{anchor_id}"] = route

    contributor_ids = {ref.id for ref in by_scheme["contributor"]}
    contributor_handles: dict[UUID, str] = {}
    if contributor_ids:
        rows = db.execute(
            text("SELECT id, handle FROM contributors WHERE id = ANY(:ids)"),
            {"ids": list(contributor_ids)},
        ).all()
        contributor_handles = {UUID(str(row[0])): str(row[1]) for row in rows}
    routes.update(
        {
            f"contributor:{ref.id}": f"/authors/{quote(contributor_handles[ref.id], safe='')}"
            for ref in by_scheme["contributor"]
            if ref.id in contributor_handles
        }
    )

    passage_refs = by_scheme["passage_anchor"]
    if passage_refs:
        rows = db.execute(
            text(
                """
                SELECT id, owner_scheme, owner_id
                FROM passage_anchors
                WHERE id = ANY(:ids) AND user_id = :viewer_id
                """
            ),
            {
                "ids": [ref.id for ref in passage_refs],
                "viewer_id": viewer_id,
            },
        ).all()
        for row in rows:
            if row[1] == "media":
                routes[f"passage_anchor:{row[0]}"] = f"/media/{row[2]}#passage-{row[0]}"
            elif row[1] == "note_block":
                routes[f"passage_anchor:{row[0]}"] = f"/notes/{row[2]}#passage-{row[0]}"

    return routes


def _route_for_evidence_row(evidence_id: UUID, row: Any) -> str | None:
    owner_kind = str(row[1])
    if owner_kind == "media":
        return f"/media/{row[2]}#evidence-{evidence_id}"
    if owner_kind != "note_block" or str(row[4]) != "note":
        return None
    selector = row[3] if isinstance(row[3], dict) else {}
    block_id = selector.get("note_block_id")
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if (
        not isinstance(block_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
        or start_offset < 0
        or end_offset <= start_offset
    ):
        return None
    return f"/notes/{block_id}"


def _route_for_content_chunk_row(
    row: Any,
    *,
    evidence_routes: dict[UUID, str],
) -> str | None:
    primary_span_id = row[3]
    if primary_span_id is not None:
        return evidence_routes.get(UUID(str(primary_span_id)))
    owner_kind = str(row[1])
    if owner_kind == "media":
        return f"/media/{row[2]}"
    if owner_kind != "note_block":
        return None
    locator = row[4] if isinstance(row[4], dict) else {}
    block_id = locator.get("note_block_id")
    start_offset = locator.get("start_offset")
    end_offset = locator.get("end_offset")
    if (
        not isinstance(block_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
        or start_offset < 0
        or end_offset <= start_offset
    ):
        return None
    return f"/notes/{block_id}"


def route_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool) -> str | None:
    """The one route for a single ref.

    ``missing`` is the caller's own hydration verdict for this ref. Routing owns
    no per-ref visibility predicate: a ref the caller has not proven visible must
    arrive ``missing=True`` or its route leaks the parent's identity. The
    parameter has no default so a new caller cannot skip the obligation.
    """
    if missing:
        return None
    return _static_route(ref) or _routes_for_refs(db, viewer_id=viewer_id, refs=[ref]).get(ref.uri)
