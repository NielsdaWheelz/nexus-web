"""Link target search: strict passage admission and durable quote identity."""

from __future__ import annotations

from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import PassageAnchor
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_search import (
    ResourceTargetOut,
    ResourceTargetPassageOut,
    ResourceTargetResourceOut,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services import locator_resolver, passage_anchors
from nexus.services.resource_graph.edges import existing_link_pair
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceScheme,
    parse_resource_ref,
    require_ref,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out
from nexus.services.search.project import SCHEMES
from nexus.services.search.query import MIN_QUERY_LENGTH, decode_offset, encode_cursor, is_offset
from nexus.services.search.semantic import Embedding, embed_text
from nexus.services.search.service import read_snapshot
from nexus.services.search.sources import SOURCES, Hit, Retrieval, merge, rank
from nexus.services.text_quote import QuoteStatus

TARGET_PAGE = 10
_PASSAGES = (
    "content_chunk",
    "fragment",
    "reader_apparatus_item",
    "evidence_span",
    "oracle_passage_anchor",
)
# Every family but the passages and the search-only and browse-only ones names a resource.
_DIRECT = [f for f in SOURCES if f not in {*_PASSAGES, "web_result", "gutenberg"}]


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
    source = require_ref(request.source_ref) if request.source_ref else None
    excluded = {require_ref(raw).uri for raw in request.exclude_refs}
    offset = decode_offset(request.cursor)
    link_source = None
    if source is not None:
        identity, link_source = source_identity(db, viewer_id, source)
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
    items = {
        item.ref: item for item in resource_items_out(db, viewer_id=viewer_id, refs=candidates)
    }
    admitted: dict[str, ResourceTargetOut] = {}
    for ref in candidates:
        passage = capability(ref.scheme).link_mode == "materialize_passage"
        quote = candidate_owner_and_quote(db, ref=ref) if passage else None
        if not passage and ref.uri in items and not items[ref.uri].missing:
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
                item=items[ref.uri],
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


def source_identity(
    db: Session, viewer_id: UUID, ref: ResourceRef
) -> tuple[str, ResourceRef | None]:
    """The identity a source occupies (itself, or its passage's anchor key) and the ref its
    existing links hang off (itself, or its saved anchor)."""
    mode = capability(ref.scheme).link_mode
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
    # Whatever the item read admits quotes (Q3): an apparatus item of a live state its body,
    # located or not; an Oracle anchor its current span or chunk, else its frozen quote, as
    # its loader reads it. Materializing refuses a quote its owner does not hold uniquely.
    "reader_apparatus_item": """SELECT 'media', rai.media_id,
            COALESCE(rai.body_text, rai.label, '')
        FROM reader_apparatus_items rai JOIN reader_apparatus_states ras ON ras.id = rai.state_id
        WHERE rai.id = :id AND ras.status IN ('ready', 'partial')""",
    "oracle_passage_anchor": """SELECT 'media', s.media_id,
            COALESCE(es.span_text, cc.chunk_text, a.quote)
        FROM oracle_passage_anchors a JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
        LEFT JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
            AND a.resolution_status = 'resolved' AND cc.owner_id = s.media_id
        LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
            AND a.resolution_status = 'resolved' AND es.owner_id = s.media_id
        WHERE a.id = :id""",
}


def candidate_owner_and_quote(db: Session, *, ref: ResourceRef) -> tuple[ResourceRef, str] | None:
    """The owner ref and quote text of one passage candidate, or None once it is gone."""
    row = db.execute(text(_QUOTES[ref.scheme]), {"id": ref.id}).first()
    if row is None:
        return None
    owner: Literal["media", "note_block"] = row[0]
    return ResourceRef(owner, row[1]), str(row[2] or "")
