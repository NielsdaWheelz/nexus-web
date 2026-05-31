"""Provider-neutral public web-search tool execution for chat."""

from __future__ import annotations

import hashlib
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

from nexus.logging import get_logger
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)

logger = get_logger(__name__)

WEB_SEARCH_TOOL_NAME = "web_search"
WEB_SEARCH_LIMIT = 6
WEB_SEARCH_SELECTED_LIMIT = 5
WEB_SEARCH_CONTEXT_CHARS = 12000
WEB_SEARCH_QUERY_MAX_CHARS = 400

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

    def to_json(self) -> dict[str, Any]:
        source_version = f"web_search:{self.provider}:{self.provider_request_id or self.result_ref}"
        return {
            "type": "web_result",
            "id": self.result_ref,
            "result_type": "web_result",
            "result_ref": self.result_ref,
            "source_id": self.result_ref,
            "title": self.title,
            "url": self.url,
            "display_url": self.display_url,
            "deep_link": self.url,
            "locator": self.locator_json(),
            "snippet": self.snippet,
            "extra_snippets": list(self.extra_snippets),
            "published_at": self.published_at,
            "source_name": self.source_name,
            "rank": self.rank,
            "provider": self.provider,
            "provider_request_id": self.provider_request_id,
            "source_version": source_version,
            "context_ref": {"type": "web_result", "id": self.result_ref},
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
    error_code: str | None = None
    provider_request_ids: list[str] = field(default_factory=list)
    empty_status: str | None = None
    tool_call_id: UUID | None = None
    tool_call_index: int = 0

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": WEB_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "running",
            "scope": "public_web",
            "types": [self.result_type],
            "semantic": False,
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
            "latency_ms": self.latency_ms,
            "filters": {
                "freshness_days": self.requested_freshness_days,
                "allowed_domains": self.requested_domains.get("allowed", []),
                "blocked_domains": self.requested_domains.get("blocked", []),
            },
            "results": [citation.to_json() for citation in self.citations],
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
        retrieval_context_ref_json(
            {
                "type": "web_result",
                "id": citation.result_ref,
            }
        )
        for citation in run.selected_citations
    ]
    result_refs = [retrieval_result_ref_json(citation.to_json()) for citation in run.citations]
    requested_types = [run.result_type]

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

    select_retrieval = text(
        """
        SELECT id
        FROM message_retrievals
        WHERE tool_call_id = :tool_call_id
          AND ordinal = :ordinal
        """
    )
    update_retrieval = text(
        """
        UPDATE message_retrievals
        SET result_type = :result_type,
            source_id = :source_id,
            media_id = NULL,
            context_ref = :context_ref,
            result_ref = :result_ref,
            deep_link = :deep_link,
            score = :score,
            selected = :selected,
            source_title = :source_title,
            exact_snippet = :exact_snippet,
            snippet_prefix = NULL,
            snippet_suffix = NULL,
            locator = :locator,
            retrieval_status = :retrieval_status,
            included_in_prompt = :included_in_prompt,
            source_version = :source_version
        WHERE id = :retrieval_id
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
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
            selected,
            source_title,
            exact_snippet,
            locator,
            retrieval_status,
            included_in_prompt,
            source_version
        )
        VALUES (
            :tool_call_id,
            :ordinal,
            :result_type,
            :source_id,
            NULL,
            :context_ref,
            :result_ref,
            :deep_link,
            :score,
            :selected,
            :source_title,
            :exact_snippet,
            :locator,
            :retrieval_status,
            :included_in_prompt,
            :source_version
        )
        RETURNING id
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
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
            locator,
            source_version
        )
        VALUES (
            :tool_call_id,
            :retrieval_id,
            :ordinal,
            :result_type,
            :source_id,
            :score,
            :selected,
            false,
            :selection_status,
            :selection_reason,
            :result_ref,
            :locator,
            :source_version
        )
        """
    ).bindparams(
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    selected_refs = {citation.result_ref for citation in run.selected_citations}
    persisted_count = 0
    for ordinal, citation in enumerate(run.citations):
        selected = citation.result_ref in selected_refs
        score = 1.0 / max(citation.rank, 1)
        result_ref = retrieval_result_ref_json(citation.to_json())
        locator = citation.locator_json()
        source_version = (
            f"web_search:{citation.provider}:{citation.provider_request_id or citation.result_ref}"
        )
        retrieval_payload = {
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "result_type": "web_result",
            "source_id": citation.result_ref,
            "context_ref": retrieval_context_ref_json(
                {"type": "web_result", "id": citation.result_ref}
            ),
            "result_ref": result_ref,
            "deep_link": citation.url,
            "score": score,
            "selected": selected,
            "source_title": citation.title,
            "exact_snippet": citation.snippet,
            "locator": locator,
            "retrieval_status": "web_result",
            "included_in_prompt": False,
            "source_version": source_version,
        }
        existing_retrieval = db.execute(select_retrieval, retrieval_payload).first()
        if existing_retrieval is None:
            retrieval_id = db.execute(insert_retrieval, retrieval_payload).scalar_one()
        else:
            retrieval_id = existing_retrieval[0]
            db.execute(update_retrieval, {**retrieval_payload, "retrieval_id": retrieval_id})
        db.execute(
            insert_candidate_ledger,
            {
                "tool_call_id": tool_call_id,
                "retrieval_id": retrieval_id,
                "ordinal": ordinal,
                "result_type": "web_result",
                "source_id": citation.result_ref,
                "score": score,
                "selected": selected,
                "selection_status": "web_result" if selected else "retrieved",
                "selection_reason": "within_context_budget" if selected else "below_selected_limit",
                "result_ref": result_ref,
                "locator": locator,
                "source_version": source_version,
            },
        )
        persisted_count = ordinal + 1
    db.execute(
        text(
            """
            UPDATE message_retrieval_candidate_ledgers
            SET retrieval_id = NULL
            WHERE retrieval_id IN (
                SELECT id
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND ordinal >= :persisted_count
            )
            """
        ),
        {"tool_call_id": tool_call_id, "persisted_count": persisted_count},
    )
    db.execute(
        text(
            """
            DELETE FROM message_retrievals
            WHERE tool_call_id = :tool_call_id
              AND ordinal >= :persisted_count
            """
        ),
        {"tool_call_id": tool_call_id, "persisted_count": persisted_count},
    )
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
                'provider_rank_then_context_budget',
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
            "input_count": len(run.citations),
            "selected_count": len(run.selected_citations),
            "budget_chars": WEB_SEARCH_CONTEXT_CHARS,
            "selected_chars": run.context_chars,
            "status": run.status,
            "metadata": {
                "selected_limit": WEB_SEARCH_SELECTED_LIMIT,
                "result_type": run.result_type,
                "provider_request_ids": run.provider_request_ids,
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
    raw_query = " ".join(query.split()).strip()[:WEB_SEARCH_QUERY_MAX_CHARS]
    status = "complete"
    error_code: str | None = None
    citations: list[WebSearchCitation] = []
    selected: list[WebSearchCitation] = []
    context_text = ""
    context_chars = 0
    provider_request_ids: list[str] = []

    if not raw_query:
        status = "error"
        error_code = "invalid_request"
    else:
        try:
            response = await provider.search(
                WebSearchRequest(
                    query=raw_query,
                    result_type=WebSearchResultType.MIXED,
                    limit=WEB_SEARCH_LIMIT,
                    freshness_days=freshness_days,
                )
            )
            citations = [_citation_from_result(r) for r in response.results]
            if response.provider_request_id:
                provider_request_ids = [response.provider_request_id]
            context_text, context_chars, selected = render_web_context_blocks(citations)
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
        query_hash=hashlib.sha256(raw_query.encode("utf-8")).hexdigest() if raw_query else None,
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
        tool_call_index=tool_call_index,
    )
    persist_web_search_run(db, run)
    return run
