"""LLM-backed app-search candidate reranking."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import (
    ApiError,
    ApiErrorCode,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner
from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.search.selection import APP_SEARCH_SELECTION_STRATEGY, citation_quality_score
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StructuredSynthesisError,
    SynthesisRequest,
    build_synthesis_prompt,
    build_synthesis_request,
    run_structured_synthesis,
)

APP_SEARCH_PROVIDER_RERANK_STRATEGY = "app_search_provider_rerank"
APP_SEARCH_PROVIDER_RERANK_VERSION = "v1"
APP_SEARCH_RERANKER_OUTPUT_VERSION = "app_search_reranker.v1"
APP_SEARCH_RERANK_LLM_OPERATION = "search_rerank"
APP_SEARCH_RERANK_TIMEOUT_SECONDS = 30
APP_SEARCH_RERANK_MAX_OUTPUT_TOKENS = 1600


class ProviderRerankOutputError(ValueError):
    """The provider reranker returned output that cannot order candidates."""


class _RankedCandidate(BaseModel):
    ordinal: int = Field(ge=0, strict=True)
    score: float = Field(ge=0.0, le=1.0, strict=True)
    reason: Literal[
        "direct_answer",
        "supporting_context",
        "source_authority",
        "background_context",
        "low_relevance",
    ]

    model_config = ConfigDict(extra="forbid")


class _RerankOutput(BaseModel):
    version: Literal["app_search_reranker.v1"]
    ranked: list[_RankedCandidate] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True, slots=True)
class ProviderRerankResult:
    citations: list[RetrievalCitation]
    trace: list[dict[str, Any]]
    metadata: dict[str, object]


async def rerank_app_search_candidates_with_llm(
    db: Session,
    *,
    viewer_id: UUID,
    owner: LlmCallOwner,
    llm: ModelRuntime,
    provider: str,
    model_name: str,
    resolved_key: ResolvedKey,
    key_mode_requested: str,
    query: str,
    query_class: str,
    citations: list[RetrievalCitation],
) -> ProviderRerankResult:
    if not citations:
        return ProviderRerankResult(
            citations=[],
            trace=[],
            metadata={
                "selection_strategy": APP_SEARCH_PROVIDER_RERANK_STRATEGY,
                "selection_policy_version": APP_SEARCH_PROVIDER_RERANK_VERSION,
                "baseline_strategy": APP_SEARCH_SELECTION_STRATEGY,
                "provider": provider,
                "model": model_name,
                "query_class": query_class,
                "rerank_input_count": 0,
                "rerank_output_count": 0,
                "private_snippet_policy": "not_applicable_no_candidates",
                "private_snippet_policy_version": "app_search_provider_rerank_private_snippets.v1",
                "private_snippet_policy_reason": "no_candidates",
            },
        )
    private_snippet_metadata = _private_snippet_policy_metadata(
        db,
        viewer_id=viewer_id,
        provider=provider,
        resolved_key=resolved_key,
    )
    ledger_start_call_seq = _latest_owner_call_seq(db, owner)
    try:
        result = await run_structured_synthesis(
            llm=LedgeredLLM(
                db=db,
                owner=owner,
                router=llm,
                llm_operation=APP_SEARCH_RERANK_LLM_OPERATION,
                key_mode_requested=key_mode_requested,
                key_mode_used=resolved_key.mode,
            ),
            request=SynthesisRequest(
                provider=provider,
                llm_request=build_synthesis_request(
                    provider=provider,
                    system_prompt=build_synthesis_prompt(
                        persona="You rank saved-source search candidates for retrieval.",
                        preamble=None,
                        domain_rules=[
                            INDEX_GROUNDING_RULE,
                            "Rank every candidate by usefulness for answering the query.",
                            "Return every input ordinal exactly once.",
                            (
                                "Use only these reasons: direct_answer, supporting_context, "
                                "source_authority, background_context, low_relevance."
                            ),
                            "Do not write prose evidence or invent citation targets.",
                        ],
                        json_shape=(
                            '{"version":"app_search_reranker.v1","ranked":['
                            '{"ordinal":0,"score":0.0,"reason":"direct_answer"}]}'
                        ),
                    ),
                    candidates_header="SEARCH CANDIDATES",
                    rendered_candidates="\n".join(
                        json.dumps(
                            _candidate_payload(index, citation),
                            ensure_ascii=True,
                            sort_keys=True,
                        )
                        for index, citation in enumerate(citations)
                    ),
                    extra_user_block=f"QUERY_CLASS: {query_class}\nQUERY: {query}",
                    model_name=model_name,
                    max_tokens=APP_SEARCH_RERANK_MAX_OUTPUT_TOKENS,
                ),
                api_key=resolved_key.api_key,
                timeout_s=APP_SEARCH_RERANK_TIMEOUT_SECONDS,
            ),
            schema=_RerankOutput,
            validate=lambda output: _output_error(output, len(citations)),
            repair=False,
        )
    except ModelCallError as exc:
        raise ApiError(
            api_error_code_for_model_call(exc.error_code),
            "Provider reranking failed.",
            details={
                "detail": exception_error_detail(exc),
                "rerank_metadata": {
                    **private_snippet_metadata,
                    **_rerank_call_metadata(
                        _rerank_call_rows(db, owner, after_call_seq=ledger_start_call_seq)
                    ),
                },
            },
        ) from exc
    except StructuredSynthesisError as exc:
        raise ApiError(
            ApiErrorCode.E_LLM_BAD_REQUEST,
            "Provider reranking returned invalid output.",
            details={
                "detail": exception_error_detail(exc),
                "rerank_metadata": {
                    **private_snippet_metadata,
                    **_rerank_call_metadata(
                        _rerank_call_rows(db, owner, after_call_seq=ledger_start_call_seq)
                    ),
                },
            },
        ) from exc
    except Exception as exc:
        raise ApiError(
            ApiErrorCode.E_LLM_PROVIDER_DOWN,
            "Provider reranking setup failed.",
            details={
                "detail": exception_error_detail(exc),
                "rerank_metadata": {
                    **private_snippet_metadata,
                    **_rerank_call_metadata(
                        _rerank_call_rows(db, owner, after_call_seq=ledger_start_call_seq)
                    ),
                },
            },
        ) from exc

    ordered, trace = apply_provider_rerank_output(
        citations,
        result.value.model_dump(mode="json"),
    )
    rows = _rerank_call_rows(db, owner, after_call_seq=ledger_start_call_seq)
    return ProviderRerankResult(
        citations=ordered,
        trace=trace,
        metadata={
            "selection_strategy": APP_SEARCH_PROVIDER_RERANK_STRATEGY,
            "selection_policy_version": APP_SEARCH_PROVIDER_RERANK_VERSION,
            "baseline_strategy": APP_SEARCH_SELECTION_STRATEGY,
            "provider": provider,
            "model": model_name,
            "key_mode_used": resolved_key.mode,
            "query_class": query_class,
            "rerank_input_count": len(citations),
            "rerank_output_count": len(ordered),
            **private_snippet_metadata,
            **_rerank_call_metadata(rows),
        },
    )


def apply_provider_rerank_output(
    citations: list[RetrievalCitation],
    raw_output: Mapping[str, object],
) -> tuple[list[RetrievalCitation], list[dict[str, Any]]]:
    try:
        output = _RerankOutput.model_validate(raw_output)
    except ValidationError as exc:
        raise ProviderRerankOutputError("reranker output shape is invalid") from exc
    error = _output_error(output, len(citations))
    if error is not None:
        raise ProviderRerankOutputError(error)

    ordered: list[RetrievalCitation] = []
    trace: list[dict[str, Any]] = []
    for to_index, item in enumerate(output.ranked):
        citation = citations[item.ordinal]
        ordered.append(citation)
        trace.append(
            {
                "from": item.ordinal,
                "to": to_index,
                "result_type": citation.result_type,
                "source_id": citation.source_id,
                "score": citation.score,
                "selection_score": round(float(item.score), 4),
                "citation_quality": citation_quality_score(citation),
                "provider_score": round(float(item.score), 4),
                "provider_reason": item.reason,
                "reason": f"provider_{item.reason}",
            }
        )
    return ordered, trace


def _candidate_payload(ordinal: int, citation: RetrievalCitation) -> dict[str, object]:
    source_map_context = None
    if isinstance(citation.source_map, dict):
        context_header = citation.source_map.get("context_header")
        if isinstance(context_header, str):
            source_map_context = context_header[:500]
    return {
        "ordinal": ordinal,
        "result_type": citation.result_type,
        "title": citation.title[:240],
        "source_label": (citation.source_label or "")[:240],
        "snippet": citation.snippet[:700],
        "section": (_section_label(citation) or "")[:240] or None,
        "score_features": {"search_score": citation.score},
        "source_map_context": source_map_context,
    }


def _section_label(citation: RetrievalCitation) -> str | None:
    if not isinstance(citation.locator, dict):
        return citation.citation_label or citation.source_label
    for key in ("section_id", "fragment_id", "page_number", "block_id", "message_id"):
        value = citation.locator.get(key)
        if value is not None:
            return f"{citation.locator.get('type')}:{value}"
    return str(citation.locator.get("type") or citation.citation_label or citation.source_label)


def _output_error(output: _RerankOutput, candidate_count: int) -> str | None:
    if len(output.ranked) != candidate_count:
        return "reranker must rank every candidate exactly once"
    seen: set[int] = set()
    for item in output.ranked:
        if item.ordinal in seen:
            return "reranker returned duplicate ordinals"
        if item.ordinal >= candidate_count:
            return "reranker returned an out-of-range ordinal"
        if not math.isfinite(item.score):
            return "reranker returned a non-finite score"
        seen.add(item.ordinal)
    if seen != set(range(candidate_count)):
        return "reranker output did not cover the input candidate set"
    return None


def _latest_owner_call_seq(db: Session, owner: LlmCallOwner) -> int:
    return int(
        db.execute(
            text(
                """
                SELECT COALESCE(MAX(call_seq), 0)
                FROM llm_calls
                WHERE owner_kind = :owner_kind
                  AND owner_id = :owner_id
                """
            ),
            {"owner_kind": owner.kind, "owner_id": owner.id},
        ).scalar_one()
    )


def _rerank_call_rows(
    db: Session, owner: LlmCallOwner, *, after_call_seq: int
) -> list[dict[str, object]]:
    rows = (
        db.execute(
            text(
                """
                SELECT id, provider_request_id, input_tokens, output_tokens, total_tokens,
                       latency_ms, total_cost_usd_micros, cost_status
                FROM llm_calls
                WHERE owner_kind = :owner_kind
                  AND owner_id = :owner_id
                  AND llm_operation = :llm_operation
                  AND call_seq > :after_call_seq
                ORDER BY call_seq
                """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
                "after_call_seq": after_call_seq,
            },
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


def _sum_rows(rows: Sequence[Mapping[str, object]], key: str) -> int | None:
    values = [int(value) for row in rows if isinstance((value := row[key]), int)]
    return sum(values) if values else None


def _private_snippet_policy_metadata(
    db: Session,
    *,
    viewer_id: UUID,
    provider: str,
    resolved_key: ResolvedKey,
) -> dict[str, object]:
    if resolved_key.provider != provider:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Provider reranking requires a resolved key for the selected provider.",
        )
    if resolved_key.mode == "platform":
        if not get_effective_entitlements(db, viewer_id).can_use_platform_llm:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED,
                "Provider reranking private snippets require platform LLM entitlement.",
            )
        reason = "platform_llm_entitlement_allows_private_deep_route"
    elif resolved_key.mode == "byok":
        if resolved_key.user_key_id is None:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Provider reranking BYOK requires a resolved user key.",
            )
        reason = "resolved_byok_llm_key_for_private_deep_route"
    else:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Provider reranking requires a resolved platform or BYOK key.",
        )
    return {
        "private_snippet_policy": "allowed",
        "private_snippet_policy_version": "app_search_provider_rerank_private_snippets.v1",
        "private_snippet_policy_reason": reason,
        "private_snippet_key_mode_used": resolved_key.mode,
    }


def _rerank_call_metadata(rows: Sequence[Mapping[str, object]]) -> dict[str, object]:
    if not rows:
        return {}
    latest = rows[-1]
    request_ids = [
        str(row["provider_request_id"]) for row in rows if row["provider_request_id"] is not None
    ]
    return {
        "llm_call_id": str(latest["id"]),
        "llm_call_ids": [str(row["id"]) for row in rows],
        "provider_request_id": latest["provider_request_id"],
        "provider_request_ids": request_ids,
        "input_tokens": _sum_rows(rows, "input_tokens"),
        "output_tokens": _sum_rows(rows, "output_tokens"),
        "total_tokens": _sum_rows(rows, "total_tokens"),
        "latency_ms": _sum_rows(rows, "latency_ms"),
        "estimated_cost_usd_micros": _sum_rows(rows, "total_cost_usd_micros"),
        "cost_status": latest["cost_status"],
        "cost_statuses": sorted({str(row["cost_status"]) for row in rows}),
    }
