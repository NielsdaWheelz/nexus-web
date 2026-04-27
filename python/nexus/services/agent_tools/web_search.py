"""Provider-neutral public web-search tool execution for chat."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from web_search_tool.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResultItem,
    WebSearchResultType,
)

from nexus.logging import get_logger
from nexus.schemas.conversation import WebSearchOptions
from nexus.services.search import hash_query

logger = get_logger(__name__)

WEB_SEARCH_TOOL_NAME = "web_search"
WEB_SEARCH_TOOL_CALL_INDEX = 1
WEB_SEARCH_LIMIT = 6
WEB_SEARCH_SELECTED_LIMIT = 5
WEB_SEARCH_CONTEXT_CHARS = 12000
WEB_SEARCH_QUERY_MAX_CHARS = 400

_SHORT_NON_SEARCH_MESSAGES = {
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
}

_WEB_SEARCH_CUE_TERMS = (
    "latest",
    "current",
    "today",
    "yesterday",
    "tomorrow",
    "recent",
    "news",
    "price",
    "pricing",
    "release",
    "changelog",
    "docs",
    "documentation",
    "source",
    "sources",
    "cite",
    "citation",
    "verify",
    "look up",
    "lookup",
    "web",
    "internet",
    "search the web",
    "find online",
    "user feedback",
    "reddit",
    "hacker news",
    "hn",
    "api",
    "law",
    "legal",
    "regulation",
    "standard",
)


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

    def to_json(self) -> dict[str, Any]:
        return {
            "result_type": "web_result",
            "result_ref": self.result_ref,
            "source_id": self.result_ref,
            "title": self.title,
            "url": self.url,
            "display_url": self.display_url,
            "snippet": self.snippet,
            "extra_snippets": list(self.extra_snippets),
            "published_at": self.published_at,
            "source_name": self.source_name,
            "rank": self.rank,
            "provider": self.provider,
            "provider_request_id": self.provider_request_id,
            "selected": self.selected,
        }

    def citation_event(self, assistant_message_id: UUID, tool_call_index: int) -> dict[str, Any]:
        return {
            "assistant_message_id": str(assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": tool_call_index,
            "title": self.title,
            "url": self.url,
            "display_url": self.display_url,
            "source_name": self.source_name,
            "snippet": self.snippet,
            "provider": self.provider,
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
    error_code: str | None = None
    provider_request_ids: list[str] = field(default_factory=list)
    tool_call_id: UUID | None = None
    tool_call_index: int = WEB_SEARCH_TOOL_CALL_INDEX

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "started",
            "scope": "public_web",
            "types": [self.result_type],
            "semantic": False,
        }

    def tool_result_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": self.status,
            "error_code": self.error_code,
            "result_count": len(self.citations),
            "selected_count": len(self.selected_citations),
            "latency_ms": self.latency_ms,
            "citations": [citation.to_json() for citation in self.selected_citations],
        }


def should_run_web_search(content: str, options: WebSearchOptions) -> bool:
    """Return whether chat should execute public web search for this turn."""

    if options.mode == "off":
        return False
    if options.mode == "required":
        return True

    normalized = " ".join(content.lower().split())
    if len(normalized) < 2 or normalized in _SHORT_NON_SEARCH_MESSAGES:
        return False
    return any(term in normalized for term in _WEB_SEARCH_CUE_TERMS)


def build_web_search_query(content: str) -> str:
    """Build a bounded web-search query from the user message."""

    query = " ".join(content.split()).strip()
    lowered = query.lower()
    for prefix in (
        "search the web for ",
        "search web for ",
        "look up ",
        "lookup ",
        "find online ",
        "find ",
        "verify ",
        "what is the latest ",
        "what's the latest ",
    ):
        if lowered.startswith(prefix):
            query = query[len(prefix) :].strip()
            lowered = query.lower()
            break
    query = query.strip(" \t\r\n?.!,;:")
    return (query or content).strip()[:WEB_SEARCH_QUERY_MAX_CHARS]


async def execute_web_search(
    db: Session,
    *,
    provider: WebSearchProvider | None,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    content: str,
    options: WebSearchOptions,
    country: str = "US",
    search_lang: str = "en",
    safe_search: Literal["off", "moderate", "strict"] = "moderate",
) -> WebSearchRun | None:
    """Run public web search for a chat turn and persist tool metadata."""

    del viewer_id
    if not should_run_web_search(content, options):
        return None

    query = build_web_search_query(content)
    start = time.monotonic()
    citations: list[WebSearchCitation] = []
    selected: list[WebSearchCitation] = []
    provider_request_ids: list[str] = []
    context_text = ""
    context_chars = 0
    status = "complete"
    error_code: str | None = None
    result_type = "mixed"

    try:
        if provider is None:
            raise WebSearchError(
                code=WebSearchErrorCode.PROVIDER_DOWN,
                message="Web search provider is not configured",
                provider="brave",
            )

        request = WebSearchRequest(
            query=query,
            result_type=WebSearchResultType.MIXED,
            limit=WEB_SEARCH_LIMIT,
            freshness_days=options.freshness_days,
            allowed_domains=tuple(options.allowed_domains),
            blocked_domains=tuple(options.blocked_domains),
            country=country,
            search_lang=search_lang,
            safe_search=safe_search,
        )
        result_type = request.result_type.value
        response = await provider.search(request)
        citations = [_citation_from_result(item) for item in response.results]
        if response.provider_request_id:
            provider_request_ids.append(response.provider_request_id)
        context_text, context_chars, selected = render_web_context_blocks(citations)
        if not context_text and not citations:
            context_text = '<web_search_results status="no_results" />'
            context_chars = len(context_text)
    except WebSearchError as exc:
        logger.warning(
            "agent_web_search_failed",
            query_hash=hash_query(query),
            provider=exc.provider,
            error_code=str(exc.code),
        )
        status = "error"
        error_code = f"E_WEB_SEARCH_{str(exc.code).upper()}"
        context_text = f'<web_search_results status="error" code="{xml_escape(error_code)}" />'
        context_chars = len(context_text)
    except Exception as exc:
        logger.warning(
            "agent_web_search_failed",
            query_hash=hash_query(query),
            error=str(exc),
        )
        status = "error"
        error_code = "E_WEB_SEARCH_FAILED"
        context_text = '<web_search_results status="error" code="E_WEB_SEARCH_FAILED" />'
        context_chars = len(context_text)

    latency_ms = int((time.monotonic() - start) * 1000)
    run = WebSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash=hash_query(query),
        result_type=result_type,
        requested_freshness_days=options.freshness_days,
        requested_domains={
            "allowed": list(options.allowed_domains),
            "blocked": list(options.blocked_domains),
        },
        citations=citations,
        selected_citations=selected,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        provider_request_ids=provider_request_ids,
    )
    await run_in_threadpool(persist_web_search_run, db, run)
    return run


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


def persist_web_search_run(db: Session, run: WebSearchRun) -> None:
    """Persist the web-search tool call and retrieval rows."""

    selected_context_refs = [
        {"type": "web_result", "id": citation.result_ref} for citation in run.selected_citations
    ]
    result_refs = [citation.to_json() for citation in run.citations]
    requested_types = [
        run.result_type,
        *(f"freshness:{run.requested_freshness_days}" for _ in [0] if run.requested_freshness_days),
        *(f"allow:{domain}" for domain in run.requested_domains["allowed"]),
        *(f"block:{domain}" for domain in run.requested_domains["blocked"]),
    ]

    existing = db.execute(
        text(
            """
            SELECT id
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = :tool_call_index
            FOR UPDATE
            """
        ),
        {
            "assistant_message_id": run.assistant_message_id,
            "tool_call_index": run.tool_call_index,
        },
    ).first()

    if existing is None:
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
                semantic,
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
                false,
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
    else:
        tool_call_id = existing[0]
        update_tool = text(
            """
            UPDATE message_tool_calls
            SET query_hash = :query_hash,
                scope = 'public_web',
                requested_types = :requested_types,
                semantic = false,
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
        )
        db.execute(
            update_tool,
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
    run.tool_call_id = tool_call_id

    db.execute(
        text("DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id"),
        {"tool_call_id": tool_call_id},
    )

    insert_retrieval = text(
        """
        INSERT INTO message_retrievals (
            tool_call_id,
            ordinal,
            result_type,
            source_id,
            media_id,
            context_ref,
            result_ref,
            deep_link,
            score,
            selected
        )
        VALUES (
            :tool_call_id,
            :ordinal,
            'web_result',
            :source_id,
            NULL,
            :context_ref,
            :result_ref,
            :deep_link,
            :score,
            :selected
        )
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
    )
    selected_refs = {citation.result_ref for citation in run.selected_citations}
    for ordinal, citation in enumerate(run.citations):
        db.execute(
            insert_retrieval,
            {
                "tool_call_id": tool_call_id,
                "ordinal": ordinal,
                "source_id": citation.result_ref,
                "context_ref": {"type": "web_result", "id": citation.result_ref},
                "result_ref": citation.to_json(),
                "deep_link": citation.url,
                "score": 1.0 / max(citation.rank, 1),
                "selected": citation.result_ref in selected_refs,
            },
        )
    db.commit()
