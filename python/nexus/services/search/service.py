"""Strict evidence entry points: passage pages, multi-scope tools and reopen by identity.

The query embedding is computed before admission and outside any transaction. One
owned backend holds database-wide admission through its REPEATABLE READ, READ ONLY
snapshot, materialized results and backend cleanup. ``read_snapshot`` also serves
direct reads and refuses an already-open transaction, never discarding caller writes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_repeatable_read_db, open_async_session
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    ResourceField,
)
from nexus.schemas.search_types import VALID_RESULT_TYPES, SearchPageInfo
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.reader_excerpts import plain_excerpt
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_items.locations import (
    current_locator,
    location_reads,
    source_identities,
)
from nexus.services.search.admission import (
    remaining_milliseconds,
    search_session_async,
)
from nexus.services.search.candidates import SearchResponse, SearchResultOut
from nexus.services.search.policy import background_computation_deadline
from nexus.services.search.project import family_of, project
from nexus.services.search.query import (
    FORMAT_STORAGE,
    MAX_LIMIT,
    SearchQuery,
    SearchScope,
    is_offset,
)
from nexus.services.search.scope import authorize_scope
from nexus.services.search.semantic import Embedding, embed_text
from nexus.services.search.sources import Hit, Retrieval, merge, rank

_SEMANTIC = frozenset({"content_chunk", "note_block", "highlight_annotation"})


def read_snapshot[T](
    db: Session, read: Callable[[Session], T], *, deadline: float | None = None
) -> T:
    """``read`` inside one strict read-only snapshot that is ended before returning."""
    get_repeatable_read_db(db)  # raises on a session that already holds a transaction
    try:
        if deadline is not None:
            db.execute(
                text("SELECT set_config('statement_timeout', :timeout, true)"),
                {"timeout": str(remaining_milliseconds(deadline))},
            )
        result = read(db)
        if deadline is not None:
            remaining_milliseconds(deadline)
    except BaseException as error:
        try:
            db.rollback()
        except BaseException as cleanup_error:
            # justify-ignore-error: retain rollback failure on the original read/cancellation.
            error.add_note(
                f"Search snapshot rollback also failed: {type(cleanup_error).__name__}: {cleanup_error}"
            )
        raise
    else:
        db.rollback()
        return result


def _families(query: SearchQuery) -> list[str] | None:
    """The families serving the query; None when it has neither usable text nor a filter."""
    if not (query.terms or query.formats or query.authors or query.roles):
        return None
    families = {family_of(result_type) for result_type in query.effective_result_types}
    return sorted(families | ({"highlight_annotation"} if "highlight" in families else set()))


def _page(
    db: Session,
    viewer_id: UUID,
    query: SearchQuery,
    families: list[str],
    scopes: Sequence[SearchScope],
    embedding: Embedding | None,
    offset: int,
    limit: int,
    *,
    embedding_failure: ApiError | None = None,
) -> tuple[list[SearchResultOut], bool]:
    """One page of the merged order over the union of ``scopes`` (authorized even when no
    family serves the query), and whether more follow. A requested embedding failure
    surfaces only after scope authorization."""
    for scope in scopes:
        authorize_scope(db, viewer_id, scope)
    if embedding_failure is not None:
        raise embedding_failure
    authors = resolve_contributor_ids_by_handles(db, query.authors) if query.authors else None
    r = Retrieval(
        viewer_id=viewer_id,
        terms=query.terms,
        k=offset + limit + 1,
        scopes=tuple(scopes),
        frozen=query.frozen_context_refs,
        content_kinds=tuple(FORMAT_STORAGE[f] for f in query.formats),
        contributor_ids=None if authors is None else list(authors.values()),
        roles=query.roles,
        embedding=embedding,
    )
    hits = merge(rank(db, r, families=families))
    page = hits[offset : offset + limit + 1]
    more = len(page) > limit and is_offset(offset + limit)
    return project(db, viewer_id, page[:limit], r.terms), more


async def search_scopes_async(
    viewer_id: UUID,
    base: SearchQuery,
    scopes: Sequence[SearchScope],
    *,
    deadline: float | None,
    purpose: Literal["foreground", "background"],
) -> SearchResponse:
    """One scoped page; foreground retains its caller's absolute deadline.

    Background passes ``deadline=None`` explicitly: its owned computation starts
    after embedding, immediately before admission, with the shared computation allowance.
    """
    assert (deadline is None) == (purpose == "background")
    families = _families(base)
    if families is None:
        return SearchResponse(results=[], page=SearchPageInfo(next_cursor=None))
    async with asyncio.timeout_at(deadline):
        embedding = None
        embedding_failure = None
        try:
            if base.terms and _SEMANTIC & set(families):
                embedding = await embed_text(base.terms)
        except ApiError as exc:
            if exc.code is not ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE:
                raise
            embedding_failure = exc
        limit = min(base.limit, MAX_LIMIT)
        if embedding_failure is not None:
            # Authorization precedes the provider error, without search admission
            # or a background computation clock that could refund this failure.
            session_scope = open_async_session()
        else:
            if purpose == "background":
                assert deadline is None
                deadline = background_computation_deadline()
            assert deadline is not None
            session_scope = search_session_async(deadline=deadline, purpose=purpose)
        async with session_scope as database:
            results, more = await database.run_sync(
                lambda db: read_snapshot(
                    db,
                    lambda s: _page(
                        s,
                        viewer_id,
                        base,
                        families,
                        scopes,
                        embedding,
                        0,
                        limit,
                        embedding_failure=embedding_failure,
                    ),
                    deadline=deadline,
                )
            )
    return SearchResponse(results=results, page=SearchPageInfo(has_more=more, next_cursor=None))


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
    passage_target: CapturedPassageTarget | None = None,
    field: ResourceField = None,
    captured_evidence: CapturedEvidence | None = None,
) -> SearchResultOut:
    """Reopen one visible row by durable identity, in the caller's transaction.

    Every type reopens through its family; a media id reopens as media, episode or video
    by its kind, whatever was asked.
    """
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )
    try:
        identity = UUID(result_id)
    except ValueError:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from None
    owner = require_ref(passage_target.owner_ref) if passage_target is not None else None
    annotation_quote = None
    if passage_target is not None and passage_target.field == "annotation":
        assert owner is not None and owner.scheme == "highlight"
        if result_type == "highlight" and identity != owner.id:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Annotation target disagrees with highlight"
            )
        if captured_evidence is not None and captured_evidence.target != passage_target:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Captured annotation target disagrees"
            )
        assert passage_target.locator.type == "highlight_annotation_offsets"
        selector = passage_target.locator.text_quote_selector
        annotation_quote = (
            captured_evidence.quote
            if captured_evidence is not None
            else CapturedQuote(
                excerpt=plain_excerpt(
                    selector["exact"], selector.get("prefix"), selector.get("suffix")
                ),
                exact=selector["exact"],
                prefix=selector.get("prefix"),
                suffix=selector.get("suffix"),
                color=None,
            )
        )
        if (
            annotation_quote is None
            or annotation_quote.exact != selector["exact"]
            or current_locator(
                passage_target, annotation_quote, location_reads(db, viewer_id, [passage_target])
            )
            is None
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Annotation passage no longer resolves")
        # The immutable field target survives replacement of a chunk/span identity.
        result_type, identity = "highlight", owner.id
    if (
        owner is not None
        and owner.scheme == "media"
        and passage_target is not None
        and passage_target.source_identity != source_identities(db, [owner.id]).get(owner.id)
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search passage body changed")
    if passage_target is not None:
        field = passage_target.field
    hit = Hit(
        "highlight_annotation"
        if result_type == "highlight" and field == "annotation"
        else result_type,
        identity,
        "",
        1.0,
        owner.id if owner is not None and owner.scheme == "media" else None,
    )
    found = project(db, viewer_id, [hit], "", evidence_span_ids=evidence_span_ids)
    if not found:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    result = found[0]
    if annotation_quote is not None:
        assert passage_target is not None
        frozen = captured_evidence or result.captured_evidence.model_copy(
            update={"quote": annotation_quote, "target": passage_target}
        )
        return result.model_copy(
            update={
                "snippet": annotation_quote.exact[:300],
                "locator": passage_target.locator,
                "captured_evidence": frozen,
                "context_ref": result.context_ref.model_copy(
                    update={"field": "annotation", "passage_target": passage_target}
                ),
            }
        )
    if passage_target is not None:
        current = result.captured_evidence.target
        if not isinstance(current, CapturedPassageTarget) or current.model_dump(
            mode="json"
        ) != passage_target.model_dump(mode="json"):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search passage changed")
    return result
