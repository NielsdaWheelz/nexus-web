"""Link target search: strict passage admission and durable quote identity.

Identity lookups use the caller's snapshot; text searches acquire their owned,
database-wide admitted backend before embedding and materialize before retiring it.
Unavailable semantics still authorize the source in the snapshot before failing.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import open_async_session
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.authored import PassageCapture, XCapturePublication
from nexus.schemas.resource_evidence import CapturedPassageTarget, LocationQuote
from nexus.schemas.resource_search import (
    ResourceTargetOut,
    ResourceTargetPassageOut,
    ResourceTargetResourceOut,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import locator_resolver, passage_anchors
from nexus.services.resource_graph.edges import existing_link_pair
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceScheme,
    parse_resource_ref,
    require_ref,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.evidence import capture_evidence
from nexus.services.resource_items.items import resource_items_out, visible_refs
from nexus.services.resource_items.locations import current_passages, media_passages
from nexus.services.search.admission import search_session_async
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


async def search_targets(
    *, viewer_id: UUID, request: ResourceTargetSearchRequest, deadline: float
) -> ResourceTargetSearchResponse:
    """A page of linkable targets. Exclusions and identity dedupe precede paging; one pass
    over a bounded prefix of the merged order, with at most one embedding."""
    q = request.q.strip()
    parsed = parse_resource_ref(q)
    exact = parsed if isinstance(parsed, ResourceRef) else None
    async with (
        open_async_session()
        if exact is not None or len(q) < MIN_QUERY_LENGTH
        else search_session_async(deadline=deadline, purpose="request")
    ) as database:
        embedding = None
        embedding_failure = None
        try:
            if exact is None and len(q) >= MIN_QUERY_LENGTH:
                embedding = await embed_text(q)
        except ApiError as exc:
            if exc.code is not ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE:
                raise
            embedding_failure = exc
        return await database.run_sync(
            lambda db: read_snapshot(
                db,
                lambda s: _targets(
                    s,
                    viewer_id,
                    request,
                    q,
                    exact,
                    embedding,
                    embedding_failure=embedding_failure,
                ),
                deadline=deadline,
            )
        )


def _targets(
    db: Session,
    viewer_id: UUID,
    request: ResourceTargetSearchRequest,
    q: str,
    exact: ResourceRef | None,
    embedding: Embedding | None,
    *,
    embedding_failure: ApiError | None = None,
) -> ResourceTargetSearchResponse:
    source = require_ref(request.source_ref) if request.source_ref else None
    excluded = {require_ref(raw).uri for raw in request.exclude_refs}
    offset = decode_offset(request.cursor)
    link_source = None
    if source is not None:
        identity, link_source = source_identity(db, viewer_id, source)
        excluded |= {source.uri, identity}
    if embedding_failure is not None:
        raise embedding_failure
    reading_owners: dict[str, UUID | None] = {}
    if exact is not None:
        candidates = [exact]
        needed = 1
    elif len(q) < MIN_QUERY_LENGTH:
        return ResourceTargetSearchResponse(targets=[], next_cursor=None)
    else:
        needed = offset + TARGET_PAGE + 1
        r = Retrieval(viewer_id, q, 2 * needed + len(excluded), embedding=embedding)
        hits = merge(rank(db, r, families=(*_DIRECT, *_PASSAGES)))
        candidates = _refs(hits[: r.k])
        reading_owners = {_refs([hit])[0].uri: hit.reading_media_id for hit in hits[: r.k]}
    candidates = [ref for ref in candidates if ref.uri not in excluded]
    items = {
        item.ref: item
        for item in resource_items_out(
            db,
            viewer_id=viewer_id,
            refs=candidates,
            reading_media_ids={
                uri: owner for uri, owner in reading_owners.items() if owner is not None
            },
        )
    }
    admitted: dict[str, ResourceTargetOut] = {}
    for ref in candidates:
        passage = capability(ref.scheme).link_mode == "materialize_passage"
        try:
            captured = (
                capture_evidence(
                    db, viewer_id=viewer_id, ref=ref, reading_media_id=reading_owners.get(ref.uri)
                )
                if passage and ref.uri in items and not items[ref.uri].missing
                else None
            )
        except NotFoundError:
            continue
        quote = (
            (require_ref(captured.target.owner_ref), captured.quote)
            if captured is not None
            and isinstance(captured.target, CapturedPassageTarget)
            and captured.quote is not None
            else None
        )
        if not passage and ref.uri in items and not items[ref.uri].missing:
            key = ref.uri
            link = _link(db, viewer_id, link_source, ref)
            target = ResourceTargetResourceOut(item=items[ref.uri], existing_link_id=link)
        elif quote is not None:
            assert captured is not None and isinstance(captured.target, CapturedPassageTarget)
            owner = resource_items_out(db, viewer_id=viewer_id, refs=[quote[0]])[0]
            identity = None if owner.missing else _passage_identity(db, viewer_id, *quote)
            if identity is None:
                continue
            key, anchor = identity
            target = ResourceTargetPassageOut(
                candidate_ref=ref.uri,
                target=captured.target,
                capture=PassageCapture(
                    quote_exact=quote[1].exact,
                    publication=XCapturePublication(
                        kind="x_capture", capture_id=captured.target.locator.capture_id
                    )
                    if captured.target.locator.type == "x_capture_offsets"
                    else None,
                    locator=captured.target.locator,
                    excerpt=quote[1].excerpt,
                ),
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
    identity = source_identities(db, viewer_id=viewer_id, refs=[ref])[ref.uri]
    if isinstance(identity, InvalidRequestError | NotFoundError):
        raise identity
    return identity


def source_identities(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> dict[str, tuple[str, ResourceRef | None] | InvalidRequestError | NotFoundError]:
    """Current source identities, with expected absence classified independently per ref.

    The caller owns a repeatable read snapshot. Passage candidates need their current valid-location
    proof before unique-quote identity; matching words alone never supply an anchor.
    Each resolution stage shares owner source reads; one lookup finds saved anchors.
    Singular callers raise the same classified error instead of collapsing absence.
    """
    refs = list({ref.uri: ref for ref in refs}.values())
    if not refs:
        return {}
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)
    candidates = [
        ref
        for ref in refs
        if ref.uri in visible and capability(ref.scheme).link_mode == "materialize_passage"
    ]
    current = current_passages(db, viewer_id=viewer_id, refs=candidates) if candidates else {}
    media = (
        media_passages(db, viewer_id=viewer_id, refs=candidates, current_passage_reads=current)
        if candidates
        else {}
    )
    quotes = {
        uri: (passage.owner, passage.quote)
        for uri, passage in {**current, **media}.items()
        if retrieval_locator_json(passage.locator) is not None
    }
    owners = (
        visible_refs(db, viewer_id=viewer_id, refs=list({owner for owner, _ in quotes.values()}))
        if quotes
        else set()
    )
    quotes = {uri: quote for uri, quote in quotes.items() if quote[0].uri in owners}
    identities = _passage_identities(db, viewer_id, quotes)
    out: dict[str, tuple[str, ResourceRef | None] | InvalidRequestError | NotFoundError] = {}
    for ref in refs:
        mode = capability(ref.scheme).link_mode
        if mode == "none":
            out[ref.uri] = InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked"
            )
        elif mode == "direct":
            out[ref.uri] = (
                (ref.uri, ref)
                if ref.uri in visible
                else NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
            )
        elif ref.uri not in quotes:
            out[ref.uri] = NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage not found")
        else:
            out[ref.uri] = identities.get(ref.uri) or NotFoundError(
                ApiErrorCode.E_NOT_FOUND, "Passage no longer resolves"
            )
    return out


def _passage_identity(
    db: Session, viewer_id: UUID, owner: ResourceRef, quote: LocationQuote
) -> tuple[str, ResourceRef | None] | None:
    """The anchor key a quote occupies in its owner (and its saved anchor), if unique there."""
    return _passage_identities(db, viewer_id, {owner.uri: (owner, quote)}).get(owner.uri)


def _passage_identities(
    db: Session, viewer_id: UUID, quotes: Mapping[str, tuple[ResourceRef, LocationQuote]]
) -> dict[str, tuple[str, ResourceRef | None]]:
    sources = locator_resolver.read_passage_sources(
        db, list({(owner.scheme, owner.id) for owner, _ in quotes.values()})
    )
    keys: dict[str, tuple[ResourceRef, str]] = {}
    for uri, (owner, quote) in quotes.items():
        normalized = passage_anchors.normalize_quote_text(quote.exact)
        if not normalized:
            continue
        resolution = locator_resolver.resolve_passage_selector(
            db,
            owner_scheme=owner.scheme,
            owner_id=owner.id,
            exact=normalized,
            prefix=passage_anchors.normalize_quote_text(quote.prefix or ""),
            suffix=passage_anchors.normalize_quote_text(quote.suffix or ""),
            source_reads=sources,
        )
        if resolution.status is QuoteStatus.unique:
            keys[uri] = (
                owner,
                passage_anchors.compute_anchor_key(
                    exact=normalized, prefix=resolution.prefix, suffix=resolution.suffix
                ),
            )
    bindings = [{"source_ref": owner.uri, "semantic_key": key} for owner, key in keys.values()]
    anchors = (
        {
            (row.source_ref, row.semantic_key): ResourceRef("passage_anchor", UUID(row.anchor_id))
            for row in db.execute(
                text("""
                    SELECT p.anchor_id,p.state->>'source_ref' AS source_ref,p.semantic_key
                    FROM jsonb_to_recordset(CAST(:bindings AS jsonb)) AS k(source_ref text,semantic_key text)
                    JOIN authored_passages p ON p.account_id=:viewer
                      AND p.state->>'source_ref'=k.source_ref AND p.semantic_key=k.semantic_key
                """),
                {"viewer": viewer_id, "bindings": json.dumps(bindings)},
            )
        }
        if bindings
        else {}
    )
    return {
        uri: (anchor.uri, anchor)
        if (anchor := anchors.get((owner.uri, key))) is not None
        else (f"{owner.uri}:{key}", None)
        for uri, (owner, key) in keys.items()
    }
