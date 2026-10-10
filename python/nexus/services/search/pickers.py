"""The two picker modes of the one retriever: link targets and route-only openables."""

from __future__ import annotations

from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import PassageAnchor
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.presence import Present
from nexus.schemas.resource_search import (
    ResourceOpenableSearchRequest,
    ResourceOpenableSearchResponse,
    ResourceTargetOut,
    ResourceTargetPassageOut,
    ResourceTargetResourceOut,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services import locator_resolver, passage_anchors
from nexus.services.resource_graph.edges import existing_link_pair
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_link_mode
from nexus.services.resource_items.surfaces import _parse_ref_or_error, resource_items_out
from nexus.services.search.project import SCHEMES, snippet
from nexus.services.search.query import MIN_QUERY_LENGTH, decode_offset, encode_cursor, is_offset
from nexus.services.search.semantic import Embedding, embed_text
from nexus.services.search.service import read_snapshot
from nexus.services.search.sources import (
    LIVE_APPARATUS,
    RESOLVED_ORACLE_ANCHORS,
    SOURCES,
    Hit,
    Retrieval,
    merge,
    rank,
)
from nexus.services.text_quote import QuoteStatus

TARGET_PAGE = 10
OPENABLE_LIMIT = 20
_PASSAGES = (
    "content_chunk",
    "fragment",
    "reader_apparatus_item",
    "evidence_span",
    "oracle_passage_anchor",
)
# Every family but the passages and the search-only and browse-only ones names a resource.
_DIRECT = [f for f in SOURCES if f not in {*_PASSAGES, "artifact", "web_result", "gutenberg"}]


def _refs(hits: list[Hit]) -> list[ResourceRef]:
    """The hits' distinct resource refs, in order."""
    refs = (ResourceRef(cast("ResourceScheme", SCHEMES.get(h.type, h.type)), h.id) for h in hits)
    return list({ref.uri: ref for ref in refs}.values())


def _link(
    db: Session, viewer_id: UUID, a: ResourceRef | None, b: ResourceRef | None
) -> UUID | None:
    """The user's context link joining ``a`` and ``b`` in either direction, if any."""
    edge = existing_link_pair(db, viewer_id=viewer_id, a=a, b=b) if a and b else None
    return None if edge is None else edge.id


def search_targets(
    db: Session, *, viewer_id: UUID, request: ResourceTargetSearchRequest
) -> ResourceTargetSearchResponse:
    """A page of linkable targets. Exclusions and identity dedupe precede paging; one pass
    over a bounded prefix of the merged order, with at most one embedding."""
    q = request.q.strip()
    parsed = parse_resource_ref(q)
    exact = parsed if isinstance(parsed, ResourceRef) else None
    embedding = embed_text(q) if exact is None and len(q) >= MIN_QUERY_LENGTH else None
    return read_snapshot(db, lambda s: _targets(s, viewer_id, request, q, exact, embedding))


def _targets(
    db: Session,
    viewer_id: UUID,
    request: ResourceTargetSearchRequest,
    q: str,
    exact: ResourceRef | None,
    embedding: Embedding | None,
) -> ResourceTargetSearchResponse:
    source = _parse_ref_or_error(request.source_ref) if request.source_ref else None
    excluded = {_parse_ref_or_error(raw).uri for raw in request.exclude_refs}
    offset = decode_offset(request.cursor)
    link_source = None
    if source is not None:
        identity, link_source = _source_identity(db, viewer_id, source)
        excluded |= {source.uri, identity}
    if exact is not None:
        candidates = [exact]
        needed = 1
    elif len(q) < MIN_QUERY_LENGTH:
        return ResourceTargetSearchResponse(targets=[], next_cursor=None)
    else:
        needed = offset + TARGET_PAGE + 1
        r = Retrieval(viewer_id, q, 2 * needed + len(excluded), embedding=embedding)
        hits = merge(hit for family in (*_DIRECT, *_PASSAGES) for hit in rank(db, r, family))
        candidates = _refs(hits[: r.k])
    candidates = [ref for ref in candidates if ref.uri not in excluded]
    direct = [ref for ref in candidates if resource_link_mode(ref) == "direct"]
    items = {item.ref: item for item in resource_items_out(db, viewer_id=viewer_id, refs=direct)}
    admitted: dict[str, ResourceTargetOut] = {}
    for ref in candidates:
        passage = resource_link_mode(ref) == "materialize_passage"
        quote = candidate_owner_and_quote(db, ref=ref) if passage else None
        if ref.uri in items and not items[ref.uri].missing:
            key = ref.uri
            link = _link(db, viewer_id, link_source, ref)
            target = ResourceTargetResourceOut(item=items[ref.uri], existing_link_id=link)
        elif quote is not None:
            owner = resource_items_out(db, viewer_id=viewer_id, refs=[quote[0]])[0]
            identity = None if owner.missing else _passage_identity(db, viewer_id, *quote)
            if identity is None:
                continue
            key, anchor = identity
            target = ResourceTargetPassageOut(
                candidate_ref=ref.uri,
                source=owner,
                label=owner.label,
                excerpt=snippet(quote[1], q),
                existing_link_id=_link(db, viewer_id, link_source, anchor),
            )
        else:
            continue
        if key not in excluded:
            admitted.setdefault(key, target)
        if len(admitted) == needed:
            break
    more = exact is None and len(admitted) == needed and is_offset(offset + TARGET_PAGE)
    return ResourceTargetSearchResponse(
        targets=list(admitted.values())[offset : offset + TARGET_PAGE],
        next_cursor=encode_cursor({"offset": offset + TARGET_PAGE}) if more else None,
    )


def _source_identity(
    db: Session, viewer_id: UUID, ref: ResourceRef
) -> tuple[str, ResourceRef | None]:
    """The identity a source occupies (itself, or its passage's anchor key) and the ref its
    existing links hang off (itself, or its saved anchor)."""
    mode = resource_link_mode(ref)
    if mode == "none":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked")
    if mode == "direct":
        if resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0].missing:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
        return ref.uri, ref
    quote = candidate_owner_and_quote(db, ref=ref)
    if quote is None or resource_items_out(db, viewer_id=viewer_id, refs=[quote[0]])[0].missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage not found")
    identity = _passage_identity(db, viewer_id, *quote)
    if identity is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage no longer resolves")
    return identity


def _passage_identity(
    db: Session, viewer_id: UUID, owner: ResourceRef, exact: str
) -> tuple[str, ResourceRef | None] | None:
    """The anchor key a quote occupies in its owner (and its saved anchor), if unique there."""
    normalized = passage_anchors.normalize_quote_text(exact)
    if not normalized:
        return None
    resolution = locator_resolver.resolve_passage_selector(
        db, owner_scheme=owner.scheme, owner_id=owner.id, exact=normalized
    )
    if resolution.status is not QuoteStatus.unique:
        return None
    key = passage_anchors.compute_anchor_key(
        exact=normalized, prefix=resolution.prefix, suffix=resolution.suffix
    )
    anchor_id = db.execute(
        select(PassageAnchor.id).where(
            PassageAnchor.user_id == viewer_id,
            PassageAnchor.owner_scheme == owner.scheme,
            PassageAnchor.owner_id == owner.id,
            PassageAnchor.anchor_key == key,
        )
    ).scalar_one_or_none()
    if anchor_id is None:
        return f"{owner.uri}:{key}", None
    anchor = ResourceRef("passage_anchor", anchor_id)
    return anchor.uri, anchor


_QUOTES = {
    "content_chunk": "SELECT owner_kind, owner_id, chunk_text FROM content_chunks WHERE id = :id",
    "evidence_span": "SELECT owner_kind, owner_id, span_text FROM evidence_spans WHERE id = :id",
    "fragment": "SELECT 'media', media_id, canonical_text FROM fragments WHERE id = :id",
    "reader_apparatus_item": f"""SELECT 'media', rai.media_id,
            COALESCE(rai.body_text, rai.label, '')
        FROM reader_apparatus_items rai JOIN reader_apparatus_states ras ON ras.id = rai.state_id
        WHERE rai.id = :id AND {LIVE_APPARATUS}""",
    # Unresolved or stale Oracle anchors fail closed, as their loader does.
    "oracle_passage_anchor": f"""SELECT 'media', s.media_id, COALESCE(es.span_text, cc.chunk_text)
        FROM {RESOLVED_ORACLE_ANCHORS} AND a.id = :id""",
}


def candidate_owner_and_quote(db: Session, *, ref: ResourceRef) -> tuple[ResourceRef, str] | None:
    """The owner ref and quote text of one passage candidate, or None once it is gone."""
    row = db.execute(text(_QUOTES[ref.scheme]), {"id": ref.id}).first()
    if row is None:
        return None
    owner: Literal["media", "note_block"] = row[0]
    return ResourceRef(owner, row[1]), str(row[2] or "")


def search_openables(
    db: Session, *, viewer_id: UUID, request: ResourceOpenableSearchRequest
) -> ResourceOpenableSearchResponse:
    """Up to 20 visible, route-activatable direct resources; lexical, from one character."""
    schemes = set(request.schemes.value) if isinstance(request.schemes, Present) else None
    exact = parse_resource_ref(request.q)
    if isinstance(exact, ResourceRef):
        refs = [exact]
    else:
        r = Retrieval(viewer_id, request.q, OPENABLE_LIMIT)
        refs = _refs(merge(hit for family in _DIRECT for hit in rank(db, r, family)))
    refs = [ref for ref in refs if schemes is None or ref.scheme in schemes]
    admitted = []
    for start in range(0, len(refs), OPENABLE_LIMIT):
        items = resource_items_out(
            db, viewer_id=viewer_id, refs=refs[start : start + OPENABLE_LIMIT]
        )
        admitted += [item for item in items if not item.missing and item.activation.kind == "route"]
        if len(admitted) >= OPENABLE_LIMIT:
            break
    return ResourceOpenableSearchResponse(items=admitted[:OPENABLE_LIMIT])
