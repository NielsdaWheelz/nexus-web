"""Provider-neutral public web-search tool execution for chat."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from web_search_tool.types import (
    WebSearchError,
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResultItem,
    WebSearchResultType,
)

from nexus.db.models import ResourceExternalSnapshot
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.schemas.conversation import MESSAGE_TOOL_STATUSES, ChatRunToolResultEventPayload
from nexus.schemas.retrieval import (
    ExternalSnapshotId,
    ExternalUrlLocator,
    ProviderResultRef,
    RetrievalContextRef,
    WebRetrievalResultRef,
    retrieval_context_ref_json,
    retrieval_locator_json,
)
from nexus.services.chat_run_citations import (
    CitationCandidateNumbering,
    number_tool_citation_candidates,
)
from nexus.services.retrieval_citation import RetrievalCitation, insert_retrieval_row

logger = get_logger(__name__)

WEB_SEARCH_TOOL_NAME = "web_search"
WEB_SEARCH_LIMIT = 6
WEB_SEARCH_SELECTED_LIMIT = 5
WEB_SEARCH_CONTEXT_CHARS = 12000
# Mirror the web_search_tool.WebSearchRequest contract at our own boundary so an
# out-of-range query is rejected as a typed WebSearchQueryError (one owner: see
# normalize_web_search_query) before WebSearchRequest.__post_init__ can raise a bare
# ValueError. Keep these in lockstep with the provider package's limits.
WEB_SEARCH_QUERY_MIN_CHARS = 2
WEB_SEARCH_QUERY_MAX_CHARS = 400
WEB_SEARCH_QUERY_MAX_WORDS = 50


class WebSearchQueryError(ValueError):
    """The submitted web-search request is not a usable request.

    Raised by :func:`normalize_web_search_query` when an untrusted query (an HTTP
    request param or LLM-generated tool argument) is empty, too short, too long, or
    has too many words, and by :func:`search_web_readonly` when ``freshness_days``
    is below 1. This is an expected boundary failure for bad external input,
    distinct from the provider-transport :class:`WebSearchError`; each caller maps it
    to its own surface (HTTP 400 at the route, an ``invalid_request`` tool status in
    chat).
    """


def normalize_web_search_query(query: str) -> str:
    """Collapse whitespace and validate a web-search query into one canonical form.

    The single owner of query validity for both callers of
    :func:`search_web_readonly` (the read-only route and the chat tool). Returns the
    whitespace-collapsed query when it satisfies the length/word bounds the provider
    package enforces; raises :class:`WebSearchQueryError` otherwise so neither caller
    lets ``WebSearchRequest.__post_init__`` raise a bare ``ValueError``.
    """
    normalized = " ".join(query.split())
    if len(normalized) < WEB_SEARCH_QUERY_MIN_CHARS:
        raise WebSearchQueryError("Web search query is too short")
    if len(normalized) > WEB_SEARCH_QUERY_MAX_CHARS:
        raise WebSearchQueryError("Web search query is too long")
    if len(normalized.split()) > WEB_SEARCH_QUERY_MAX_WORDS:
        raise WebSearchQueryError("Web search query has too many words")
    return normalized


WEB_SEARCH_TOOL_DEFINITION: dict[str, Any] = {
    "name": WEB_SEARCH_TOOL_NAME,
    "description": "Search the open public web for current or non-saved information.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "freshness_days": {
                "anyOf": [{"type": "integer"}, {"type": "null"}],
                "description": (
                    "Limit results to the last N days (minimum 1). Use null for no limit."
                ),
            },
        },
        "required": ["query", "freshness_days"],
        "additionalProperties": False,
    },
}


@dataclass(slots=True)
class WebSearchCitation:
    """Provider-boundary citation whose result ref is not a Nexus identity."""

    result_ref: ProviderResultRef
    title: str
    url: str
    display_url: str
    snippet: str
    extra_snippets: tuple[str, ...]
    published_at: str | None
    source_name: str | None
    rank: int
    provider: str
    provider_request_id: str | None
    selected: bool = False

    def locator_json(self) -> dict[str, Any]:
        locator = retrieval_locator_json(
            {
                "type": "external_url",
                "url": self.url,
                "title": self.title,
                "display_url": self.display_url,
            }
        )
        if locator is None:
            raise ValueError("web search citation is missing external_url locator")
        return locator


@dataclass(frozen=True, slots=True)
class PersistedWebSearchCitation:
    """Canonical web citation after Nexus has minted its resource identity."""

    external_snapshot_id: ExternalSnapshotId
    provider_result_ref: ProviderResultRef
    title: str
    url: str
    display_url: str
    snippet: str
    extra_snippets: tuple[str, ...]
    published_at: str | None
    source_name: str | None
    rank: int
    provider: str
    provider_request_id: str | None
    selected: bool

    @classmethod
    def from_provider_citation(
        cls,
        citation: WebSearchCitation,
        *,
        external_snapshot_id: ExternalSnapshotId,
        selected: bool,
    ) -> PersistedWebSearchCitation:
        return cls(
            external_snapshot_id=external_snapshot_id,
            provider_result_ref=citation.result_ref,
            title=citation.title,
            url=citation.url,
            display_url=citation.display_url,
            snippet=citation.snippet,
            extra_snippets=citation.extra_snippets,
            published_at=citation.published_at,
            source_name=citation.source_name,
            rank=citation.rank,
            provider=citation.provider,
            provider_request_id=citation.provider_request_id,
            selected=selected,
        )

    def locator_json(self) -> dict[str, Any]:
        locator = retrieval_locator_json(
            {
                "type": "external_url",
                "url": self.url,
                "title": self.title,
                "display_url": self.display_url,
            }
        )
        if locator is None:
            raise AssertionError("persisted web citation is missing external_url locator")
        return locator

    def retrieval_result_ref(self) -> WebRetrievalResultRef:
        """Build the sole identity-bearing wire/ledger representation."""
        snapshot_id = self.external_snapshot_id
        return WebRetrievalResultRef(
            type="web_result",
            id=snapshot_id,
            result_type="web_result",
            result_ref=self.provider_result_ref,
            source_id=snapshot_id,
            title=self.title,
            url=self.url,
            display_url=self.display_url,
            deep_link=self.url,
            citation_target=f"external_snapshot:{snapshot_id}",
            locator=ExternalUrlLocator.model_validate(self.locator_json()),
            snippet=self.snippet,
            extra_snippets=list(self.extra_snippets),
            published_at=self.published_at,
            source_name=self.source_name,
            rank=self.rank,
            provider=self.provider,
            provider_request_id=self.provider_request_id,
            context_ref=RetrievalContextRef(type="web_result", id=snapshot_id),
            media_id=None,
            media_kind=None,
            score=1.0 / max(self.rank, 1),
            selected=self.selected,
        )

    def retrieval_result_ref_json(self) -> dict[str, Any]:
        return self.retrieval_result_ref().model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        )


@dataclass(slots=True)
class WebSearchRun:
    """Executed public web-search tool call."""

    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    query_hash: str | None
    result_type: str
    requested_freshness_days: int | None
    requested_domains: dict[str, list[str]]
    citations: list[WebSearchCitation]
    selected_citations: list[WebSearchCitation]
    latency_ms: int
    status: MESSAGE_TOOL_STATUSES
    error_code: str | None = None
    provider_request_ids: list[str] = field(default_factory=list)
    empty_status: str | None = None
    tool_call_index: int = 0


@dataclass(frozen=True, slots=True)
class PersistedWebSearchResult:
    """Canonical caller-owned result of persisting one web-search tool step."""

    tool_call_id: UUID
    citations: tuple[PersistedWebSearchCitation, ...]
    selected_citations: tuple[PersistedWebSearchCitation, ...]
    next_citation_ordinal: int
    model_output: str
    result_event: ChatRunToolResultEventPayload

    @property
    def status(self) -> str:
        return self.result_event.status

    @property
    def error_code(self) -> str | None:
        return self.result_event.error_code


def _citation_from_result(result: WebSearchResultItem) -> WebSearchCitation:
    return WebSearchCitation(
        result_ref=ProviderResultRef(result.result_ref),
        title=result.title,
        url=result.url,
        display_url=result.display_url,
        snippet=result.snippet,
        extra_snippets=result.extra_snippets,
        published_at=result.published_at,
        source_name=result.source_name,
        rank=result.rank,
        provider=result.provider,
        provider_request_id=result.provider_request_id,
    )


@dataclass(frozen=True, slots=True)
class WebSearchReadResult:
    """Read-only result of a public web search.

    Carries the projected citations, the whitespace-collapsed canonical query the
    provider actually saw (so callers hash/log the validated form, never re-derive
    it), and the response-level provider request id — the telemetry handle the
    provider stamps on the response envelope, which survives a zero-result response
    and may differ from any item-level id.
    """

    citations: list[WebSearchCitation]
    query: str
    provider_request_id: str | None


async def search_web_readonly(
    provider: WebSearchProvider, query: str, *, freshness_days: int | None
) -> WebSearchReadResult:
    """Run a public web search and project results to citations, with no persistence.

    Shared read-only core of the chat ``web_search`` tool. ``query`` is normalized
    and validated by :func:`normalize_web_search_query` (the one query-validity
    owner), so an out-of-range query raises :class:`WebSearchQueryError` rather than
    a bare ``ValueError`` from the provider request. The returned
    :class:`WebSearchReadResult` preserves the response-level provider request id so
    callers never reconstruct it from an item. Callers that need the persisted
    tool/retrieval ledger use :func:`execute_web_search`. ``WebSearchError`` (provider
    transport) propagates to the caller's boundary.
    """
    normalized_query = normalize_web_search_query(query)
    # Domain validation for the freshness bound the tool schema used to declare as
    # "minimum": 1 (the canonical JSON-Schema subset forbids range keywords). Mirrors
    # WebSearchRequest.__post_init__'s `freshness_days < 1` rejection so an
    # out-of-range value fails as a typed boundary error, never a bare ValueError.
    if freshness_days is not None and freshness_days < 1:
        raise WebSearchQueryError("Web search freshness_days must be at least 1")
    response = await provider.search(
        WebSearchRequest(
            query=normalized_query,
            result_type=WebSearchResultType.MIXED,
            limit=WEB_SEARCH_LIMIT,
            freshness_days=freshness_days,
        )
    )
    return WebSearchReadResult(
        citations=[_citation_from_result(result) for result in response.results],
        query=normalized_query,
        provider_request_id=response.provider_request_id,
    )


def render_web_context_blocks(
    citations: list[WebSearchCitation],
) -> tuple[str, int, list[WebSearchCitation]]:
    """Render selected web results into bounded prompt context blocks."""

    rendered_blocks: list[str] = []
    selected: list[WebSearchCitation] = []
    total_chars = 0

    for citation in citations[:WEB_SEARCH_SELECTED_LIMIT]:
        block = _render_single_web_context(citation)
        block_chars = len(block)
        if total_chars + block_chars > WEB_SEARCH_CONTEXT_CHARS:
            break
        citation.selected = True
        selected.append(citation)
        rendered_blocks.append(block)
        total_chars += block_chars

    if not rendered_blocks:
        return "", 0, selected
    return "\n\n".join(rendered_blocks), total_chars, selected


def _render_single_web_context(citation: WebSearchCitation) -> str:
    lines = [
        f'<web_search_result ref="{xml_escape(citation.result_ref)}">',
        f"<title>{xml_escape(citation.title)}</title>",
        f"<url>{xml_escape(citation.url)}</url>",
    ]
    if citation.source_name:
        lines.append(f"<source>{xml_escape(citation.source_name)}</source>")
    if citation.published_at:
        lines.append(f"<published_at>{xml_escape(citation.published_at)}</published_at>")
    if citation.snippet:
        lines.append(f"<excerpt>{xml_escape(citation.snippet)}</excerpt>")
    for snippet in citation.extra_snippets:
        lines.append(f"<excerpt>{xml_escape(snippet)}</excerpt>")
    lines.append("</web_search_result>")
    return "\n".join(lines)


def _web_search_model_output(
    run: WebSearchRun,
    selected_citations: tuple[PersistedWebSearchCitation, ...],
    numbering: CitationCandidateNumbering,
) -> str:
    results: list[dict[str, object]] = []
    for citation, numbered in zip(selected_citations, numbering.rows, strict=True):
        item: dict[str, object] = {
            "title": citation.title,
            "url": citation.url,
            "snippet": citation.snippet,
            "source": citation.source_name,
            "published_at": citation.published_at,
        }
        if numbered.candidate_ordinal is not None:
            item["n"] = numbered.candidate_ordinal
        results.append(item)
    return json.dumps(
        {
            "results": results,
            "total_candidates": len(run.citations),
            "status": run.status,
            "error_code": run.error_code,
        }
    )


def persist_web_search_run(
    db: Session,
    run: WebSearchRun,
    *,
    start_citation_ordinal: int,
) -> PersistedWebSearchResult:
    """Persist and number a web-search result without committing its transaction.

    The provider refs on ``run`` remain provider telemetry. This function mints
    application-owned snapshot UUIDs, builds every identity-bearing payload from
    those UUIDs, and leaves snapshots, tool/retrieval rows, candidate numbering,
    and the returned strict event pending for the durable-step caller to publish
    and commit atomically. The insert is intentionally not an upsert: replay reads
    the journal's completed result instead of minting replacement identities.
    """
    owner_user_id = db.scalar(
        text("SELECT owner_user_id FROM conversations WHERE id = :conversation_id"),
        {"conversation_id": run.conversation_id},
    )
    if owner_user_id is None:
        raise ValueError("web_search conversation is missing")

    citation_object_ids = {id(citation) for citation in run.citations}
    selected_object_ids = {id(citation) for citation in run.selected_citations}
    if not selected_object_ids <= citation_object_ids:
        raise AssertionError("selected web citations must come from the provider citation list")
    for citation in run.citations:
        if citation.selected != (id(citation) in selected_object_ids):
            raise AssertionError("web citation selected flag disagrees with selected citations")

    persisted_citations: list[PersistedWebSearchCitation] = []
    for citation in run.citations:
        persisted_citation = PersistedWebSearchCitation.from_provider_citation(
            citation,
            external_snapshot_id=ExternalSnapshotId(new_uuid7()),
            selected=id(citation) in selected_object_ids,
        )
        persisted_citations.append(persisted_citation)
        snapshot = ResourceExternalSnapshot(
            id=persisted_citation.external_snapshot_id,
            user_id=owner_user_id,
            provider=citation.provider,
            url=citation.url,
            title=citation.title,
            snippet=citation.snippet,
            source_snapshot=persisted_citation.retrieval_result_ref_json(),
        )
        db.add(snapshot)
    db.flush()

    persisted_citations_tuple = tuple(persisted_citations)
    selected_citations = tuple(citation for citation in persisted_citations if citation.selected)
    result_ref_models = tuple(
        citation.retrieval_result_ref() for citation in persisted_citations_tuple
    )
    result_refs = [
        result_ref.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
        for result_ref in result_ref_models
    ]

    selected_context_refs = [
        retrieval_context_ref_json(
            {
                "type": "web_result",
                "id": citation.external_snapshot_id,
            }
        )
        for citation in selected_citations
    ]
    requested_types = [run.result_type]

    insert_tool = text(
        """
        INSERT INTO message_tool_calls (
            conversation_id,
            user_message_id,
            assistant_message_id,
            tool_name,
            tool_call_index,
            query_hash,
            scope,
            requested_types,
            result_refs,
            selected_context_refs,
            provider_request_ids,
            latency_ms,
            status,
            error_code
        )
        VALUES (
            :conversation_id,
            :user_message_id,
            :assistant_message_id,
            :tool_name,
            :tool_call_index,
            :query_hash,
            'public_web',
            :requested_types,
            :result_refs,
            :selected_context_refs,
            :provider_request_ids,
            :latency_ms,
            :status,
            :error_code
        )
        RETURNING id
        """
    ).bindparams(
        bindparam("requested_types", type_=JSONB),
        bindparam("result_refs", type_=JSONB),
        bindparam("selected_context_refs", type_=JSONB),
        bindparam("provider_request_ids", type_=JSONB),
    )
    tool_call_id = db.execute(
        insert_tool,
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": run.tool_call_index,
            "query_hash": run.query_hash,
            "requested_types": requested_types,
            "result_refs": result_refs,
            "selected_context_refs": selected_context_refs,
            "provider_request_ids": run.provider_request_ids,
            "latency_ms": run.latency_ms,
            "status": run.status,
            "error_code": run.error_code,
        },
    ).scalar_one()

    for ordinal, citation in enumerate(persisted_citations_tuple):
        selected = citation.selected
        score = 1.0 / max(citation.rank, 1)
        source_id = str(citation.external_snapshot_id)
        locator = citation.locator_json()
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=RetrievalCitation(
                result_type="web_result",
                source_id=source_id,
                title=citation.title,
                source_label=None,
                snippet=citation.snippet,
                deep_link=citation.url,
                citation_target=f"external_snapshot:{source_id}",
                citation_label=None,
                locator=locator,
                context_ref={"type": "web_result", "id": source_id},
                evidence_span_id=None,
                media_id=None,
                media_kind=None,
                score=score,
                result_ref=citation.retrieval_result_ref_json(),
                selected=selected,
            ),
            selected=selected,
            scope="public_web",
            retrieval_status="web_result",
        )
    numbering = number_tool_citation_candidates(
        db,
        tool_call_id=tool_call_id,
        start_ordinal=start_citation_ordinal,
    )
    model_output = _web_search_model_output(run, selected_citations, numbering)
    result_event = ChatRunToolResultEventPayload(
        tool_call_id=tool_call_id,
        assistant_message_id=run.assistant_message_id,
        tool_name=WEB_SEARCH_TOOL_NAME,
        tool_call_index=run.tool_call_index,
        status=run.status,
        scope="public_web",
        types=requested_types,
        filters={
            "freshness_days": run.requested_freshness_days,
            "allowed_domains": run.requested_domains.get("allowed", []),
            "blocked_domains": run.requested_domains.get("blocked", []),
        },
        error_code=run.error_code,
        result_count=len(persisted_citations_tuple),
        selected_count=len(selected_citations),
        latency_ms=run.latency_ms,
        provider_request_ids=run.provider_request_ids,
        results=list(result_ref_models),
    )
    return PersistedWebSearchResult(
        tool_call_id=tool_call_id,
        citations=persisted_citations_tuple,
        selected_citations=selected_citations,
        next_citation_ordinal=numbering.next_ordinal,
        model_output=model_output,
        result_event=result_event,
    )


async def execute_web_search(
    *,
    provider: WebSearchProvider,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    query: str,
    freshness_days: int | None,
    tool_call_index: int,
) -> WebSearchRun:
    """Run a public web search and return its unpersisted provider result."""
    start = time.monotonic()
    status = "complete"
    error_code: str | None = None
    normalized_query: str | None = None
    citations: list[WebSearchCitation] = []
    selected: list[WebSearchCitation] = []
    provider_request_ids: list[str] = []

    try:
        result = await search_web_readonly(provider, query, freshness_days=freshness_days)
        normalized_query = result.query
        citations = result.citations
        if result.provider_request_id:
            provider_request_ids = [result.provider_request_id]
        _, _, selected = render_web_context_blocks(citations)
    except WebSearchQueryError as exc:
        logger.warning("agent_web_search_invalid_query", reason=str(exc))
        status = "error"
        error_code = "invalid_request"
    except WebSearchError as exc:
        logger.warning(
            "agent_web_search_error",
            provider=exc.provider,
            code=exc.code.value,
            status_code=exc.status_code,
        )
        status = "error"
        error_code = exc.code.value

    latency_ms = int((time.monotonic() - start) * 1000)
    return WebSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash=(
            hashlib.sha256(normalized_query.encode("utf-8")).hexdigest()
            if normalized_query
            else None
        ),
        result_type="mixed",
        requested_freshness_days=freshness_days,
        requested_domains={"allowed": [], "blocked": []},
        citations=citations,
        selected_citations=selected,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        provider_request_ids=provider_request_ids,
        tool_call_index=tool_call_index,
    )
