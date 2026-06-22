"""Provider-neutral public web-search tool execution for chat."""

from __future__ import annotations

import hashlib
import time
from collections import Counter
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
from nexus.logging import get_logger
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.services.chat_tool_source_policy import load_started_tool_source_policy
from nexus.services.retrieval_citation import RetrievalCitation, insert_retrieval_row

logger = get_logger(__name__)

WEB_SEARCH_TOOL_NAME = "web_search"
WEB_SEARCH_LIMIT = 6
WEB_SEARCH_SELECTED_LIMIT = 5
WEB_SEARCH_CONTEXT_CHARS = 12000
WEB_SEARCH_RERANK_STRATEGY = "provider_rank_then_context_budget"
WEB_SEARCH_RERANK_VERSION = "v1"
# Mirror the web_search_tool.WebSearchRequest contract at our own boundary so an
# out-of-range query is rejected as a typed WebSearchQueryError (one owner: see
# normalize_web_search_query) before WebSearchRequest.__post_init__ can raise a bare
# ValueError. Keep these in lockstep with the provider package's limits.
WEB_SEARCH_QUERY_MIN_CHARS = 2
WEB_SEARCH_QUERY_MAX_CHARS = 400
WEB_SEARCH_QUERY_MAX_WORDS = 50


class WebSearchQueryError(ValueError):
    """The submitted web-search query is not a usable query.

    Raised by :func:`normalize_web_search_query` when an untrusted query (an HTTP
    request param or LLM-generated tool argument) is empty, too short, too long, or
    has too many words. This is an expected boundary failure for bad external input,
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


def normalize_web_search_freshness_days(freshness_days: int | None) -> int | None:
    if freshness_days is None:
        return None
    if isinstance(freshness_days, bool) or freshness_days < 1:
        raise WebSearchQueryError("Web search freshness_days must be positive")
    return freshness_days


WEB_SEARCH_TOOL_DEFINITION: dict[str, Any] = {
    "name": WEB_SEARCH_TOOL_NAME,
    "description": "Search the open public web for current or non-saved information.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "freshness_days": {
                "type": "integer",
                "description": "Limit results to the last N days. Omit for no limit.",
                "nullable": True,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}


@dataclass(slots=True)
class WebSearchCitation:
    """Compact model/frontend citation for a public web result."""

    result_ref: str
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
    snapshot_source_id: str | None = None

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

    def to_json(self, *, source_id: str | None = None) -> dict[str, Any]:
        source_id = source_id or self.snapshot_source_id or self.result_ref
        return {
            "type": "web_result",
            "id": source_id,
            "result_type": "web_result",
            "result_ref": self.result_ref,
            "source_id": source_id,
            "title": self.title,
            "url": self.url,
            "display_url": self.display_url,
            "deep_link": self.url,
            "citation_target": f"external_snapshot:{source_id}",
            "locator": self.locator_json(),
            "snippet": self.snippet,
            "extra_snippets": list(self.extra_snippets),
            "published_at": self.published_at,
            "source_name": self.source_name,
            "rank": self.rank,
            "provider": self.provider,
            "provider_request_id": self.provider_request_id,
            "context_ref": {"type": "web_result", "id": source_id},
            "media_id": None,
            "media_kind": None,
            "score": 1.0 / max(self.rank, 1),
            "selected": self.selected,
        }


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
    context_text: str
    context_chars: int
    latency_ms: int
    status: str
    source_domain: str = "public_web"
    source_policy: dict[str, object] = field(default_factory=dict)
    error_code: str | None = None
    provider_request_ids: list[str] = field(default_factory=list)
    selection_reasons: list[str] = field(default_factory=list)
    empty_status: str | None = None
    tool_call_id: UUID | None = None
    tool_call_index: int = 0
    retrieval_ids: list[str] = field(default_factory=list)

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "running",
            "scope": "public_web",
            "types": [self.result_type],
            "filters": {
                "freshness_days": self.requested_freshness_days,
                "allowed_domains": self.requested_domains.get("allowed", []),
                "blocked_domains": self.requested_domains.get("blocked", []),
            },
            "source_domain": self.source_domain,
            "source_policy": dict(self.source_policy),
        }

    def retrieval_result_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": self.status,
            "error_code": self.error_code,
            "result_count": len(self.citations),
            "selected_count": len(self.selected_citations),
            "more_candidates_available": len(self.citations) > len(self.selected_citations),
            "latency_ms": self.latency_ms,
            "provider_request_ids": self.provider_request_ids,
            "filters": {
                "freshness_days": self.requested_freshness_days,
                "allowed_domains": self.requested_domains.get("allowed", []),
                "blocked_domains": self.requested_domains.get("blocked", []),
            },
            "results": [citation.to_json() for citation in self.citations],
            "retrieval_ids": self.retrieval_ids,
            "source_domain": self.source_domain,
            "source_policy": dict(self.source_policy),
        }


def _citation_from_result(result: WebSearchResultItem) -> WebSearchCitation:
    return WebSearchCitation(
        result_ref=result.result_ref,
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
    normalized_freshness_days = normalize_web_search_freshness_days(freshness_days)
    response = await provider.search(
        WebSearchRequest(
            query=normalized_query,
            result_type=WebSearchResultType.MIXED,
            limit=WEB_SEARCH_LIMIT,
            freshness_days=normalized_freshness_days,
        )
    )
    return WebSearchReadResult(
        citations=[_citation_from_result(result) for result in response.results],
        query=normalized_query,
        provider_request_id=response.provider_request_id,
    )


def render_web_context_blocks(
    citations: list[WebSearchCitation],
) -> tuple[str, int, list[WebSearchCitation], list[str]]:
    """Render selected web results into bounded prompt context blocks."""

    rendered_blocks: list[str] = []
    selected: list[WebSearchCitation] = []
    selection_reasons: list[str] = []
    total_chars = 0

    for citation in citations:
        if len(selected) >= WEB_SEARCH_SELECTED_LIMIT:
            selection_reasons.append("skipped_selected_limit")
            continue
        block = _render_single_web_context(citation)
        added_chars = len(block) + (2 if rendered_blocks else 0)
        if total_chars + added_chars > WEB_SEARCH_CONTEXT_CHARS:
            selection_reasons.append("skipped_over_budget")
            continue
        citation.selected = True
        selected.append(citation)
        rendered_blocks.append(block)
        total_chars += added_chars
        selection_reasons.append("selected_within_budget")

    if not rendered_blocks:
        return "", 0, selected, selection_reasons
    context_text = "\n\n".join(rendered_blocks)
    return context_text, len(context_text), selected, selection_reasons


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


def persist_web_search_run(db: Session, run: WebSearchRun) -> None:
    """Persist the web-search tool call and retrieval rows."""
    tool_call_id, run.source_domain, run.source_policy = load_started_tool_source_policy(
        db,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=run.tool_call_index,
        tool_name=WEB_SEARCH_TOOL_NAME,
    )
    owner_user_id = db.scalar(
        text("SELECT owner_user_id FROM conversations WHERE id = :conversation_id"),
        {"conversation_id": run.conversation_id},
    )
    if owner_user_id is None:
        raise ValueError("web_search conversation is missing")
    if len(run.selection_reasons) != len(run.citations):
        raise AssertionError("web_search selection reasons must match citations")
    snapshot_ids: dict[str, str] = {}
    for citation in run.citations:
        snapshot = ResourceExternalSnapshot(
            user_id=owner_user_id,
            provider=citation.provider,
            url=citation.url,
            title=citation.title,
            snippet=citation.snippet,
            source_snapshot=citation.to_json(),
        )
        db.add(snapshot)
        db.flush()
        source_id = str(snapshot.id)
        citation.snapshot_source_id = source_id
        snapshot.source_snapshot = citation.to_json(source_id=source_id)
        snapshot_ids[citation.result_ref] = source_id

    selected_context_refs = [
        retrieval_context_ref_json(
            {
                "type": "web_result",
                "id": snapshot_ids[citation.result_ref],
            }
        )
        for citation in run.selected_citations
    ]
    result_refs = [
        retrieval_result_ref_json(citation.to_json(source_id=snapshot_ids[citation.result_ref]))
        for citation in run.citations
    ]
    requested_types = [run.result_type]

    updated = db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET query_hash = :query_hash,
                scope = 'public_web',
                requested_types = :requested_types,
                result_refs = :result_refs,
                selected_context_refs = :selected_context_refs,
                provider_request_ids = :provider_request_ids,
                latency_ms = :latency_ms,
                status = :status,
                error_code = :error_code,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ).bindparams(
            bindparam("requested_types", type_=JSONB),
            bindparam("result_refs", type_=JSONB),
            bindparam("selected_context_refs", type_=JSONB),
            bindparam("provider_request_ids", type_=JSONB),
        ),
        {
            "tool_call_id": tool_call_id,
            "query_hash": run.query_hash,
            "requested_types": requested_types,
            "result_refs": result_refs,
            "selected_context_refs": selected_context_refs,
            "provider_request_ids": run.provider_request_ids,
            "latency_ms": run.latency_ms,
            "status": run.status,
            "error_code": run.error_code,
        },
    )
    if getattr(updated, "rowcount", None) != 1:
        raise AssertionError("web_search tool call update must affect one row")
    run.tool_call_id = tool_call_id
    from nexus.services.chat_runs import prune_tool_call_retrievals

    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    run.retrieval_ids = []

    insert_candidate_ledger = text(
        """
        INSERT INTO message_retrieval_candidate_ledgers (
            tool_call_id,
            retrieval_id,
            ordinal,
            result_type,
            source_id,
            score,
            selected,
            included_in_prompt,
            selection_status,
            selection_reason,
            result_ref,
            locator
        )
        VALUES (
            :tool_call_id,
            :retrieval_id,
            :ordinal,
            :result_type,
            :source_id,
            :score,
            :selected,
            :included_in_prompt,
            :selection_status,
            :selection_reason,
            :result_ref,
            :locator
        )
        """
    ).bindparams(
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    selected_refs = {citation.result_ref for citation in run.selected_citations}
    candidate_rerank_trace: list[dict[str, Any]] = []
    persisted_count = 0
    for ordinal, citation in enumerate(run.citations):
        selected = citation.result_ref in selected_refs
        selection_reason = run.selection_reasons[ordinal]
        selection_status = "web_result" if selected else "excluded_by_budget"
        score = 1.0 / max(citation.rank, 1)
        source_id = snapshot_ids[citation.result_ref]
        result_ref = retrieval_result_ref_json(citation.to_json(source_id=source_id))
        locator = citation.locator_json()
        candidate_rerank_trace.append(
            {
                "from": ordinal,
                "to": ordinal,
                "result_type": "web_result",
                "source_id": source_id,
                "source": citation.source_name or citation.display_url or citation.url,
                "rank": citation.rank,
                "score": score,
                "selection_score": score,
                "reason": "provider_rank",
                "selected": selected,
                "included_in_prompt": selected,
                "selection_status": selection_status,
                "selection_reason": selection_reason,
            }
        )
        retrieval_id = insert_retrieval_row(
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
                result_ref=citation.to_json(source_id=source_id),
                selected=selected,
            ),
            selected=selected,
            included_in_prompt=selected,
            scope="public_web",
            retrieval_status="web_result",
        )
        run.retrieval_ids.append(str(retrieval_id))
        db.execute(
            insert_candidate_ledger,
            {
                "tool_call_id": tool_call_id,
                "retrieval_id": retrieval_id,
                "ordinal": ordinal,
                "result_type": "web_result",
                "source_id": source_id,
                "score": score,
                "selected": selected,
                "included_in_prompt": selected,
                "selection_status": selection_status,
                "selection_reason": selection_reason,
                "result_ref": result_ref,
                "locator": locator,
            },
        )
        persisted_count = ordinal + 1
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id, min_ordinal=persisted_count)
    db.execute(
        text(
            """
            INSERT INTO message_rerank_ledgers (
                tool_call_id,
                strategy,
                input_count,
                selected_count,
                budget_chars,
                selected_chars,
                status,
                metadata
            )
            VALUES (
                :tool_call_id,
                :strategy,
                :input_count,
                :selected_count,
                :budget_chars,
                :selected_chars,
                :status,
                :metadata
            )
            """
        ).bindparams(bindparam("metadata", type_=JSONB)),
        {
            "tool_call_id": tool_call_id,
            "strategy": WEB_SEARCH_RERANK_STRATEGY,
            "input_count": len(run.citations),
            "selected_count": len(run.selected_citations),
            "budget_chars": WEB_SEARCH_CONTEXT_CHARS,
            "selected_chars": run.context_chars,
            "status": run.status,
            "metadata": {
                "selection_strategy": WEB_SEARCH_RERANK_STRATEGY,
                "selection_policy_version": WEB_SEARCH_RERANK_VERSION,
                "ordering_policy": "provider_rank",
                "diversity_policy": "provider_rank",
                "budget_policy": "greedy_context_budget",
                "candidate_limit": WEB_SEARCH_LIMIT,
                "selected_limit": WEB_SEARCH_SELECTED_LIMIT,
                "context_budget_chars": WEB_SEARCH_CONTEXT_CHARS,
                "query_class": "public_web_search",
                "retrieval_mode": "provider",
                "policy_reason": "web_search_tool",
                "scope": "public_web",
                "result_type": run.result_type,
                "provider_request_ids": run.provider_request_ids,
                "selection_reason_counts": dict(Counter(run.selection_reasons)),
                "candidate_rerank_trace": candidate_rerank_trace,
            },
        },
    )
    db.commit()


async def execute_web_search(
    db: Session,
    *,
    provider: WebSearchProvider,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    query: str,
    freshness_days: int | None,
    tool_call_index: int,
) -> WebSearchRun:
    """Run a public web search and persist tool/retrieval metadata."""
    start = time.monotonic()
    status = "complete"
    error_code: str | None = None
    normalized_query: str | None = None
    citations: list[WebSearchCitation] = []
    selected: list[WebSearchCitation] = []
    selection_reasons: list[str] = []
    context_text = ""
    context_chars = 0
    provider_request_ids: list[str] = []

    try:
        result = await search_web_readonly(provider, query, freshness_days=freshness_days)
        normalized_query = result.query
        citations = result.citations
        if result.provider_request_id:
            provider_request_ids = [result.provider_request_id]
        context_text, context_chars, selected, selection_reasons = render_web_context_blocks(
            citations
        )
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
    run = WebSearchRun(
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
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        provider_request_ids=provider_request_ids,
        selection_reasons=selection_reasons,
        tool_call_index=tool_call_index,
    )
    persist_web_search_run(db, run)
    return run
