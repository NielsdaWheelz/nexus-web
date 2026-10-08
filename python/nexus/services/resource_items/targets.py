"""Visible, stable endpoint admission for the universal link picker.

Search resolves passage identity without creating anchors. Visibility, exclusions
and canonical deduplication happen before pagination, with prefix-stable refill.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import and_, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import PassageAnchor, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_targets import (
    ResourceTargetOut,
    ResourceTargetPassageOut,
    ResourceTargetResourceOut,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services import locator_resolver, passage_anchors
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_link_mode
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.resource_items.surfaces import _parse_ref_or_error, resource_item_out
from nexus.services.search.candidates import candidate_resource_ref, link_candidates
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.query import (
    CANDIDATES_PER_TYPE,
    MIN_QUERY_LENGTH,
    decode_search_cursor,
    encode_search_cursor,
)
from nexus.services.search.results import _RankedFragmentResult
from nexus.services.search.retrievers import read_fragment_search_content
from nexus.services.text_quote import QuoteStatus


def search_targets(
    db: Session, *, viewer_id: UUID, request: ResourceTargetSearchRequest
) -> ResourceTargetSearchResponse:
    transaction_active_at_entry = db.in_transaction()
    q = request.q.strip()
    requested_source = _parse_ref_or_error(request.source_ref) if request.source_ref else None
    source_identity, source_ref = _source_identity(db, viewer_id=viewer_id, ref=requested_source)
    excluded = {_parse_ref_or_error(raw).uri for raw in request.exclude_refs}
    if requested_source is not None:
        excluded.add(requested_source.uri)
    if source_identity is not None:
        excluded.add(source_identity)
    offset = decode_search_cursor(request.cursor) if request.cursor else 0
    exact_ref = parse_resource_ref(q)
    if isinstance(exact_ref, ResourceRef):
        projection = (
            _project_ref(db, viewer_id=viewer_id, ref=exact_ref, source_ref=source_ref)
            if exact_ref.uri not in excluded
            and (request.schemes is None or exact_ref.scheme in request.schemes)
            else None
        )
        targets = (
            [projection[1]] if projection is not None and projection[0] not in excluded else []
        )
        return ResourceTargetSearchResponse(
            targets=targets[offset : offset + request.limit], next_cursor=None
        )
    if len(q) < MIN_QUERY_LENGTH:
        return ResourceTargetSearchResponse(targets=[], next_cursor=None)

    # Repeat the same cap escalation for every page. Once admitted, an item keeps
    # its place even if a larger retrieval pool changes cross-type normalization.
    schemes = set(request.schemes) if request.schemes is not None else None
    limit_per_source = CANDIDATES_PER_TYPE
    seen_candidates: set[str] = set()
    seen_targets: set[str] = set()
    admitted: list[ResourceTargetOut] = []
    previous_pool_size = -1
    needed = offset + request.limit + 1
    while True:
        pool = link_candidates(
            db,
            viewer_id,
            q=q,
            transaction_active_at_entry=transaction_active_at_entry,
            schemes=schemes,
            limit_per_source=limit_per_source,
        )
        for candidate in pool:
            ref = candidate_resource_ref(candidate)
            if ref.uri in seen_candidates or ref.uri in excluded:
                continue
            seen_candidates.add(ref.uri)
            if isinstance(candidate, _RankedFragmentResult):
                try:
                    excerpt = read_fragment_search_content(
                        db, viewer_id=viewer_id, result=candidate
                    )[0]
                except NotFoundError:
                    continue
            else:
                excerpt = candidate.snippet
            projection = _project_ref(
                db, viewer_id=viewer_id, ref=ref, source_ref=source_ref, excerpt=excerpt
            )
            if projection is None:
                continue
            identity, target = projection
            if identity not in excluded and identity not in seen_targets:
                seen_targets.add(identity)
                admitted.append(target)
        if len(admitted) >= needed or len(pool) == previous_pool_size:
            break
        previous_pool_size = len(pool)
        limit_per_source *= 2
    return ResourceTargetSearchResponse(
        targets=admitted[offset : offset + request.limit],
        next_cursor=encode_search_cursor(offset + request.limit)
        if len(admitted) >= needed
        else None,
    )


def _source_identity(
    db: Session, *, viewer_id: UUID, ref: ResourceRef | None
) -> tuple[str | None, ResourceRef | None]:
    if ref is None:
        return None, None
    mode = resource_link_mode(ref)
    if mode == "none":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked")
    if mode == "direct":
        if resource_item_out(db, viewer_id=viewer_id, ref=ref).missing:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
        return ref.uri, ref
    quote = candidate_owner_and_quote(db, ref=ref)
    if quote is None or resource_item_out(db, viewer_id=viewer_id, ref=quote[0]).missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage not found")
    identity = _passage_identity(db, viewer_id=viewer_id, owner_ref=quote[0], exact=quote[1])
    if identity is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage no longer resolves")
    return identity


def _project_ref(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    source_ref: ResourceRef | None,
    excerpt: str | None = None,
) -> tuple[str, ResourceTargetOut] | None:
    mode = resource_link_mode(ref)
    if mode == "none":
        return None
    if mode == "direct":
        item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
        if item.missing:
            return None
        return ref.uri, ResourceTargetResourceOut(
            item=item,
            existing_link_id=_existing_link_id(db, viewer_id=viewer_id, a=source_ref, b=ref)
            if source_ref is not None
            else None,
        )
    quote = candidate_owner_and_quote(db, ref=ref)
    if quote is None:
        return None
    owner_ref, exact = quote
    source_item = resource_item_out(db, viewer_id=viewer_id, ref=owner_ref)
    if source_item.missing:
        return None
    identity = _passage_identity(db, viewer_id=viewer_id, owner_ref=owner_ref, exact=exact)
    if identity is None:
        return None
    key, anchor_ref = identity
    return key, ResourceTargetPassageOut(
        candidate_ref=ref.uri,
        source=source_item,
        label=source_item.label,
        excerpt=excerpt if excerpt is not None else _truncate_snippet(exact),
        activation=resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref, missing=False),
        existing_link_id=_existing_link_id(db, viewer_id=viewer_id, a=source_ref, b=anchor_ref)
        if source_ref is not None and anchor_ref is not None
        else None,
    )


def _existing_link_id(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    def oriented(source: ResourceRef, target: ResourceRef):
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
            or_(oriented(a, b), oriented(b, a)),
        )
    ).scalar_one_or_none()


def _passage_identity(
    db: Session, *, viewer_id: UUID, owner_ref: ResourceRef, exact: str
) -> tuple[str, ResourceRef | None] | None:
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
    anchor_id = db.execute(
        select(PassageAnchor.id).where(
            PassageAnchor.user_id == viewer_id,
            PassageAnchor.owner_scheme == owner_ref.scheme,
            PassageAnchor.owner_id == owner_ref.id,
            PassageAnchor.anchor_key == anchor_key,
        )
    ).scalar_one_or_none()
    if anchor_id is None:
        return f"{owner_ref.uri}:{anchor_key}", None
    ref = ResourceRef(scheme="passage_anchor", id=anchor_id)
    return ref.uri, ref


def candidate_owner_and_quote(db: Session, *, ref: ResourceRef) -> tuple[ResourceRef, str] | None:
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
                "SELECT item.media_id, COALESCE(item.body_text, item.label, '')"
                " FROM reader_apparatus_items item"
                " JOIN reader_apparatus_states state ON state.id = item.state_id"
                " WHERE item.id = :id AND state.status IN ('ready', 'partial')"
                " AND item.locator IS NOT NULL AND item.locator_status != 'missing'"
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
