"""Account-authorized librarian reads and bounded background resource reads.

Chat reads stop at the current question; background reads stay inside their
captured resource scope. Domain owners decide visibility. Source evidence is
transient model input; chat publishes only live citation targets. Each read
releases its database snapshot before durable retrieval publication.
A piece passage follows its reading identity, never its source pointer.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Never, cast
from uuid import UUID

from llm_tools import BoundaryFailure, canonical_json_bytes
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.authored import NoteWork
from nexus.schemas.resource_evidence import ResourceField
from nexus.schemas.resource_graph import ConnectionFiltersRequest, ConnectionQueryRequest
from nexus.schemas.retrieval import EpubFragmentOffsetsLocator, WebTextOffsetsLocator
from nexus.services import libraries
from nexus.services.chat.retrievals import (
    RetrievalCitation,
    citation_from_evidence,
    citation_from_search_result,
    reopen_search_result,
    web_citation,
)
from nexus.services.chat.timeline import MessageReadRefusal, read_message_page
from nexus.services.media_read_map import (
    READ_DOCUMENT_MAX_CHARS,
    DocumentTooLarge,
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
    parent_media_id_for_read_pointer,
    read_resource,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.evidence import read_evidence
from nexus.services.search.candidates import SearchResultMediaOut, SearchResultOut
from nexus.services.search.query import (
    KIND_TO_RESULT_TYPES,
    SearchScope,
    build_search_query,
    scope_from_uri,
)
from nexus.services.search.service import capture_search_scopes_async, search_scopes_async
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
    ResourceWork,
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


def message_admitted(call: Call, ref: ResourceRef) -> bool:
    """Message reads stop at this question, regardless of later queue admissions."""
    if call.run.chat_run_id is None:
        return True
    message_id = ref.id if ref.scheme == "message" else None
    if ref.scheme == "passage_anchor":
        message_id = call.db.scalar(
            text("SELECT owner_id FROM passage_anchors WHERE id=:id AND owner_scheme='message'"),
            {"id": ref.id},
        )
    if message_id is None:
        return True
    from nexus.services.chat.timeline import message_visible

    horizon = call.message_horizon_seq
    assert horizon is not None, "a chat tool must capture its horizon before dispatch"
    return message_visible(call.db, call.principal, message_id, horizon)


def admit(call: Call, uri: str, *, derived_read: bool = False) -> None:
    """Enforce account visibility and the chat horizon, or a background scope.

    Background reads may follow admitted media to pages or fragment-like pointers.
    A displayed canonical X body admits its exact fragment, not another media root.
    """

    scope = call.run.scope
    pages = parse_page_range(uri)
    if call.run.chat_run_id is not None:
        ref = _parse(f"media:{pages[0]}" if pages is not None else uri)
        if not message_admitted(call, ref):
            refuse("ResourceUnavailable")
        try:
            assert_ref_visible(call.db, viewer_id=call.principal, ref=ref)
        except ApiError as exc:
            _collapse(exc, ApiErrorCode.E_NOT_FOUND)
        return
    if uri in scope:
        return
    if not derived_read:
        refuse("ResourceUnavailable")
    if pages is not None:
        if f"media:{pages[0]}" not in scope:
            refuse("ResourceUnavailable")
        return
    ref = _parse(uri)
    media = parent_media_id_for_read_pointer(call.db, scheme=ref.scheme, resource_id=ref.id)
    if f"media:{media}" in scope:
        return
    if ref.scheme not in {"fragment", "content_chunk", "evidence_span"}:
        refuse("ResourceUnavailable")
    fragment_id = (
        ref.id
        if ref.scheme == "fragment"
        else call.db.scalar(
            text(f"SELECT owner_id FROM {ref.scheme}s WHERE id=:id AND owner_kind='fragment'"),
            {"id": ref.id},
        )
    )
    roots = [root.id for uri in scope if (root := _parse(uri)).scheme == "media"]
    if fragment_id is not None and roots:
        from nexus.auth.permissions import requested_media_ids_cte_sql
        from nexus.services.media_text_scope import x_capture_scope_rows_sql
        from nexus.services.x_source import readable_x_capture_ids_sql

        candidates = f"SELECT media_id FROM unnest(CAST(:roots AS uuid[])) AS root(media_id) WHERE media_id IN ({requested_media_ids_cte_sql()})"
        visible = call.db.scalar(
            text(f"""SELECT EXISTS (
            SELECT 1 FROM ({x_capture_scope_rows_sql(candidates)}) occurrence
            JOIN ({readable_x_capture_ids_sql()}) readable ON readable.capture_id=occurrence.capture_id
            WHERE occurrence.fragment_id=:fragment)"""),
            {"roots": roots, "fragment": fragment_id, "viewer_id": call.principal},
        )
        if visible:
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
    *,
    field: ResourceField = None,
) -> NexusEvidence:
    """What the model was shown, fixed: its target, locator, content hash and authorship."""

    if (
        citation is not None
        and citation.captured_evidence is not None
        and citation.captured_evidence.target.field == "annotation"
    ):
        field = "annotation"
        uri = citation.captured_evidence.target.owner_ref or uri
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
        field=field,
        admission_scope="account_timeline" if call.run.chat_run_id else "generation_scope",
        citation_target=(citation.citation_target if citation else None) or uri,
        content_sha256=hashlib.sha256(content.encode()).hexdigest()
        if content is not None
        else None,
        context_ref=uri,
        excerpt_id=excerpt_id,
        locator=locator,
        machine_authorship=assistant_writes.authorship_for_target(
            call.db, call.principal, uri, field=field
        ),
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
    call: Call, result_type: str | None, source_id: str, uri: str, *, field: ResourceField = None
) -> RetrievalCitation | None:
    """Stage the one citation of a single-resource read, if the resource is citable."""

    if result_type is None:
        return None
    try:
        if call.run.chat_run_id is None:
            evidence = read_evidence(
                call.db,
                viewer_id=call.principal,
                ref=ResourceRef("media", UUID(source_id))
                if parse_page_range(uri) is not None
                else _parse(uri),
                field=field,
            )
            citation = citation_from_evidence(call.db, viewer_id=call.principal, evidence=evidence)
            if citation is not None:
                call.retrieved = call.selected = [citation]
            return citation
        result = reopen_search_result(
            call.db,
            viewer_id=call.principal,
            result_type=result_type,
            source_id=source_id,
            field=field,
        )
    except ApiError as exc:
        # A passage whose body moved during the read has no provable citation.
        if exc.code not in (ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_READER_CONTENT_CHANGED):
            raise
        return None
    citation = citation_from_search_result(result)
    call.retrieved = call.selected = [citation]
    return citation


def _title(item: SearchResultOut) -> str:
    return item.media_summary.title if isinstance(item, SearchResultMediaOut) else item.title


def _follow_up(item: SearchResultOut) -> str:
    """The uri the model reads a hit through: its reading piece when one answers for its
    canonical source passage, else the hit itself."""
    target = item.context_ref.passage_target
    if (
        target is not None
        and isinstance(target.locator, WebTextOffsetsLocator | EpubFragmentOffsetsLocator)
        and target.owner_ref != f"media:{target.locator.media_id}"
    ):
        return target.owner_ref
    return item.resource_ref


def _collapse(exc: ApiError, *codes: ApiErrorCode) -> Never:
    if exc.code not in codes:
        raise exc
    refuse("ResourceUnavailable")


async def search(value: NexusSearchInput, call: Call) -> NexusSearchSuccess:
    frozen = tuple(_parse(uri) for uri in sorted(call.run.scope))

    def read_scopes(_: Session) -> list[SearchScope]:
        if value.scopes is None:
            scopes = [SearchScope(kind="all")] if frozen or call.run.chat_run_id else []
            scopes += [
                scope_from_uri(ref.uri) for ref in frozen if ref.scheme in ("media", "library")
            ]
            return scopes
        scopes = []
        for uri in value.scopes:
            if not capability(admitted(call, uri).scheme).app_search_scope:
                refuse("ResourceUnavailable")
            scopes.append(scope_from_uri(uri))
        return scopes

    try:
        scopes = await call.database.run_sync(read_scopes)
    finally:
        await call.database.rollback()
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
        search_scopes = (
            capture_search_scopes_async if call.run.chat_run_id is not None else search_scopes_async
        )
        response = await search_scopes(
            call.principal,
            replace(
                query,
                frozen_context_refs=None if call.run.chat_run_id else frozen,
                message_horizon_seq=call.message_horizon_seq,
            ),
            scopes,
            deadline=call.deadline,
            purpose="foreground",
        )
    except ApiError as exc:
        if exc.code is ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE:
            raise BoundaryFailure("ToolUnavailable") from exc
        _collapse(exc, ApiErrorCode.E_NOT_FOUND)

    def finish(_: Session) -> NexusSearchSuccess:
        results = [r for r in response.results if message_admitted(call, _parse(r.resource_ref))]
        call.retrieved = [citation_from_search_result(r) for r in results]
        count = _budgeted(
            call.retrieved,
            SEARCH_SELECTED,
            SEARCH_SELECTED_BYTES,
            lambda citation: len(canonical_json_bytes(citation.result_ref_json())),
        )
        call.selected = call.retrieved[:count]
        matches = [
            NexusSearchMatch(
                evidence=_evidence(call, _follow_up(item), item.model_dump(mode="json"), citation),
                excerpt=item.snippet[:300],
                kind=next(k for k, types in KIND_TO_RESULT_TYPES.items() if item.type in types),
                score=min(1.0, max(0.0, float(item.score))),
                title=_title(item)[:150],
                uri=_follow_up(item),
            )
            for item, citation in zip(results, call.retrieved, strict=True)
        ]
        return NexusSearchSuccess(matches=matches, has_more=response.page.has_more)

    try:
        return await call.database.run_sync(finish)
    finally:
        await call.database.rollback()


async def document_search(value: DocumentSearchInput, call: Call) -> DocumentSearchSuccess:
    try:
        ref = await call.database.run_sync(lambda _: _visible(call, value.uri))
        if not capability(ref.scheme).app_search_scope:
            refuse("InvalidInput")
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
        search_scopes = (
            capture_search_scopes_async if call.run.chat_run_id is not None else search_scopes_async
        )
        response = await search_scopes(
            call.principal, query, (query.scope,), deadline=call.deadline, purpose="foreground"
        )
    except ApiError as exc:
        if exc.code is ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE:
            raise BoundaryFailure("ToolUnavailable") from exc
        _collapse(exc, ApiErrorCode.E_NOT_FOUND)

    def finish(_: Session) -> DocumentSearchSuccess:
        results = [r for r in response.results if message_admitted(call, _parse(r.resource_ref))]
        call.retrieved = [citation_from_search_result(r) for r in results]
        call.selected = call.retrieved
        matches = [
            DocumentSearchMatch(
                evidence=_evidence(call, _follow_up(item), item.model_dump(mode="json"), citation),
                ordinal=ordinal,
                score=min(1.0, max(0.0, float(item.score))),
                # Search snippets are plain text; literal markup belongs to the source.
                text=item.snippet[:2000],
                title=_title(item)[:500],
                uri=_follow_up(item),
            )
            for ordinal, (item, citation) in enumerate(zip(results, call.retrieved, strict=True))
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
        try:
            kind, body, cited, next_cursor = _read(
                call.db, call.principal, value.uri, value.cursor, field=value.field
            )
        except DocumentTooLarge:
            refuse("TooLarge")
        if len(body) > READ_DOCUMENT_MAX_CHARS:
            refuse("TooLarge")
        citation = _cite(call, *cited, value.uri, field=value.field) if cited else None
        work = None
        if value.uri.startswith("note_block:"):
            metadata = call.db.execute(
                text(
                    "SELECT state FROM authored_resources WHERE account_id=:a AND ref=:r AND visible"
                ),
                {"a": call.principal, "r": value.uri},
            ).scalar_one_or_none()
            if metadata is None:
                refuse("ResourceUnavailable")
            if metadata["work"] is not None:
                state = NoteWork.model_validate(metadata["work"])
                dates = sorted(day for day, check in state.habit_checks.items() if check.value)
                requested = value.work_date_range
                work = ResourceWork(
                    designation=state.designation.value,
                    task_completed_on=state.task_completed_on.value
                    if state.task_completed_on
                    else None,
                    has_habit_completions=bool(dates),
                    work_date_range=requested,
                    habit_dates=None
                    if requested is None
                    else [day for day in dates if requested.from_date <= day <= requested.to_date],
                    source="server_accepted",
                )
        evidence = _evidence(call, value.uri, None, citation, content=body, field=value.field)
        if value.uri.startswith("note_block:"):
            evidence.snapshot_revision = _sha256(
                {
                    "text": body,
                    "work": None if work is None else work.model_dump(mode="json"),
                }
            )
        return ResourceReadSuccess(
            evidence=evidence,
            kind=kind,
            text=body,
            uri=value.uri,
            next_cursor=next_cursor,
            work=work,
        )
    finally:
        call.db.rollback()


def _read(
    db: Session, viewer_id: UUID, uri: str, cursor: str | None, *, field: ResourceField
) -> tuple[Any, str, tuple[str | None, str] | None, str | None]:
    """(contract kind, exact text, citable (result type, id), next cursor) of one read."""

    if field == "annotation":
        ref = _parse(uri)
        if ref.scheme != "highlight":
            refuse("InvalidInput")
        if cursor is not None:
            refuse("InvalidCursor")
        from nexus.services.highlights import read_highlight_annotations

        size = db.scalar(
            text(
                "SELECT char_length(annotation_body_text) FROM highlights WHERE id=:id AND user_id=:viewer AND authored_visible"
            ),
            {"id": ref.id, "viewer": viewer_id},
        )
        if size is not None and size > READ_DOCUMENT_MAX_CHARS:
            raise DocumentTooLarge(uri)
        annotation = read_highlight_annotations(
            db, viewer_id=viewer_id, highlight_ids=[ref.id]
        ).get(ref.id)
        if annotation is None:
            refuse("ResourceUnavailable")
        return (
            "section",
            annotation.body_text,
            ("highlight", str(ref.id)) if annotation.body_text else None,
            None,
        )
    pages = parse_page_range(uri)
    if pages is not None:
        if cursor is not None:
            refuse("InvalidCursor")
        body = read_page_range(db, viewer_id, *pages)
        if body is None:
            refuse("ResourceUnavailable")
        return "page_range", body, ("media", str(pages[0])), None
    ref = _parse(uri)
    if ref.scheme == "message":
        page = read_message_page(db, viewer_id=viewer_id, ref=ref, cursor=cursor)
        if isinstance(page, MessageReadRefusal):
            refuse("InvalidCursor" if page.code == "invalid_cursor" else "ResourceUnavailable")
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
    loaded = read_resource(db, viewer_id=viewer_id, ref=ref)
    if loaded.missing:
        refuse("ResourceUnavailable")
    cited = capability(ref.scheme).citable_result_type
    citation = None if cited is None else (cited, str(ref.id))
    if ref.scheme == "content_chunk":
        annotation_span = db.scalar(
            text(
                "SELECT primary_evidence_span_id FROM content_chunks WHERE id=:id AND owner_kind='highlight'"
            ),
            {"id": ref.id},
        )
        if annotation_span is not None:
            citation = ("evidence_span", str(annotation_span))
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
            if all(
                message_admitted(call, _parse(uri))
                for uri in (item.source.ref, item.target.ref)
                if uri is not None
            )
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
    """Retain web urls as live targets; transient hit text goes only to the model."""

    hits = value["results"]
    count = _budgeted(
        hits, WEB_SELECTED, WEB_SELECTED_CHARS, lambda hit: len(canonical_json_bytes(hit).decode())
    )
    for index, hit in enumerate(hits):
        citation = web_citation(hit, selected=index < count)
        call.retrieved.append(citation)
        if index < count:
            call.selected.append(citation)


HANDLERS: dict[str, Callable[..., Any]] = {
    "nexus.search": search,
    "nexus.document.search": document_search,
    "nexus.resource.read": read,
    "nexus.resource.inspect": inspect,
    "nexus.relations.list": relations,
}
