"""The five Nexus reads the model may make, inside the generation's admitted scope.

A read answers only for URIs the frozen scope admits, directly or as a read pointer
into an admitted parent; its domain owner decides visibility. Every success carries
an evidence receipt, and stages the citations the chat numbers for the model. Read
and inspect assemble one read-only snapshot; search metadata and relations are also
read-only. Each owner releases its reads before durable retrieval publication; the
captured evidence receipt remains the immutable fact of what the model received.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Never, cast
from uuid import UUID

from llm_tools import canonical_json_bytes
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind, Message, ResourceExternalSnapshot
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.ids import new_uuid7
from nexus.schemas.reader_document import ReaderTextBodyOut
from nexus.schemas.resource_graph import ConnectionFiltersRequest, ConnectionQueryRequest
from nexus.services import libraries
from nexus.services.chat.conversations import ConversationReadRefusal, read_message_page
from nexus.services.chat.retrievals import (
    RetrievalCitation,
    citation_from_search_result,
    web_citation,
)
from nexus.services.media_read_map import (
    READ_DOCUMENT_MAX_CHARS,
    get_media_read_map_for_viewer,
    load_media_document,
    read_page_range,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import (
    assert_ref_visible,
    load_resource_batch,
    parent_media_id_for_read_pointer,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.search import projection
from nexus.services.search.candidates import SearchResultMediaOut, SearchResultOut
from nexus.services.search.query import (
    KIND_TO_RESULT_TYPES,
    SearchScope,
    build_search_query,
    scope_from_uri,
)
from nexus.services.search.scope import reading_media_ids_sql
from nexus.services.search.service import get_search_result, search_scopes_async
from nexus.services.tools import assistant_writes
from nexus.services.tools.contract import (
    SEARCH_LIMIT,
    DocumentSearchInput,
    DocumentSearchMatch,
    DocumentSearchSuccess,
    LibraryInspectSuccess,
    MediaInspectSuccess,
    NexusEvidence,
    NexusSearchInput,
    NexusSearchMatch,
    NexusSearchSuccess,
    RelationMatch,
    RelationsListInput,
    RelationsListSuccess,
    ResourceInspectInput,
    ResourceInspectSection,
    ResourceInspectSuccess,
    ResourceReadInput,
    ResourceReadSuccess,
    refuse,
)

if TYPE_CHECKING:
    from nexus.services.tools.run import Call

# Prompt budgets: how many results of one call the model is shown as citable sources.
SEARCH_SELECTED, SEARCH_SELECTED_BYTES = 6, 16_000
WEB_SELECTED, WEB_SELECTED_CHARS = 5, 12_000
_MEDIA_RESULT_TYPE = {"podcast_episode": "episode", "video": "video"}


def _parse(uri: str) -> ResourceRef:
    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        refuse("ResourceUnavailable")
    return parsed


def parse_page_range(uri: str) -> tuple[UUID, int, int] | None:
    """``page_range:<media uuid>:<first>-<last>``, or None."""

    scheme, _, rest = uri.partition(":")
    media, _, pages = rest.partition(":")
    first, dash, last = pages.partition("-")
    if scheme != "page_range" or not dash:
        return None
    try:
        media_id, start, end = UUID(media), int(first), int(last)
    except ValueError:
        return None
    return (media_id, start, end) if str(media_id) == media and 1 <= start <= end else None


def admit(call: Call, uri: str, *, derived_read: bool = False) -> None:
    """Refuse a URI the frozen scope admits neither directly nor, for reads, as a pointer.

    A pointer is a page range of an admitted media, a complete user or assistant
    message of an admitted conversation, or a fragment-like ref of an admitted media.
    A displayed canonical X body also admits its exact fragment pointer; it never
    becomes another admitted media root that could expand further context.
    """

    scope = call.run.scope
    if uri in scope:
        return
    if not derived_read:
        refuse("ResourceUnavailable")
    pages = parse_page_range(uri)
    if pages is not None:
        if f"media:{pages[0]}" not in scope:
            refuse("ResourceUnavailable")
        return
    ref = _parse(uri)
    if ref.scheme == "message":
        conversation = call.db.scalar(
            select(Message.conversation_id).where(
                Message.id == ref.id,
                Message.status == "complete",
                Message.role.in_(("user", "assistant")),
            )
        )
        if f"conversation:{conversation}" not in scope:
            refuse("ResourceUnavailable")
        return
    media = parent_media_id_for_read_pointer(call.db, scheme=ref.scheme, resource_id=ref.id)
    if f"media:{media}" in scope:
        return
    if ref.scheme != "fragment":
        refuse("ResourceUnavailable")
    roots = [root.id for uri in scope if (root := _parse(uri)).scheme == "media"]
    if media is not None and roots:
        from nexus.services.reader_document import read_reader_document

        # The structural set only narrows candidates. The viewer's actual projection
        # proves which canonical bodies this frozen parent presently displays.
        for root_id in call.db.scalars(
            text(f"""SELECT admitted_root.media_id
                     FROM unnest(CAST(:roots AS uuid[])) admitted_root(media_id)
                     WHERE :source IN ({reading_media_ids_sql("SELECT admitted_root.media_id")})"""),
            {"roots": roots, "source": media},
        ):
            try:
                document = read_reader_document(call.db, call.principal, root_id)
            except ApiError as exc:
                if exc.code not in (
                    ApiErrorCode.E_MEDIA_NOT_FOUND,
                    ApiErrorCode.E_MEDIA_NOT_READY,
                ):
                    raise
                # justify-ignore-error: an unreadable parent cannot derive a source capability.
                continue
            if isinstance(document, ReaderTextBodyOut) and any(
                unit.x_post is not None
                and unit.x_post.owner is not None
                and unit.x_post.owner.media_id == media
                and unit.x_post.owner.fragment_id == ref.id
                for unit in document.units
            ):
                return
    refuse("ResourceUnavailable")


def admitted(call: Call, uri: str) -> ResourceRef:
    admit(call, uri)
    return _parse(uri)


def _visible(call: Call, uri: str) -> ResourceRef:
    ref = admitted(call, uri)
    try:
        assert_ref_visible(call.db, viewer_id=call.principal, ref=ref)
    except ApiError as exc:
        if exc.code is not ApiErrorCode.E_NOT_FOUND:
            raise
        refuse("ResourceUnavailable")
    return ref


def _sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _evidence(
    call: Call,
    uri: str,
    material: Any,
    citation: RetrievalCitation | None,
    content: str | None = None,
) -> NexusEvidence:
    """What the model was shown, fixed: its target, locator, content hash and authorship."""

    locator = None
    if citation is not None and citation.locator is not None:
        locator = json.dumps(citation.locator, sort_keys=True, separators=(",", ":"))
        locator = locator if len(locator) <= 512 else f"sha256:{_sha256(citation.locator)}"
    span = citation.evidence_span_id if citation is not None else None
    try:
        excerpt_id = UUID(span) if span is not None else None
    except ValueError:
        excerpt_id = None
    return NexusEvidence(
        admission_scope="conversation_context" if call.run.chat_run_id else "generation_scope",
        citation_target=(citation.citation_target if citation else None) or uri,
        content_sha256=hashlib.sha256(content.encode()).hexdigest()
        if content is not None
        else None,
        context_ref=uri,
        excerpt_id=excerpt_id,
        locator=locator,
        machine_authorship=assistant_writes.authorship_for_target(call.db, call.principal, uri),
        observed_at=None,
        resource_uri=uri,
        snapshot_revision=None if content is not None else _sha256(material),
    )


def _budgeted[T](items: Sequence[T], limit: int, budget: int, size: Callable[[T], int]) -> int:
    """How many leading items fit ``limit`` and the size budget."""

    used = count = 0
    for item in items[:limit]:
        used += size(item)
        if used > budget:
            break
        count += 1
    return count


def _cite(
    call: Call, result_type: str | None, source_id: str, uri: str
) -> RetrievalCitation | None:
    """Stage the one citation of a single-resource read, if the resource is citable."""

    if result_type is None:
        return None
    try:
        result = get_search_result(call.db, call.principal, result_type, source_id)
    except ApiError as exc:
        if exc.code is not ApiErrorCode.E_NOT_FOUND:
            raise
        return None
    citation = citation_from_search_result(result)
    call.retrieved = call.selected = [citation]
    return citation


def _title(item: SearchResultOut) -> str:
    return item.media_summary.title if isinstance(item, SearchResultMediaOut) else item.title


def _collapse(exc: ApiError, *codes: ApiErrorCode) -> Never:
    if exc.code not in codes:
        raise exc
    refuse("ResourceUnavailable")


async def search(value: NexusSearchInput, call: Call) -> NexusSearchSuccess:
    frozen = tuple(_parse(uri) for uri in sorted(call.run.scope))
    if value.scopes is None:
        # every admitted target, plus the bounded descendants of admitted media and libraries.
        scopes = [SearchScope(kind="all")] if frozen else []
        scopes += [scope_from_uri(ref.uri) for ref in frozen if ref.scheme in ("media", "library")]
    else:
        scopes = []
        for uri in value.scopes:
            if not capability(admitted(call, uri).scheme).app_search_scope:
                refuse("ResourceUnavailable")
            scopes.append(scope_from_uri(uri))
    if not scopes:
        return NexusSearchSuccess(matches=[], has_more=False)
    filters = {
        key: list(items)
        for key, items in (
            ("kinds", value.kinds),
            ("formats", value.formats),
            ("authors", value.authors),
            ("roles", value.roles),
        )
        if items is not None
    }
    query = build_search_query(
        text=value.query,
        raw_kinds=filters.get("kinds"),
        raw_formats=filters.get("formats"),
        raw_authors=filters.get("authors"),
        raw_roles=filters.get("roles"),
        scope=scope_from_uri("all"),
        cursor=None,
        limit=value.limit or SEARCH_LIMIT,
    )
    try:
        response = await search_scopes_async(
            call.principal,
            replace(query, frozen_context_refs=frozen),
            scopes,
            deadline=call.deadline,
        )
    except ApiError as exc:
        _collapse(exc, ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_CONVERSATION_NOT_FOUND)

    def finish(_: Session) -> NexusSearchSuccess:
        call.retrieved = [citation_from_search_result(r) for r in response.results]
        count = _budgeted(
            call.retrieved,
            SEARCH_SELECTED,
            SEARCH_SELECTED_BYTES,
            lambda citation: len(canonical_json_bytes(citation.result_ref_json())),
        )
        call.selected = call.retrieved[:count]
        matches = [
            NexusSearchMatch(
                evidence=_evidence(call, item.resource_ref, item.model_dump(mode="json"), citation),
                excerpt=item.snippet[:300],
                kind=next(k for k, types in KIND_TO_RESULT_TYPES.items() if item.type in types),
                score=min(1.0, max(0.0, float(item.score))),
                title=_title(item)[:150],
                uri=item.resource_ref,
            )
            for item, citation in zip(response.results, call.retrieved, strict=True)
        ]
        return NexusSearchSuccess(matches=matches, has_more=response.page.has_more)

    try:
        return await call.database.run_sync(finish)
    finally:
        await call.database.rollback()


async def document_search(value: DocumentSearchInput, call: Call) -> DocumentSearchSuccess:
    try:
        await call.database.run_sync(lambda _: _visible(call, value.uri))
    finally:
        await call.database.rollback()
    query = build_search_query(
        text=value.query,
        raw_kinds=["documents"],
        raw_formats=None,
        raw_authors=None,
        raw_roles=None,
        scope=scope_from_uri(value.uri),
        cursor=None,
        limit=value.limit or 8,
    )
    try:
        response = await search_scopes_async(
            call.principal, query, (query.scope,), deadline=call.deadline
        )
    except ApiError as exc:
        _collapse(exc, ApiErrorCode.E_NOT_FOUND)

    def finish(_: Session) -> DocumentSearchSuccess:
        call.retrieved = [citation_from_search_result(r) for r in response.results]
        call.selected = call.retrieved
        matches = [
            DocumentSearchMatch(
                evidence=_evidence(call, item.resource_ref, item.model_dump(mode="json"), citation),
                ordinal=ordinal,
                score=min(1.0, max(0.0, float(item.score))),
                # Search snippets are plain text; literal markup belongs to the source.
                text=item.snippet[:2000],
                title=_title(item)[:500],
                uri=item.resource_ref,
            )
            for ordinal, (item, citation) in enumerate(
                zip(response.results, call.retrieved, strict=True)
            )
        ]
        return DocumentSearchSuccess(matches=matches, uri=value.uri)

    try:
        return await call.database.run_sync(finish)
    finally:
        await call.database.rollback()


def read(value: ResourceReadInput, call: Call) -> ResourceReadSuccess:
    get_repeatable_read_db(call.db)
    try:
        admit(call, value.uri, derived_read=True)
        kind, body, cited, next_cursor = _read(call.db, call.principal, value.uri, value.cursor)
        if len(body) > READ_DOCUMENT_MAX_CHARS:
            refuse("TooLarge")
        citation = _cite(call, *cited, value.uri) if cited else None
        return ResourceReadSuccess(
            evidence=_evidence(call, value.uri, None, citation, content=body),
            kind=kind,
            text=body,
            uri=value.uri,
            next_cursor=next_cursor,
        )
    finally:
        call.db.rollback()


def _read(
    db: Session, viewer_id: UUID, uri: str, cursor: str | None
) -> tuple[Any, str, tuple[str | None, str] | None, str | None]:
    """(contract kind, exact text, citable (result type, id), next cursor) of one read."""

    pages = parse_page_range(uri)
    if pages is not None:
        if cursor is not None:
            refuse("InvalidCursor")
        body = read_page_range(db, viewer_id, *pages)
        if body is None:
            refuse("ResourceUnavailable")
        return "page_range", body, ("media", str(pages[0])), None
    ref = _parse(uri)
    if ref.scheme in ("conversation", "message"):
        page = read_message_page(db, viewer_id=viewer_id, ref=ref, cursor=cursor)
        if isinstance(page, ConversationReadRefusal):
            refuse(
                {"invalid_cursor": "InvalidCursor", "stale_cursor": "StaleCursor"}.get(
                    page.code, "ResourceUnavailable"
                )
            )
        if ref.scheme == "conversation":
            return "conversation", page.body, None, page.next_cursor
        return "section", page.body, ("message", str(ref.id)), page.next_cursor
    if cursor is not None:
        refuse("InvalidCursor")
    policy = capability(ref.scheme).readable
    if policy in ("scope", "none"):
        refuse("Unreadable")
    if policy == "media":
        document = load_media_document(db, viewer_id, ref.id)
        if document is None:
            refuse("ResourceUnavailable")
        return (
            "full",
            document.body,
            (_MEDIA_RESULT_TYPE.get(document.kind, "media"), str(ref.id)),
            None,
        )
    loaded = load_resource_batch(db, [ref], viewer_id=viewer_id)[uri]
    if loaded.missing:
        refuse("ResourceUnavailable")
    cited = capability(ref.scheme).citable_result_type
    citation = None if cited is None else (cited, str(ref.id))
    if ref.scheme == "highlight":
        assert loaded.quote is not None  # the highlight loader always sets its visible quote
        return "quote", loaded.quote.exact, citation, None
    if ref.scheme == "passage_anchor":
        return "quote", loaded.body or "", citation, None
    kind = "oracle_reading" if ref.scheme == "oracle_reading" else "section"
    return kind, loaded.body or "", citation, None


def inspect(value: ResourceInspectInput, call: Call) -> ResourceInspectSuccess:
    get_repeatable_read_db(call.db)
    try:
        return _inspect(value, call)
    finally:
        call.db.rollback()


def _inspect(value: ResourceInspectInput, call: Call) -> ResourceInspectSuccess:
    ref = admitted(call, value.uri)
    if ref.scheme == "library":
        try:
            library = libraries.access(call.db, call.principal, ref.id, lock=False)
        except ApiError as exc:
            _collapse(exc, ApiErrorCode.E_LIBRARY_NOT_FOUND, ApiErrorCode.E_NOT_FOUND)
        removal_revision = call.db.scalar(
            text("SELECT removal_revision FROM users WHERE id=:id"), {"id": call.principal}
        )
        assert removal_revision is not None
        material = {
            "name": library.name,
            "order_revision": str(library.order_revision),
            "removal_revision": str(removal_revision),
            "can_manage": library.mutable and library.role == "admin",
        }
        return ResourceInspectSuccess(
            resource=LibraryInspectSuccess(
                evidence=_evidence(call, value.uri, material, None),
                uri=value.uri,
                library_id=library.id,
                name=library.name,
                order_revision=str(library.order_revision),
                removal_revision=str(removal_revision),
                can_manage=library.mutable and library.role == "admin",
            )
        )
    if capability(ref.scheme).readable != "media":
        refuse("Uninspectable")
    document = get_media_read_map_for_viewer(call.db, call.principal, ref.id)
    if document is None:
        refuse("ResourceUnavailable")
    sections = [
        ResourceInspectSection(
            fragment_id=section.fragment_id,
            label=section.label[:310],
            ordinal=section.ordinal,
            page_end=section.page_end,
            page_start=section.page_start,
            parent_label=section.parent_label[:310] if section.parent_label else None,
            preview=section.preview[:470],
            read_uri=section.read_uri,
            section_kind=cast(Any, section.section_kind),
            t_end_ms=section.t_end_ms,
            t_start_ms=section.t_start_ms,
        )
        for section in document.sections
    ]
    result_type = _MEDIA_RESULT_TYPE.get(document.kind, "media")
    citation = _cite(call, result_type, str(ref.id), value.uri)
    material = {
        "kind": document.kind,
        "sections": [section.model_dump(mode="json") for section in sections],
        "title": document.title,
        "total_sections": document.total_sections,
    }
    return ResourceInspectSuccess(
        resource=MediaInspectSuccess(
            evidence=_evidence(call, value.uri, material, citation),
            media_kind=MediaKind(document.kind),
            sections=sections,
            title=document.title,
            total_sections=document.total_sections,
            uri=value.uri,
        )
    )


def relations(value: RelationsListInput, call: Call) -> RelationsListSuccess:
    try:
        ref = _visible(call, value.uri)
        page = query_connections(
            call.db,
            viewer_id=call.principal,
            query=ConnectionQueryRequest(
                refs=[ref.uri],
                direction=value.direction,
                filters=ConnectionFiltersRequest(kinds=value.kinds),
                limit=value.limit or 100,
            ),
        )
        authors = assistant_writes.edge_authorships(
            call.db, call.principal, [item.edge_id for item in page.items]
        )
        found = [
            RelationMatch(
                direction=item.direction,
                edge_id=item.edge_id,
                kind=item.kind,
                machine_authorship=authors.get(item.edge_id),
                rationale=item.snapshot.rationale[:150]
                if item.snapshot and item.snapshot.rationale
                else None,
                source_label=item.source.label[:150] if item.source.label else None,
                source_uri=item.source.ref,
                target_label=item.target.label[:150] if item.target.label else None,
                target_uri=item.target.ref,
            )
            for item in page.items
        ]
        citation = _cite(call, capability(ref.scheme).citable_result_type, str(ref.id), value.uri)
        return RelationsListSuccess(
            evidence=_evidence(
                call, value.uri, [r.model_dump(mode="json") for r in found], citation
            ),
            relations=found,
            uri=value.uri,
        )
    finally:
        call.db.rollback()


def web_citations(call: Call, value: dict[str, Any]) -> None:
    """One external snapshot per web hit, staged as citations; leading hits under budget are shown."""

    hits = value["results"]
    count = _budgeted(
        hits, WEB_SELECTED, WEB_SELECTED_CHARS, lambda hit: len(canonical_json_bytes(hit).decode())
    )
    snapshot_ids: list[UUID] = []
    for index, hit in enumerate(hits):
        snapshot_id = new_uuid7()
        call.db.add(
            ResourceExternalSnapshot(
                id=snapshot_id,
                user_id=call.principal,
                provider=hit["provider"],
                url=hit["url"],
                title=hit["title"],
                snippet=hit["snippet"],
            )
        )
        snapshot_ids.append(snapshot_id)
        citation = web_citation(hit, snapshot_id=snapshot_id, selected=index < count)
        call.retrieved.append(citation)
        if index < count:
            call.selected.append(citation)
    call.db.flush()  # the retrieval rows reference the snapshots
    projection.refresh(call.db, "web_result", snapshot_ids)


HANDLERS: dict[str, Callable[..., Any]] = {
    "nexus.search": search,
    "nexus.document.search": document_search,
    "nexus.resource.read": read,
    "nexus.resource.inspect": inspect,
    "nexus.relations.list": relations,
}
