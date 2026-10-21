"""Browser composition: reserved preview bands and paged resources or occurrences.

Each explicit phase returns a complete ranking. Only eligible hybrid phases embed,
before their one snapshot; expected provider failure waits for scope authorization.
Lexical phases never call the provider or neighbour query. Visible SQL facts determine
admission and order; canonical items own activation, including unavailable locations.
Strict evidence retrieval remains in service.py.
"""

import asyncio
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Literal, cast
from uuid import UUID

from provider_runtime.errors import CredentialMissing, NonGenerationCallFailed
from provider_runtime.retry import DEFAULT_RETRY
from provider_runtime.types import TransientExhausted
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
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
from nexus.services.search.presentation import present_matches
from nexus.services.search.query import (
    FORMAT_STORAGE,
    DiscoveryQuery,
    decode_cursor,
    encode_cursor,
    is_offset,
)
from nexus.services.search.scope import authorize_scope, scope_predicate
from nexus.services.search.semantic import Embedding
from nexus.services.search.service import read_snapshot
from nexus.services.search.sources import (
    GENERATED_FAMILIES,
    SEMANTIC,
    DiscoveryHit,
    Retrieval,
    discovery_neighbours,
    rank_discovery,
)

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
    try:
        vectors = await embed_texts_async(
            [query.text], retry=replace(DEFAULT_RETRY, max_attempts=1)
        )
        return (embedding_model(), vectors[0]), None
    except (NonGenerationCallFailed, CredentialMissing) as exc:
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


def _snapshot[T](db: Session, deadline: float, read: Callable[[Session], T]) -> T:
    def bounded(db: Session) -> T:
        remaining_ms = max(1, math.ceil((deadline - asyncio.get_running_loop().time()) * 1000))
        # Browser reads are short; compiling these visibility relations costs seconds.
        db.execute(
            text("""SELECT set_config('statement_timeout', :timeout, true),
                set_config('jit', 'off', true)"""),
            {"timeout": str(remaining_ms)},
        )
        return read(db)

    return read_snapshot(db, bounded)


def _retrieval(
    db: Session,
    viewer_id: UUID,
    query: DiscoveryQuery,
    k: int,
    embedding: Embedding | None,
    failure: ApiError | None,
) -> Retrieval:
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


def _neighbours(
    db: Session, r: Retrieval, families: Sequence[str]
) -> dict[str, list[tuple[UUID, float]]]:
    if r.embedding is None:
        return {}
    return {
        family: discovery_neighbours(db, r, family) for family in families if family in SEMANTIC
    }


def _rank(
    db: Session,
    r: Retrieval,
    families: Sequence[str],
    neighbours: dict[str, list[tuple[UUID, float]]],
    *,
    group: bool,
) -> list[DiscoveryHit]:
    return sorted(
        (
            hit
            for family in families
            for hit in rank_discovery(
                db,
                r,
                family,
                neighbours=neighbours.get(family, ()),
                group_owners=group and family in GENERATED_FAMILIES,
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
    db: Session, r: Retrieval, hits: list[DiscoveryHit], families: Sequence[str]
) -> list[DiscoveryHit]:
    """A generated candidate's direct admission does not depend on a previous limit."""
    direct = {hit.ref for hit in hits if hit.owner is None}
    owners = {hit.owner for hit in hits if hit.owner is not None and hit.owner not in direct}
    for family in ("media", "conversation"):
        identities = [owner.id for owner in owners if owner.scheme == family]
        if identities and family in families:
            hits += rank_discovery(
                db,
                replace(r, k=len(identities)),
                family,
                neighbours=(),
                group_owners=False,
                identities=identities,
            )
    return sorted(hits, key=lambda hit: hit.order)


def _enrich(
    db: Session,
    r: Retrieval,
    rows: Sequence[_Resource],
    families: Sequence[str],
    neighbours: dict[str, list[tuple[UUID, float]]],
) -> list[_Resource]:
    children: dict[ResourceRef, DiscoveryHit] = {}
    for family in families:
        if family not in GENERATED_FAMILIES:
            continue
        scheme = "conversation" if family == "message" else "media"
        owners = [row.ref.id for row in rows if row.ref.scheme == scheme]
        if not owners:
            continue
        for hit in rank_discovery(
            db,
            replace(r, k=len(owners)),
            family,
            neighbours=neighbours.get(family, ()),
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
    viewer_id: UUID,
    terms: str,
    resources: Sequence[_Resource],
    occurrences: Sequence[DiscoveryHit],
) -> tuple[list[SearchResourceOut], list[SearchOccurrenceOut]]:
    hits = {hit.ref: hit for row in resources for hit in (row.own, row.passage) if hit is not None}
    hits.update((hit.ref, hit) for hit in occurrences)
    shown = present_matches(
        db,
        viewer_id=viewer_id,
        refs=[row.ref for row in resources] + list(hits),
        hits=list(hits.values()),
        terms=terms,
    )

    def occurrence(hit: DiscoveryHit) -> SearchOccurrenceOut:
        item, match = shown[hit.ref.uri]
        return SearchOccurrenceOut(
            item=item, match=match, match_method="lexical" if hit.lexical else "semantic"
        )

    return [
        SearchResourceOut(
            section=row.section,
            item=shown[row.ref.uri][0],
            name_match=cast(
                NameMatch | None, (None, "substring", "prefix", "exact")[row.own.name_tier]
            )
            if row.own
            else None,
            match=shown[row.ref.uri][1] if row.own and terms else None,
            match_method=("lexical" if row.own.lexical else "semantic")
            if row.own and terms
            else None,
            matching_passage=occurrence(row.passage) if row.passage else None,
        )
        for row in resources
    ], [occurrence(hit) for hit in occurrences]


async def search(
    database: AsyncSession,
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
        neighbours = _neighbours(db, r, families)
        hits = _rank(db, r, families, neighbours, group=view == "resources")
        if view == "resources":
            rows = _resources(_classify_owners(db, r, hits, families))
            more = len(rows) > offset + limit and is_offset(offset + limit)
            selected = _enrich(db, r, rows[offset : offset + limit], families, neighbours)
            resources, _ = _present(db, viewer_id, query.text, selected, ())
            return SearchResourcesResponse(
                phase=phase, results=resources, page=page(more), semantic_status=status
            )
        unique = list({hit.ref: hit for hit in hits}.values())
        more = len(unique) > offset + limit and is_offset(offset + limit)
        _, passages = _present(db, viewer_id, query.text, (), unique[offset : offset + limit])
        return SearchPassagesResponse(
            phase=phase, results=passages, page=page(more), semantic_status=status
        )

    return await database.run_sync(lambda db: _snapshot(db, deadline, read))


async def preview(
    database: AsyncSession,
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
        neighbours = _neighbours(db, r, families)
        primary = [f for f in families if f not in GENERATED_FAMILIES | _SAVED]
        saved_families = [f for f in families if f in _SAVED]
        rows = [
            _Resource(h.ref, h, None) for h in _rank(db, r, primary, neighbours, group=False)[:4]
        ]
        saved = [
            _Resource(h.ref, h, None)
            for h in _rank(db, replace(r, k=2), saved_families, neighbours, group=False)[:2]
        ]
        rows = _enrich(db, r, rows, families, neighbours)
        inside = []
        for family in families:
            if family not in GENERATED_FAMILIES:
                continue
            scheme = "conversation" if family == "message" else "media"
            inside.extend(
                rank_discovery(
                    db,
                    replace(r, k=2),
                    family,
                    neighbours=neighbours.get(family, ()),
                    group_owners=True,
                    excluded_owners=[row.ref.id for row in rows if row.ref.scheme == scheme],
                )
            )
        distinct: dict[ResourceRef | None, DiscoveryHit] = {}
        for hit in sorted(
            inside, key=lambda h: (*h.order[:-1], h.owner.uri if h.owner else h.ref.uri)
        ):
            distinct.setdefault(hit.owner, hit)
        resources, passages = _present(
            db, viewer_id, query.text, rows + saved, list(distinct.values())[:2]
        )
        return SearchPreviewResponse(
            phase=phase,
            resources=resources[: len(rows)],
            saved=resources[len(rows) :],
            passages=passages,
            semantic_status=status,
        )

    return await database.run_sync(lambda db: _snapshot(db, deadline, read))
