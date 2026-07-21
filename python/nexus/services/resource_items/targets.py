"""Resource-target admission and projection — the sole target-search owner.

``services/search/candidates.py`` retrieves and ranks; this module admits
(``ResourceUserRelationPolicy``), masks visibility, dedupes by canonical
durable ref, applies exclusions and source self-exclusion — all before any
per-source cap matters — then refills the candidate pool until the requested
page is full or the sources are exhausted, and paginates only the post-filter
ranking (universal-link-authoring-hard-cutover.md, Resource Target Search
rule 5 / AC13). Refill is prefix-stable: one query has ONE ranking, so a
deeper cursor that escalates the retrieval cap never reorders positions an
earlier page was served from. It never mutates: when ``source_ref`` is present the existing
Link/anchor lookup is read-only — an anchor is never materialized here
(rule 8).
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import and_, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import PassageAnchor, ResourceEdge
from nexus.schemas.resource_targets import (
    ResourceTargetOut,
    ResourceTargetPassageOut,
    ResourceTargetResourceOut,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services import locator_resolver, passage_anchors
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_items.capabilities import (
    ResourceUserRelationPolicy,
    capability_for_scheme,
)
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.resource_items.surfaces import _parse_ref_or_error, resource_item_out
from nexus.services.search.candidates import (
    REFERENCE_CANDIDATES_PER_SOURCE,
    TargetCandidate,
    candidate_resource_ref,
    link_candidates,
    reference_candidates,
)
from nexus.services.search.constants import CANDIDATES_PER_TYPE, MIN_QUERY_LENGTH
from nexus.services.search.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.search.projection import _truncate_snippet
from nexus.services.text_quote import QuoteStatus

# Initial per-source retrieval caps; the refill loop doubles them while the
# admitted pool underfills the requested page and retrieval still grows.
_INITIAL_LIMIT_PER_SOURCE = {
    "link": CANDIDATES_PER_TYPE,
    "reference": REFERENCE_CANDIDATES_PER_SOURCE,
}


def search_targets(
    db: Session, *, viewer_id: UUID, request: ResourceTargetSearchRequest
) -> ResourceTargetSearchResponse:
    transaction_active_at_entry = db.in_transaction()
    q = request.q.strip()
    source_ref = _parse_ref_or_error(request.source_ref) if request.source_ref else None
    excluded = {_parse_ref_or_error(raw).uri for raw in request.exclude_refs}
    if source_ref is not None:
        excluded.add(source_ref.uri)
    offset = decode_search_cursor(request.cursor) if request.cursor else 0

    exact_ref = parse_resource_ref(q)
    if isinstance(exact_ref, ResourceRef):
        targets = _exact_ref_targets(
            db,
            viewer_id=viewer_id,
            ref=exact_ref,
            request=request,
            source_ref=source_ref,
            excluded=excluded,
        )
        return ResourceTargetSearchResponse(
            targets=targets[offset : offset + request.limit], next_cursor=None
        )

    # Per-purpose acceptance: reference accepts one character; link keeps the
    # ordinary-search minimum (empty page, not an error — matches /search).
    if not q or (request.purpose == "link" and len(q) < MIN_QUERY_LENGTH):
        return ResourceTargetSearchResponse(targets=[], next_cursor=None)

    admitted = _admitted_candidates(
        db,
        viewer_id,
        request=request,
        q=q,
        excluded=excluded,
        needed=offset + request.limit + 1,
        transaction_active_at_entry=transaction_active_at_entry,
    )
    page = admitted[offset : offset + request.limit]
    targets = [
        target
        for candidate in page
        if (target := _project(db, viewer_id=viewer_id, candidate=candidate, source_ref=source_ref))
        is not None
    ]
    next_cursor = (
        encode_search_cursor(offset + request.limit)
        if len(admitted) > offset + request.limit
        else None
    )
    return ResourceTargetSearchResponse(targets=targets, next_cursor=next_cursor)


# =============================================================================
# Admission (policy + dedupe + exclusions, all pre-pagination) and refill
# =============================================================================


def _admitted_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    request: ResourceTargetSearchRequest,
    q: str,
    excluded: set[str],
    needed: int,
    transaction_active_at_entry: bool,
) -> list[TargetCandidate]:
    schemes = set(request.schemes) if request.schemes is not None else None
    limit_per_source = _INITIAL_LIMIT_PER_SOURCE[request.purpose]
    # Prefix-stable refill (rule 5): every request walks the same deterministic
    # cap escalation from the same initial cap, candidates first seen under a
    # smaller cap keep their positions, and a larger cap only APPENDS its new
    # entrants (in their ranked order). Re-ranking the grown pool instead would
    # let per-type score normalization reshuffle the interleaving earlier pages
    # were sliced from, duplicating or skipping targets across pages.
    ordered: list[TargetCandidate] = []
    seen_uris: set[str] = set()
    previous_pool_size = -1
    while True:
        if request.purpose == "link":
            pool = link_candidates(
                db,
                viewer_id,
                q=q,
                transaction_active_at_entry=transaction_active_at_entry,
                schemes=schemes,
                limit_per_source=limit_per_source,
            )
        else:
            pool = reference_candidates(
                db, viewer_id, q=q, schemes=schemes, limit_per_source=limit_per_source
            )
        for candidate in pool:
            uri = candidate_resource_ref(candidate).uri
            if uri not in seen_uris:
                seen_uris.add(uri)
                ordered.append(candidate)
        admitted = _admit(ordered, purpose=request.purpose, excluded=excluded)
        # Stop when the page (plus the has-more probe) is coverable, or when a
        # larger cap retrieved nothing new (every source is exhausted).
        if len(admitted) >= needed or len(pool) == previous_pool_size:
            return admitted
        previous_pool_size = len(pool)
        limit_per_source *= 2


def _admit(
    pool: list[TargetCandidate], *, purpose: str, excluded: set[str]
) -> list[TargetCandidate]:
    seen: set[str] = set()
    admitted: list[TargetCandidate] = []
    for candidate in pool:
        ref = candidate_resource_ref(candidate)
        if not _policy_admits(_policy_for(ref), purpose=purpose):
            continue
        if ref.uri in excluded or ref.uri in seen:
            continue
        seen.add(ref.uri)
        admitted.append(candidate)
    return admitted


def _policy_for(ref: ResourceRef) -> ResourceUserRelationPolicy:
    return capability_for_scheme(ref.scheme).user_relation


def _policy_admits(policy: ResourceUserRelationPolicy, *, purpose: str) -> bool:
    if purpose == "reference":
        return policy.note_reference_target
    return policy.user_link_target != "none"


# =============================================================================
# Projection
# =============================================================================


def _project(
    db: Session,
    *,
    viewer_id: UUID,
    candidate: TargetCandidate,
    source_ref: ResourceRef | None,
) -> ResourceTargetOut | None:
    ref = candidate_resource_ref(candidate)
    if _policy_for(ref).user_link_target == "materialize_passage":
        return _passage_target(
            db,
            viewer_id=viewer_id,
            candidate_ref=ref,
            excerpt=candidate.snippet,
            source_ref=source_ref,
        )
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
    if item.missing:
        return None
    existing_link_id = (
        _existing_link_id(db, viewer_id=viewer_id, a=source_ref, b=ref)
        if source_ref is not None
        else None
    )
    return ResourceTargetResourceOut(item=item, existing_link_id=existing_link_id)


def _passage_target(
    db: Session,
    *,
    viewer_id: UUID,
    candidate_ref: ResourceRef,
    excerpt: str | None,
    source_ref: ResourceRef | None,
) -> ResourceTargetPassageOut | None:
    quote = _passage_quote(db, ref=candidate_ref)
    if quote is None:
        return None  # underlying index row is gone (stale candidate)
    owner_ref, exact = quote
    source_item = resource_item_out(db, viewer_id=viewer_id, ref=owner_ref)
    if source_item.missing:
        return None  # masked: hidden owner and missing owner are indistinguishable
    existing_link_id = None
    if source_ref is not None:
        anchor_id = _existing_anchor_id(db, viewer_id=viewer_id, owner_ref=owner_ref, exact=exact)
        if anchor_id is not None:
            existing_link_id = _existing_link_id(
                db,
                viewer_id=viewer_id,
                a=source_ref,
                b=ResourceRef(scheme="passage_anchor", id=anchor_id),
            )
    return ResourceTargetPassageOut(
        candidate_ref=candidate_ref.uri,
        source=source_item,
        label=source_item.label,
        excerpt=excerpt if excerpt is not None else _truncate_snippet(exact),
        activation=resource_activation_for_ref(db, viewer_id=viewer_id, ref=candidate_ref),
        existing_link_id=existing_link_id,
    )


# =============================================================================
# Exact-ResourceRef input (rule 6): resolves through ResourceItemOut; hidden
# and nonexistent refs mask identically as an empty page.
# =============================================================================


def _exact_ref_targets(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    request: ResourceTargetSearchRequest,
    source_ref: ResourceRef | None,
    excluded: set[str],
) -> list[ResourceTargetOut]:
    if request.schemes is not None and ref.scheme not in request.schemes:
        return []
    if ref.uri in excluded:
        return []
    policy = _policy_for(ref)
    if not _policy_admits(policy, purpose=request.purpose):
        return []
    if policy.user_link_target == "materialize_passage":
        target = _passage_target(
            db, viewer_id=viewer_id, candidate_ref=ref, excerpt=None, source_ref=source_ref
        )
        return [target] if target is not None else []
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
    if item.missing:
        return []
    existing_link_id = (
        _existing_link_id(db, viewer_id=viewer_id, a=source_ref, b=ref)
        if source_ref is not None
        else None
    )
    return [ResourceTargetResourceOut(item=item, existing_link_id=existing_link_id)]


# =============================================================================
# Non-mutating existing-Link/anchor lookup (rule 8)
# =============================================================================


def _existing_link_id(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    """One neutral user/context Link per unordered pair — check BOTH orientations."""

    def _oriented(source: ResourceRef, target: ResourceRef):
        return and_(
            ResourceEdge.source_scheme == source.scheme,
            ResourceEdge.source_id == source.id,
            ResourceEdge.target_scheme == target.scheme,
            ResourceEdge.target_id == target.id,
        )

    return db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind == "context",
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
            ResourceEdge.source_order_key.is_(None),
            ResourceEdge.target_order_key.is_(None),
            or_(_oriented(a, b), _oriented(b, a)),
        )
    ).scalar_one_or_none()


def _existing_anchor_id(
    db: Session, *, viewer_id: UUID, owner_ref: ResourceRef, exact: str
) -> UUID | None:
    """Derive the canonical anchor key for a passage candidate and look it up.

    Read-only: resolves the normalized quote against current owner text (the
    same derivation ``materialize_or_reuse`` performs) but NEVER materializes.
    A quote that no longer resolves uniquely has no derivable identity, so no
    existing anchor is reported.
    """
    normalized = passage_anchors.normalize_quote_text(exact)
    if not normalized:
        return None
    resolution = locator_resolver.resolve_passage_selector(
        db, owner_scheme=owner_ref.scheme, owner_id=owner_ref.id, exact=normalized
    )
    if resolution.status is not QuoteStatus.unique:
        return None
    anchor_key = passage_anchors.compute_anchor_key(
        exact=normalized, prefix=resolution.prefix, suffix=resolution.suffix
    )
    return db.execute(
        select(PassageAnchor.id).where(
            PassageAnchor.user_id == viewer_id,
            PassageAnchor.owner_scheme == owner_ref.scheme,
            PassageAnchor.owner_id == owner_ref.id,
            PassageAnchor.selector_version == passage_anchors.SELECTOR_VERSION,
            PassageAnchor.anchor_key == anchor_key,
        )
    ).scalar_one_or_none()


def _passage_quote(db: Session, *, ref: ResourceRef) -> tuple[ResourceRef, str] | None:
    """Durable owner ref + quote text for one passage-candidate index row."""
    if ref.scheme in ("content_chunk", "evidence_span"):
        table, column = {
            "content_chunk": ("content_chunks", "chunk_text"),
            "evidence_span": ("evidence_spans", "span_text"),
        }[ref.scheme]
        row = db.execute(
            text(f"SELECT owner_kind, owner_id, {column} FROM {table} WHERE id = :id"),
            {"id": ref.id},
        ).first()
        if row is None:
            return None
        if row[0] not in ("media", "note_block"):
            raise AssertionError(  # justify-defect: owner_kind CHECKs close this vocabulary
                f"Unexpected {table} owner_kind: {row[0]!r}"
            )
        owner_scheme: Literal["media", "note_block"] = row[0]
        return ResourceRef(scheme=owner_scheme, id=row[1]), str(row[2] or "")
    if ref.scheme == "fragment":
        row = db.execute(
            text("SELECT media_id, canonical_text FROM fragments WHERE id = :id"), {"id": ref.id}
        ).first()
        if row is None:
            return None
        return ResourceRef(scheme="media", id=row[0]), str(row[1] or "")
    if ref.scheme == "reader_apparatus_item":
        row = db.execute(
            text(
                "SELECT media_id, COALESCE(body_text, label, '')"
                " FROM reader_apparatus_items WHERE id = :id"
            ),
            {"id": ref.id},
        ).first()
        if row is None:
            return None
        return ResourceRef(scheme="media", id=row[0]), str(row[1] or "")
    if ref.scheme == "oracle_passage_anchor":
        # Mirrors resolve.py's loader: unresolved/stale Oracle anchors fail closed.
        row = db.execute(
            text(
                """
                SELECT s.media_id, COALESCE(es.span_text, cc.chunk_text)
                FROM oracle_passage_anchors a
                JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
                    AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
                LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
                    AND es.owner_kind = 'media' AND es.owner_id = s.media_id
                WHERE a.id = :id
                  AND a.resolution_status = 'resolved'
                  AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)
                """
            ),
            {"id": ref.id},
        ).first()
        if row is None:
            return None
        return ResourceRef(scheme="media", id=row[0]), str(row[1] or "")
    raise AssertionError(  # justify-defect: policy classifies exactly these five schemes
        f"Not a passage-candidate scheme: {ref.scheme}"
    )
