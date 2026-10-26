"""Browser composition: reserved preview bands and paged resources or occurrences.

Each explicit phase returns a complete ranking. Only eligible hybrid phases embed,
before their one snapshot; expected provider failure waits for scope authorization.
Lexical phases never call the provider or neighbour query. Visible SQL facts determine
admission and order; canonical items own activation, including unavailable locations.
A full resource prefix omits chunk neighbours only when selected media have lexical
passages or no current eligible vectors; the prefix includes its continuation row.
Preview omits chunk neighbours only when two lexical inside owners fill its prefix
and each selected media has a lexical child or no current eligible model vector.
Full reads share database-wide backend admission; direct preview and one-character
reads remain independent. Strict evidence retrieval remains in service.py.
Direct preview matches only literal names and contributor aliases; it has no
indexed scoring, passage annotation, provider or vector read.
Request stages pair monotonic boundaries with the logger's UTC timestamps; an end
marks the owner leaving its scope on return or failure, not a successful response.
"""

import asyncio
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Literal, cast
from uuid import UUID

from provider_runtime.errors import CredentialMissing, NonGenerationCallFailed
from provider_runtime.retry import DEFAULT_RETRY
from provider_runtime.types import TransientExhausted
from sqlalchemy.orm import Session

from nexus.db.session import open_async_session
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.schemas.search import (
    NameMatch,
    PreviewPhase,
    SearchOccurrenceOut,
    SearchPassagesResponse,
    SearchPhase,
    SearchPreviewResponse,
    SearchResourceOut,
    SearchResourcesResponse,
    SearchResponse,
    SearchView,
    SemanticStatus,
)
from nexus.schemas.search_types import SearchPageInfo
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.embeddings import embed_texts_async, embedding_model
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import navigation
from nexus.services.search.admission import search_session_async
from nexus.services.search.indexed import IndexedRead, present
from nexus.services.search.indexed import read as indexed_read
from nexus.services.search.query import (
    FORMAT_STORAGE,
    DiscoveryQuery,
    decode_cursor,
    encode_cursor,
    is_offset,
)
from nexus.services.search.scope import authorize_scope, scope_predicate
from nexus.services.search.semantic import Embedding, has_media_vectors
from nexus.services.search.service import read_snapshot
from nexus.services.search.sources import (
    GENERATED_FAMILIES,
    SEMANTIC,
    DiscoveryHit,
    Retrieval,
    discovery_neighbours,
)

logger = get_logger(__name__)

_SAVED = frozenset({"highlight", "passage_anchor"})
_PASSAGES = GENERATED_FAMILIES | _SAVED | {"note_block"}


@dataclass(frozen=True, slots=True)
class _Resource:
    ref: ResourceRef
    own: DiscoveryHit | None
    passage: DiscoveryHit | None

    @property
    def section(self) -> Literal["primary", "saved", "inside"]:
        return "inside" if self.own is None else "saved" if self.own.family in _SAVED else "primary"

    @property
    def order(self) -> tuple[int, int, int, float, str, str]:
        hit = self.own or self.passage
        assert hit is not None  # Every resource is admitted by its own match or a child.
        band = {"primary": 0, "saved": 1, "inside": 2}[self.section]
        return (band, -hit.name_tier, -hit.lexical, -hit.relevance, hit.sort_label, self.ref.uri)


def _families(
    query: DiscoveryQuery, *, passages: bool, direct: bool, preview: bool
) -> tuple[str, ...]:
    return tuple(
        family
        for family in query.families
        if (not passages or (query.text and family in _PASSAGES))
        and (not direct or family not in GENERATED_FAMILIES)
        and (not preview or family != "web_result")
        and scope_predicate(family, (query.scope,), None) is not None
    )


async def _embedding(
    query: DiscoveryQuery, families: Sequence[str], phase: PreviewPhase
) -> tuple[Embedding | None, ApiError | None]:
    if phase != "hybrid" or len(query.text) < 2 or not SEMANTIC.keys() & set(families):
        return None, None
    logger.info("search.provider.begin", mono_ns=time.monotonic_ns())
    try:
        vectors = await embed_texts_async(
            [query.text], retry=replace(DEFAULT_RETRY, max_attempts=1)
        )
        return (embedding_model(), vectors[0]), None
    except asyncio.CancelledError:
        logger.info("search.provider.cancelled", mono_ns=time.monotonic_ns())
        raise
    except (NonGenerationCallFailed, CredentialMissing) as exc:
        logger.info(
            "search.provider.failed", error_type=type(exc).__name__, mono_ns=time.monotonic_ns()
        )
        if isinstance(exc, NonGenerationCallFailed) and not isinstance(
            exc.failure, TransientExhausted
        ):
            # justify-defect: query context overflow is not provider unavailability.
            raise
        # Scope authorization in the snapshot takes precedence over expected unavailability.
        return None, ApiError(
            ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE,
            "Related matches are unavailable.",
        )
    finally:
        logger.info("search.provider.end", mono_ns=time.monotonic_ns())


def _snapshot[T](db: Session, deadline: float, read: Callable[[Session], T]) -> T:
    logger.info("search.snapshot.begin", mono_ns=time.monotonic_ns())
    try:
        return read_snapshot(db, read, deadline=deadline)
    finally:
        logger.info("search.snapshot.end", mono_ns=time.monotonic_ns())


def _retrieval(
    db: Session,
    viewer_id: UUID,
    query: DiscoveryQuery,
    k: int,
    embedding: Embedding | None,
    failure: ApiError | None,
) -> Retrieval:
    logger.info("search.retrieval_setup.begin", mono_ns=time.monotonic_ns())
    try:
        authorize_scope(db, viewer_id, query.scope)
        if failure is not None:
            raise failure
        authors = resolve_contributor_ids_by_handles(db, query.authors) if query.authors else None
        return Retrieval(
            viewer_id=viewer_id,
            terms=query.text,
            k=k,
            scopes=(query.scope,),
            content_kinds=tuple(FORMAT_STORAGE[f] for f in query.formats),
            contributor_ids=None if authors is None else list(authors.values()),
            roles=query.roles,
            embedding=embedding,
        )
    finally:
        logger.info("search.retrieval_setup.end", mono_ns=time.monotonic_ns())


def _neighbours(
    db: Session, r: Retrieval, families: Sequence[str]
) -> dict[str, list[tuple[UUID, float]]]:
    if r.embedding is None:
        return {}
    logger.info("search.initial_neighbours.begin", mono_ns=time.monotonic_ns())
    try:
        return {
            family: discovery_neighbours(db, r, family) for family in families if family in SEMANTIC
        }
    finally:
        logger.info("search.initial_neighbours.end", mono_ns=time.monotonic_ns())


def _rank(
    facts: IndexedRead, r: Retrieval, families: Sequence[str], *, group: bool
) -> list[DiscoveryHit]:
    return sorted(
        (
            hit
            for family in families
            for hit in facts.rank(
                (family,), k=r.k, group_owners=group and family in GENERATED_FAMILIES
            )
        ),
        key=lambda hit: hit.order,
    )


def _resources(hits: Sequence[DiscoveryHit]) -> list[_Resource]:
    resources = {h.ref: _Resource(h.ref, h, None) for h in hits if h.owner is None}
    for hit in hits:
        if hit.owner is None:
            continue
        row = resources.get(hit.owner)
        if row is None:
            resources[hit.owner] = _Resource(hit.owner, None, hit)
        elif row.passage is None:
            resources[hit.owner] = replace(row, passage=hit)
    return sorted(resources.values(), key=lambda row: row.order)


def _classify_owners(
    facts: IndexedRead, hits: list[DiscoveryHit], families: Sequence[str]
) -> list[DiscoveryHit]:
    """A generated candidate's direct admission does not depend on a previous limit."""
    direct = {hit.ref for hit in hits if hit.owner is None}
    owners = {hit.owner for hit in hits if hit.owner is not None and hit.owner not in direct}
    for family in ("media", "conversation"):
        identities = [owner.id for owner in owners if owner.scheme == family]
        if identities and family in families:
            hits += facts.rank(
                (family,),
                k=len(identities),
                group_owners=False,
                identities=identities,
            )
    return sorted(hits, key=lambda hit: hit.order)


def _enrich(
    facts: IndexedRead,
    rows: Sequence[_Resource],
    families: Sequence[str],
) -> list[_Resource]:
    children: dict[ResourceRef, DiscoveryHit] = {}
    for family in families:
        if family not in GENERATED_FAMILIES:
            continue
        scheme = "conversation" if family == "message" else "media"
        owners = [row.ref.id for row in rows if row.ref.scheme == scheme]
        if not owners:
            continue
        for hit in facts.rank(
            (family,),
            k=len(owners),
            group_owners=True,
            owners=owners,
        ):
            assert hit.owner is not None
            prior = children.get(hit.owner)
            if prior is None or hit.order < prior.order:
                children[hit.owner] = hit
    return [replace(row, passage=children.get(row.ref, row.passage)) for row in rows]


def _present(
    db: Session,
    facts: IndexedRead,
    viewer_id: UUID,
    terms: str,
    resources: Sequence[_Resource],
    occurrences: Sequence[DiscoveryHit],
) -> tuple[list[SearchResourceOut], list[SearchOccurrenceOut]]:
    logger.info("search.presentation.begin", mono_ns=time.monotonic_ns())
    try:
        hits = {
            (hit.ref, hit.reading_media_id): hit
            for row in resources
            for hit in (row.own, row.passage)
            if hit is not None
        }
        hits.update(((hit.ref, hit.reading_media_id), hit) for hit in occurrences)
        shown = present(
            db,
            facts,
            viewer_id=viewer_id,
            refs=[(row.ref, row.own.reading_media_id if row.own else None) for row in resources]
            + list(hits),
            hits=list(hits.values()),
            terms=terms,
        )

        def occurrence(hit: DiscoveryHit) -> SearchOccurrenceOut:
            item, match = shown[(hit.ref.uri, hit.reading_media_id)]
            return SearchOccurrenceOut(
                item=item, match=match, match_method="lexical" if hit.lexical else "semantic"
            )

        return [
            SearchResourceOut(
                section=row.section,
                item=shown[(row.ref.uri, row.own.reading_media_id if row.own else None)][0],
                name_match=cast(
                    NameMatch | None, (None, "substring", "prefix", "exact")[row.own.name_tier]
                )
                if row.own
                else None,
                match=shown[(row.ref.uri, row.own.reading_media_id if row.own else None)][1]
                if row.own and terms
                else None,
                match_method=("lexical" if row.own.lexical else "semantic")
                if row.own and terms
                else None,
                matching_passage=occurrence(row.passage) if row.passage else None,
            )
            for row in resources
        ], [occurrence(hit) for hit in occurrences]
    finally:
        logger.info("search.presentation.end", mono_ns=time.monotonic_ns())


async def search(
    viewer_id: UUID,
    query: DiscoveryQuery,
    *,
    phase: SearchPhase,
    deadline: float,
    view: SearchView,
    cursor: str | None,
    limit: int,
) -> SearchResponse:
    offset = 0
    if cursor is not None:
        payload = decode_cursor(cursor)
        position = payload.get("offset")
        if (
            set(payload) != {"offset", "query_fingerprint", "phase"}
            or not is_offset(position)
            or payload.get("phase") != phase
        ):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid discovery cursor")
        if payload.get("query_fingerprint") != query.fingerprint(viewer_id, view, phase):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_CURSOR, "Cursor belongs to another search"
            )
        offset = position
    families = _families(
        query, passages=view == "passages", direct=len(query.text) < 2, preview=False
    )
    embedding, failure = await _embedding(query, families, phase)
    status: SemanticStatus = "used" if embedding is not None else "not_requested"

    def page(more: bool) -> SearchPageInfo:
        return SearchPageInfo(
            has_more=more,
            next_cursor=encode_cursor(
                {
                    "offset": offset + limit,
                    "query_fingerprint": query.fingerprint(viewer_id, view, phase),
                    "phase": phase,
                }
            )
            if more
            else None,
        )

    def read(db: Session) -> SearchResponse:
        r = _retrieval(db, viewer_id, query, offset + limit + 1, embedding, failure)
        if not query.requests_read:
            return (
                SearchResourcesResponse(
                    phase=phase, results=[], page=page(False), semantic_status=status
                )
                if view == "resources"
                else SearchPassagesResponse(
                    phase=phase, results=[], page=page(False), semantic_status=status
                )
            )
        defer_chunks = (
            view == "resources" and r.embedding is not None and "content_chunk" in families
        )
        neighbour_families = (
            tuple(f for f in families if f != "content_chunk") if defer_chunks else families
        )
        neighbours = _neighbours(db, r, neighbour_families)
        logger.info("search.indexed.begin", mono_ns=time.monotonic_ns())
        try:
            facts = indexed_read(db, r, families, neighbours, group_owners=view == "resources")
        finally:
            logger.info("search.indexed.end", mono_ns=time.monotonic_ns())
        hits = _rank(facts, r, families, group=view == "resources")
        if view == "resources":
            rows = _resources(_classify_owners(facts, hits, families))
            selected = _enrich(facts, rows[offset : offset + limit], families)
            if defer_chunks:
                assert r.embedding is not None
                missing = [
                    row.ref.id
                    for row in selected
                    if row.ref.scheme == "media"
                    and (row.passage is None or not row.passage.lexical)
                ]
                # Known rows dominate new semantic-only inside owners. Only a
                # selected media's missing child can still change this full page.
                if len(rows) < r.k or (missing and has_media_vectors(db, r.embedding[0], missing)):
                    logger.info("search.extra_semantic.begin", mono_ns=time.monotonic_ns())
                    try:
                        facts = facts.with_semantic(
                            db, r, {"content_chunk": discovery_neighbours(db, r, "content_chunk")}
                        )
                    finally:
                        logger.info("search.extra_semantic.end", mono_ns=time.monotonic_ns())
                    hits = _rank(facts, r, families, group=True)
                    rows = _resources(_classify_owners(facts, hits, families))
                    selected = _enrich(facts, rows[offset : offset + limit], families)
            more = len(rows) > offset + limit and is_offset(offset + limit)
            resources, _ = _present(db, facts, viewer_id, query.text, selected, ())
            return SearchResourcesResponse(
                phase=phase, results=resources, page=page(more), semantic_status=status
            )
        unique = list({hit.ref: hit for hit in hits}.values())
        more = len(unique) > offset + limit and is_offset(offset + limit)
        _, passages = _present(
            db, facts, viewer_id, query.text, (), unique[offset : offset + limit]
        )
        return SearchPassagesResponse(
            phase=phase, results=passages, page=page(more), semantic_status=status
        )

    async with (
        open_async_session()
        if len(query.text) < 2 or not query.requests_read or not families or failure is not None
        else search_session_async(deadline=deadline)
    ) as database:
        return await database.run_sync(lambda db: _snapshot(db, deadline, read))


async def preview(
    viewer_id: UUID,
    query: DiscoveryQuery,
    *,
    phase: PreviewPhase,
    deadline: float,
) -> SearchPreviewResponse:
    direct = phase == "direct" or len(query.text) < 2
    families = _families(query, passages=False, direct=direct, preview=True)
    embedding, failure = await _embedding(query, families, phase)
    status: SemanticStatus = "used" if embedding is not None else "not_requested"

    def read(db: Session) -> SearchPreviewResponse:
        r = _retrieval(db, viewer_id, query, 4, embedding, failure)
        if not query.requests_read:
            return SearchPreviewResponse(
                phase=phase, resources=[], saved=[], passages=[], semantic_status=status
            )
        if phase == "direct":
            return SearchPreviewResponse(
                phase=phase,
                resources=navigation.resources(db, r, families),
                saved=[],
                passages=[],
                semantic_status=status,
            )
        defer_chunks = r.embedding is not None and "content_chunk" in families
        neighbour_families = (
            tuple(f for f in families if f != "content_chunk") if defer_chunks else families
        )
        neighbours = _neighbours(db, r, neighbour_families)
        logger.info("search.indexed.begin", mono_ns=time.monotonic_ns())
        try:
            facts = indexed_read(db, r, families, neighbours, group_owners=True)
        finally:
            logger.info("search.indexed.end", mono_ns=time.monotonic_ns())
        primary = [f for f in families if f not in GENERATED_FAMILIES | _SAVED]
        saved_families = [f for f in families if f in _SAVED]

        def compose(
            facts: IndexedRead,
        ) -> tuple[list[_Resource], list[_Resource], list[DiscoveryHit]]:
            rows = [_Resource(h.ref, h, None) for h in _rank(facts, r, primary, group=False)[:4]]
            saved = [
                _Resource(h.ref, h, None)
                for h in _rank(facts, replace(r, k=2), saved_families, group=False)[:2]
            ]
            rows = _enrich(facts, rows, families)
            inside: list[DiscoveryHit] = []
            for family in families:
                if family not in GENERATED_FAMILIES:
                    continue
                scheme = "conversation" if family == "message" else "media"
                inside.extend(
                    facts.rank(
                        (family,),
                        k=2,
                        group_owners=True,
                        excluded_owners=[row.ref.id for row in rows if row.ref.scheme == scheme],
                    )
                )
            distinct: dict[ResourceRef | None, DiscoveryHit] = {}
            for hit in sorted(
                inside, key=lambda h: (*h.order[:-1], h.owner.uri if h.owner else h.ref.uri)
            ):
                distinct.setdefault(hit.owner, hit)
            return rows, saved, list(distinct.values())[:2]

        rows, saved, inside = compose(facts)
        if defer_chunks:
            assert r.embedding is not None
            missing = [
                row.ref.id
                for row in rows
                if row.ref.scheme == "media" and (row.passage is None or not row.passage.lexical)
            ]
            if (
                len(inside) < 2
                or any(not hit.lexical for hit in inside)
                or (missing and has_media_vectors(db, r.embedding[0], missing))
            ):
                logger.info("search.extra_semantic.begin", mono_ns=time.monotonic_ns())
                try:
                    facts = facts.with_semantic(
                        db, r, {"content_chunk": discovery_neighbours(db, r, "content_chunk")}
                    )
                finally:
                    logger.info("search.extra_semantic.end", mono_ns=time.monotonic_ns())
                rows, saved, inside = compose(facts)
        resources, passages = _present(db, facts, viewer_id, query.text, rows + saved, inside)
        return SearchPreviewResponse(
            phase=phase,
            resources=resources[: len(rows)],
            saved=resources[len(rows) :],
            passages=passages,
            semantic_status=status,
        )

    async with (
        open_async_session()
        if direct or not query.requests_read or not families or failure is not None
        else search_session_async(deadline=deadline)
    ) as database:
        return await database.run_sync(lambda db: _snapshot(db, deadline, read))
