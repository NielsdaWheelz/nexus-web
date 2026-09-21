"""The ten Nexus domain adapters behind the canonical ``nexus.*`` bindings.

Each adapter runs under the lease-fenced position recorder: it checks the
frozen admission set, calls the concern's existing owner, stages the audit
projection the terminal commit persists, and answers a reviewed domain refusal
as a declared tool failure rather than an exception.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from functools import partial
from typing import TYPE_CHECKING, Any, Never, cast
from uuid import UUID

from llm_tools import (
    BoundaryFailure,
    DeclaredToolFailure,
    ExecutionContext,
    ExecutorConfigurationDefect,
    HandlerSuccess,
    ToolId,
    canonical_json_bytes,
)
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_CONTEXT_CHARS,
    APP_SEARCH_LIMIT,
    APP_SEARCH_SELECTED_LIMIT,
)
from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.tool_authority import (
    ToolAuditProjection,
    ToolPositionRecorder,
)
from nexus.services.tool_runtime import declarations as tool_declarations
from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

if TYPE_CHECKING:
    from nexus.services.resource_graph.refs import ResourceRef


async def execute_nexus_tool(
    value: object,
    context: ExecutionContext,
    *,
    tool_id: ToolId,
) -> HandlerSuccess[Any]:
    """Dispatch one canonical binding identity to its domain adapter."""

    name = str(tool_id)
    if name == "nexus.search":
        return await _run_search(cast(tool_declarations.NexusSearchInput, value), context)
    if name == "nexus.document.search":
        return await _run_document_search(
            cast(tool_declarations.DocumentSearchInput, value), context
        )
    handler = _HANDLERS.get(name)
    if handler is None:
        raise ExecutorConfigurationDefect(f"Nexus execution has no handler for {name}")
    recorder = _nexus_recorder(context)
    return await recorder.database.run_sync(lambda _db: handler(value, context))


def _nexus_recorder(context: ExecutionContext) -> ToolPositionRecorder:
    recorder = context.recorder
    if not isinstance(recorder, ToolPositionRecorder):
        raise ExecutorConfigurationDefect(
            "Nexus domain tools require the canonical generation position recorder"
        )
    try:
        principal = UUID(str(context.principal))
    except ValueError as exc:
        raise ExecutorConfigurationDefect("Nexus principal is not a UUID") from exc
    if principal != recorder.principal_id:
        raise ExecutorConfigurationDefect("Nexus principal differs from tool authority")
    return recorder


def _declared_failure(error: object) -> Never:
    raise DeclaredToolFailure(error, actual_attempts=0)


def _resource_unavailable() -> Never:
    _declared_failure(tool_declarations.ResourceUnavailable(type="ResourceUnavailable"))


def _collapse_expected_unavailable(
    exc: ApiError,
    *,
    allowed_codes: frozenset[ApiErrorCode],
) -> Never:
    """Collapse only reviewed owner denials; every other API error defects."""

    if exc.code in allowed_codes:
        _resource_unavailable()
    raise exc


def _parse_ref_or_unavailable(uri: str) -> ResourceRef:
    from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        _resource_unavailable()
    return parsed


def _admitted_target(
    recorder: ToolPositionRecorder,
    uri: str,
    *,
    allow_derived_read: bool = False,
) -> ResourceRef:
    """Return the parsed target after the operation-owned frozen admission set."""

    from nexus.services.tool_runtime.resource_scope import resource_uri_is_admitted

    if not resource_uri_is_admitted(
        recorder.db,
        uri=uri,
        admitted_resource_uris=recorder.admitted_resource_uris,
        allow_derived_read=allow_derived_read,
    ):
        _resource_unavailable()
    return _parse_ref_or_unavailable(uri)


def _assert_visible(recorder: ToolPositionRecorder, uri: str) -> ResourceRef:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    ref = _admitted_target(recorder, uri)
    try:
        assert_ref_visible(recorder.db, viewer_id=recorder.principal_id, ref=ref)
    except ApiError as exc:
        _collapse_expected_unavailable(exc, allowed_codes=frozenset({ApiErrorCode.E_NOT_FOUND}))
    return ref


def _snapshot_revision(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(cast("Any", value))).hexdigest()


def _citation_locator(citation: RetrievalCitation | None) -> str | None:
    if citation is None or citation.locator is None:
        return None
    encoded = json.dumps(citation.locator, sort_keys=True, separators=(",", ":"))
    return encoded if len(encoded) <= 512 else f"sha256:{_snapshot_revision(citation.locator)}"


def _evidence(
    context: ExecutionContext,
    *,
    resource_uri: str,
    material: object,
    citation: RetrievalCitation | None = None,
    content: str | None = None,
) -> tool_declarations.NexusEvidence:
    from nexus.services.assistant_write_authorship import machine_authorship_for_resource_uri

    recorder = _nexus_recorder(context)
    excerpt_id = None
    if citation is not None and citation.evidence_span_id is not None:
        try:
            excerpt_id = UUID(citation.evidence_span_id)
        except ValueError:
            excerpt_id = None
    return tool_declarations.NexusEvidence(
        admission_scope=str(context.scope),
        citation_target=(citation.citation_target if citation else None) or resource_uri,
        content_sha256=(
            hashlib.sha256(content.encode("utf-8")).hexdigest() if content is not None else None
        ),
        context_ref=resource_uri,
        excerpt_id=excerpt_id,
        locator=_citation_locator(citation),
        machine_authorship=machine_authorship_for_resource_uri(
            recorder.db,
            viewer_id=recorder.principal_id,
            resource_uri=resource_uri,
        ),
        observed_at=None,
        resource_uri=resource_uri,
        snapshot_revision=None if content is not None else _snapshot_revision(material),
    )


def _citation_for_ref(
    recorder: ToolPositionRecorder,
    *,
    result_type: str | None,
    source_id: str,
    filters: dict[str, Any],
) -> RetrievalCitation | None:
    if result_type is None:
        return None
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search.resolver import get_search_result

    try:
        result = get_search_result(recorder.db, recorder.principal_id, result_type, source_id)
        return citation_from_search_result(result, filters=filters)
    except ApiError as exc:
        if exc.code is ApiErrorCode.E_NOT_FOUND:
            return None
        raise


def _kind_for_result_type(result_type: str) -> str:
    from nexus.services.search.kinds import KIND_TO_RESULT_TYPES

    matches = [
        kind for kind, result_types in KIND_TO_RESULT_TYPES.items() if result_type in result_types
    ]
    if len(matches) != 1:
        raise AssertionError(f"search result type lacks one public kind: {result_type!r}")
    return matches[0]


def _selected_nexus_search_citations(
    citations: Sequence[RetrievalCitation],
) -> list[RetrievalCitation]:
    """Select ranked result refs under the Nexus-search prompt budget."""

    selected: list[RetrievalCitation] = []
    total_bytes = 0
    for citation in citations[:APP_SEARCH_SELECTED_LIMIT]:
        result_ref_bytes = len(canonical_json_bytes(citation.result_ref_json()))
        if total_bytes + result_ref_bytes > APP_SEARCH_CONTEXT_CHARS:
            break
        selected.append(citation)
        total_bytes += result_ref_bytes
    return selected


async def _run_search(
    value: tool_declarations.NexusSearchInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.NexusSearchSuccess]:
    from nexus.services.resource_items.capabilities import resource_can_be_app_search_scope
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search.batch import search_scopes_async
    from nexus.services.search.query import SearchQuery, SearchScope, build_search_query
    from nexus.services.search.scope import scope_from_uri
    from nexus.services.search.telemetry import hash_query

    recorder = _nexus_recorder(context)
    viewer_id = recorder.principal_id

    def prepare(
        _db: Session,
    ) -> tuple[SearchQuery, list[SearchScope], list[str], dict[str, list[str]]]:
        with recorder.db.begin():
            requested_scopes = list(value.scopes or ())
            if value.scopes is None:
                requested_scopes = [
                    uri
                    for uri in sorted(recorder.admitted_resource_uris)
                    if resource_can_be_app_search_scope(_parse_ref_or_unavailable(uri))
                ]
            scopes = []
            for uri in requested_scopes:
                ref = _admitted_target(recorder, uri)
                if not resource_can_be_app_search_scope(ref):
                    _resource_unavailable()
                scopes.append(scope_from_uri(uri))
            query = build_search_query(
                text=value.query,
                raw_kinds=list(value.kinds) if value.kinds is not None else None,
                raw_formats=list(value.formats) if value.formats is not None else None,
                raw_authors=list(value.authors) if value.authors is not None else None,
                raw_roles=list(value.roles) if value.roles is not None else None,
                scope=scope_from_uri("all"),
                cursor=None,
                limit=value.limit or APP_SEARCH_LIMIT,
            )
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
            return query, scopes, requested_scopes, filters

    query, scopes, requested_scopes, filters = await recorder.database.run_sync(prepare)
    if not scopes:
        recorder.stage_audit(
            ToolAuditProjection(
                scope="conversation_context",
                requested_types=list(query.effective_result_types),
                filters=filters,
                search_query_fingerprint=hash_query(value.query),
            )
        )
        return HandlerSuccess(
            tool_declarations.NexusSearchSuccess(matches=[], total_candidates=0),
            actual_attempts=0,
        )
    try:
        response = await search_scopes_async(recorder.database, viewer_id, query, scopes)
    except ApiError as exc:
        _collapse_expected_unavailable(
            exc,
            allowed_codes=frozenset(
                {ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_CONVERSATION_NOT_FOUND}
            ),
        )

    def finish(_db: Session) -> HandlerSuccess[tool_declarations.NexusSearchSuccess]:
        citations = [
            citation_from_search_result(item, filters=filters) for item in response.results
        ]
        matches = [
            tool_declarations.NexusSearchMatch(
                evidence=_evidence(
                    context,
                    resource_uri=item.resource_ref,
                    material=item.model_dump(mode="json"),
                    citation=citation,
                ),
                excerpt=item.snippet[:300],
                kind=cast("Any", _kind_for_result_type(item.type)),
                score=min(1.0, max(0.0, float(item.score))),
                title=item.title[:150],
                uri=item.resource_ref,
            )
            for item, citation in zip(response.results, citations, strict=True)
        ]
        recorder.stage_audit(
            ToolAuditProjection(
                scope=",".join(requested_scopes) if requested_scopes else "conversation_context",
                requested_types=list(query.effective_result_types),
                filters=filters,
                citations=citations,
                selected_citations=_selected_nexus_search_citations(citations),
                search_query_fingerprint=hash_query(value.query),
            )
        )
        return HandlerSuccess(
            tool_declarations.NexusSearchSuccess(
                matches=matches,
                total_candidates=len(matches) + int(bool(response.page.has_more)),
            ),
            actual_attempts=0,
        )

    return await recorder.database.run_sync(finish)


async def _run_document_search(
    value: tool_declarations.DocumentSearchInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.DocumentSearchSuccess]:
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search.batch import search_scopes_async
    from nexus.services.search.query import SearchQuery, build_search_query
    from nexus.services.search.scope import scope_from_uri

    recorder = _nexus_recorder(context)

    def prepare(_db: Session) -> SearchQuery:
        with recorder.db.begin():
            _assert_visible(recorder, value.uri)
            return build_search_query(
                text=value.query,
                raw_kinds=["documents"],
                raw_formats=None,
                raw_authors=None,
                raw_roles=None,
                scope=scope_from_uri(value.uri),
                cursor=None,
                limit=value.limit or 8,
            )

    query = await recorder.database.run_sync(prepare)
    try:
        response = await search_scopes_async(
            recorder.database, recorder.principal_id, query, (query.scope,)
        )
    except ApiError as exc:
        _collapse_expected_unavailable(exc, allowed_codes=frozenset({ApiErrorCode.E_NOT_FOUND}))

    def finish(_db: Session) -> HandlerSuccess[tool_declarations.DocumentSearchSuccess]:
        citations = [
            citation_from_search_result(item, filters={"uri": value.uri, "query": value.query})
            for item in response.results
        ]
        matches = [
            tool_declarations.DocumentSearchMatch(
                evidence=_evidence(
                    context,
                    resource_uri=item.resource_ref,
                    material=item.model_dump(mode="json"),
                    citation=citation,
                ),
                ordinal=ordinal,
                score=min(1.0, max(0.0, float(item.score))),
                # The search owner marks matches with trusted <b> tags; tool JSON is plain.
                text=item.snippet.replace("<b>", "").replace("</b>", "")[:2000],
                title=item.title[:500],
                uri=item.resource_ref,
            )
            for ordinal, (item, citation) in enumerate(
                zip(response.results, citations, strict=True)
            )
        ]
        recorder.stage_audit(
            ToolAuditProjection(
                scope=value.uri,
                requested_types=list(query.effective_result_types),
                filters={"uri": value.uri},
                citations=citations,
            )
        )
        return HandlerSuccess(
            tool_declarations.DocumentSearchSuccess(matches=matches, uri=value.uri),
            actual_attempts=0,
        )

    return await recorder.database.run_sync(finish)


# The domain reader distinguishes storage-shaped body kinds more finely than the
# canonical tool contract; this exhaustive reviewed projection preserves their
# body semantics while keeping one closed model vocabulary.
_READ_KINDS: Mapping[str, str] = {
    "artifact": "artifact",
    "artifact_revision": "artifact",
    "content_chunk": "section",
    "conversation": "section",
    "evidence_span": "section",
    "full": "full",
    "message": "section",
    "note_block": "section",
    "oracle_passage_anchor": "section",
    "oracle_reading": "oracle_reading",
    "page": "section",
    "page_range": "page_range",
    "quote": "quote",
    "reader_apparatus_item": "section",
    "section": "section",
}


def _run_resource_read(
    value: tool_declarations.ResourceReadInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.ResourceReadSuccess]:
    from nexus.services.agent_tools.read_resource import ReadRefusal, execute_read_resource

    recorder = _nexus_recorder(context)
    _admitted_target(recorder, value.uri, allow_derived_read=True)
    result = execute_read_resource(recorder.db, viewer_id=recorder.principal_id, uri=value.uri)
    if isinstance(result, ReadRefusal):
        if result.code == "not_readable":
            _declared_failure(tool_declarations.Unreadable(type="Unreadable"))
        _resource_unavailable()
    if result.kind == "too_large":
        _declared_failure(tool_declarations.TooLarge(type="TooLarge"))
    kind = _READ_KINDS.get(result.kind)
    if kind is None:
        raise AssertionError(f"unmapped successful resource-read kind: {result.kind!r}")
    citation = _citation_for_ref(
        recorder,
        result_type=result.citation_result_type,
        source_id=result.citation_source_id or "",
        filters={"uri": value.uri},
    )
    recorder.stage_audit(
        ToolAuditProjection(
            scope="conversation_context",
            filters={"uri": value.uri},
            citations=[citation] if citation is not None else [],
        )
    )
    return HandlerSuccess(
        tool_declarations.ResourceReadSuccess(
            evidence=_evidence(
                context,
                resource_uri=value.uri,
                material={"kind": kind, "uri": value.uri},
                citation=citation,
                content=result.body,
            ),
            kind=cast("Any", kind),
            text=result.body,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


def _run_resource_inspect(
    value: tool_declarations.ResourceInspectInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.ResourceInspectSuccess]:
    from nexus.services.agent_tools.inspect_resource import InspectRefusal, execute_inspect_resource

    recorder = _nexus_recorder(context)
    ref = _admitted_target(recorder, value.uri)
    document_map = execute_inspect_resource(
        recorder.db, viewer_id=recorder.principal_id, uri=value.uri
    )
    if isinstance(document_map, InspectRefusal):
        if document_map.code == "not_inspectable":
            _declared_failure(tool_declarations.Uninspectable(type="Uninspectable"))
        _resource_unavailable()
    sections = [
        tool_declarations.ResourceInspectSection(
            fragment_id=section.fragment_id,
            label=section.label[:310],
            ordinal=section.ordinal,
            page_end=section.page_end,
            page_start=section.page_start,
            parent_label=section.parent_label[:310] if section.parent_label else None,
            preview=section.preview[:470],
            read_uri=section.read_uri,
            section_kind=cast("Any", section.section_kind),
            t_end_ms=section.t_end_ms,
            t_start_ms=section.t_start_ms,
        )
        for section in document_map.sections
    ]
    citation = _citation_for_ref(
        recorder,
        result_type={"podcast_episode": "episode", "video": "video"}.get(
            document_map.kind, "media"
        ),
        source_id=str(ref.id),
        filters={"uri": value.uri},
    )
    recorder.stage_audit(
        ToolAuditProjection(
            scope="conversation_context",
            filters={"uri": value.uri},
            citations=[citation] if citation is not None else [],
        )
    )
    return HandlerSuccess(
        tool_declarations.ResourceInspectSuccess(
            evidence=_evidence(
                context,
                resource_uri=value.uri,
                material={
                    "kind": document_map.kind,
                    "sections": [section.model_dump(mode="json") for section in sections],
                    "title": document_map.title,
                    "total_sections": document_map.total_sections,
                },
                citation=citation,
            ),
            media_kind=cast("Any", document_map.kind),
            sections=sections,
            title=document_map.title,
            total_sections=document_map.total_sections,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


def _run_relations_list(
    value: tool_declarations.RelationsListInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.RelationsListSuccess]:
    from nexus.services.assistant_write_authorship import machine_authorship_for_edge
    from nexus.services.resource_graph.connections import query_connections
    from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery
    from nexus.services.resource_items.capabilities import resource_citation_result_type

    recorder = _nexus_recorder(context)
    ref = _assert_visible(recorder, value.uri)
    page = query_connections(
        recorder.db,
        viewer_id=recorder.principal_id,
        query=ConnectionQuery(
            refs=(ref,),
            direction=value.direction,
            rollup="exact",
            filters=ConnectionFilters(
                kinds=tuple(value.kinds) if value.kinds is not None else None
            ),
            limit=value.limit or 100,
            cursor=None,
        ),
    )
    relations = [
        tool_declarations.RelationMatch(
            direction=item.direction,
            edge_id=item.edge_id,
            kind=item.kind,
            machine_authorship=machine_authorship_for_edge(
                recorder.db,
                viewer_id=recorder.principal_id,
                edge_id=item.edge_id,
            ),
            rationale=item.snapshot.excerpt[:150]
            if item.snapshot and item.snapshot.excerpt
            else None,
            source_label=item.source.label[:150] if item.source.label else None,
            source_uri=item.source_ref.uri,
            target_label=item.target.label[:150] if item.target.label else None,
            target_uri=item.target_ref.uri,
        )
        for item in page.items
    ]
    citation = _citation_for_ref(
        recorder,
        result_type=resource_citation_result_type(ref),
        source_id=str(ref.id),
        filters={"uri": value.uri},
    )
    recorder.stage_audit(
        ToolAuditProjection(
            scope="conversation_context",
            filters={"uri": value.uri},
            citations=[citation] if citation is not None else [],
        )
    )
    return HandlerSuccess(
        tool_declarations.RelationsListSuccess(
            evidence=_evidence(
                context,
                resource_uri=value.uri,
                material=[item.model_dump(mode="json") for item in relations],
                citation=citation,
            ),
            relations=relations,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


def _write_refusal(exc: BaseException, *, tool_id: str) -> Never:
    from nexus.services.agent_tools.writes import WriteToolRefusal

    if isinstance(exc, WriteToolRefusal):
        if exc.error_code == "invalid_arguments":
            raise BoundaryFailure("InvalidInput", actual_attempts=0) from exc
        error = {
            "library_not_found": tool_declarations.ResourceUnavailable(type="ResourceUnavailable"),
            "library_ambiguous": tool_declarations.TargetAmbiguous(type="TargetAmbiguous"),
            "quote_not_found": tool_declarations.QuoteNotFound(type="QuoteNotFound"),
            "quote_ambiguous": tool_declarations.QuoteAmbiguous(type="QuoteAmbiguous"),
        }.get(exc.error_code)
        if error is None:
            raise AssertionError(f"unmapped write refusal: {exc.error_code}") from exc
        _declared_failure(error)
    if isinstance(exc, ApiError):
        if (
            tool_id == "nexus.library.add"
            and exc.code
            in {
                ApiErrorCode.E_BILLING_REQUIRED,
                ApiErrorCode.E_MEDIA_DELETING,
                ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED,
            }
        ) or (
            tool_id == "nexus.queue.add"
            and exc.code in {ApiErrorCode.E_LIMIT, ApiErrorCode.E_MEDIA_DELETING}
        ):
            _resource_unavailable()
        if tool_id == "nexus.library.add" and exc.code is ApiErrorCode.E_PODCAST_REPLACES_EPISODES:
            _declared_failure(tool_declarations.TargetAmbiguous(type="TargetAmbiguous"))
        if tool_id == "nexus.highlight.create" and exc.code is ApiErrorCode.E_HIGHLIGHT_CONFLICT:
            _declared_failure(tool_declarations.Conflict(type="Conflict"))
        if tool_id == "nexus.edge.create" and exc.code is ApiErrorCode.E_INVALID_REQUEST:
            _declared_failure(tool_declarations.Conflict(type="Conflict"))
        if exc.code in {
            ApiErrorCode.E_NOT_FOUND,
            ApiErrorCode.E_LIBRARY_NOT_FOUND,
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            ApiErrorCode.E_FORBIDDEN,
            ApiErrorCode.E_LIBRARY_FORBIDDEN,
            ApiErrorCode.E_OWNER_REQUIRED,
            ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
        }:
            _resource_unavailable()
    raise exc


def _run_write(
    value: Any,
    context: ExecutionContext,
    *,
    tool_id: str,
) -> HandlerSuccess[Any]:
    from nexus.services.agent_tools import writes

    recorder = _nexus_recorder(context)
    write_cap = recorder.max_live_writes
    if write_cap is None:
        raise ExecutorConfigurationDefect("read-only tool plan reached a write handler")
    if context.effect_id is None:
        raise ExecutorConfigurationDefect("Nexus write lacks its stable effect id")
    effect_id = UUID(str(context.effect_id))
    viewer_id = recorder.principal_id
    for key in ("resource_uri", "page_uri", "media_uri", "source_uri", "target_uri"):
        uri = getattr(value, key, None)
        if isinstance(uri, str):
            _admitted_target(recorder, uri)
    # Linearize the generation, optional projection owner, and queue lease
    # immediately before the effect. The locks remain held until the domain
    # mutation and canonical terminal receipt commit together.
    recorder.authorize_effect_in_current_transaction(recorder.db)
    if recorder.live_write_count(recorder.db) >= write_cap:
        _declared_failure(tool_declarations.WriteCapReached(type="WriteCapReached"))
    try:
        with recorder.db.begin_nested():
            match tool_id:
                case "nexus.library.add":
                    effect = writes.add_to_library(recorder.db, viewer_id, value)
                case "nexus.note.create":
                    effect = writes.create_note(recorder.db, viewer_id, effect_id, value)
                case "nexus.highlight.create":
                    effect = writes.create_highlight(recorder.db, viewer_id, effect_id, value)
                case "nexus.edge.create":
                    effect = writes.create_assistant_edge(recorder.db, viewer_id, value)
                case "nexus.queue.add":
                    effect = writes.add_to_queue(recorder.db, viewer_id, value)
                case _:
                    raise ExecutorConfigurationDefect("unknown Nexus write tool")
    except (writes.WriteToolRefusal, ApiError) as exc:
        _write_refusal(exc, tool_id=tool_id)
    success_type = CHAT_TOOL_DECLARATIONS_BY_ID[tool_id].spec.success_type
    recorder.stage_audit(
        ToolAuditProjection(scope="assistant_write", created_refs=effect.created_refs)
    )
    return HandlerSuccess(success_type.model_validate(effect.output), actual_attempts=0)


_HANDLERS: Mapping[str, Any] = {
    "nexus.resource.read": _run_resource_read,
    "nexus.resource.inspect": _run_resource_inspect,
    "nexus.relations.list": _run_relations_list,
    "nexus.library.add": partial(_run_write, tool_id="nexus.library.add"),
    "nexus.note.create": partial(_run_write, tool_id="nexus.note.create"),
    "nexus.highlight.create": partial(_run_write, tool_id="nexus.highlight.create"),
    "nexus.edge.create": partial(_run_write, tool_id="nexus.edge.create"),
    "nexus.queue.add": partial(_run_write, tool_id="nexus.queue.add"),
}


__all__ = ["execute_nexus_tool"]
