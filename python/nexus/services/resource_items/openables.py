"""Bounded route-only projection over the canonical lexical candidate engine."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.presence import Present
from nexus.schemas.resource_openables import (
    ResourceOpenableSearchRequest,
    ResourceOpenableSearchResponse,
)
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_items.surfaces import resource_items_out
from nexus.services.search.candidates import (
    REFERENCE_CANDIDATES_PER_SOURCE,
    TargetCandidate,
    candidate_resource_ref,
    reference_candidates,
)

OPENABLE_SEARCH_RESULT_LIMIT = 20


def search_openable_resources(
    db: Session,
    *,
    viewer_id: UUID,
    request: ResourceOpenableSearchRequest,
) -> ResourceOpenableSearchResponse:
    schemes = set(request.schemes.value) if isinstance(request.schemes, Present) else None
    candidates = reference_candidates(
        db,
        viewer_id,
        q=request.q,
        schemes=schemes,
        limit_per_source=REFERENCE_CANDIDATES_PER_SOURCE,
    )

    exact_ref = parse_resource_ref(request.q)
    if isinstance(exact_ref, ResourceRef):
        refs = [exact_ref] if schemes is None or exact_ref.scheme in schemes else []
    else:
        refs = _dedupe_candidate_refs(candidates)

    items = resource_items_out(db, viewer_id=viewer_id, refs=refs) if refs else []
    admitted = [item for item in items if not item.missing and item.activation.kind == "route"]
    return ResourceOpenableSearchResponse(items=admitted[:OPENABLE_SEARCH_RESULT_LIMIT])


def _dedupe_candidate_refs(candidates: list[TargetCandidate]) -> list[ResourceRef]:
    refs: list[ResourceRef] = []
    seen: set[str] = set()
    for candidate in candidates:
        ref = candidate_resource_ref(candidate)
        if ref.uri in seen:
            continue
        seen.add(ref.uri)
        refs.append(ref)
    return refs
