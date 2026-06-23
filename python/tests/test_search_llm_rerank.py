"""Search-owned LLM reranker tests."""

from __future__ import annotations

import json
from typing import Literal
from uuid import UUID, uuid4

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import ModelResponse, TokenUsage
from sqlalchemy import text

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.search.llm_rerank import (
    APP_SEARCH_PROVIDER_RERANK_STRATEGY,
    APP_SEARCH_RERANK_LLM_OPERATION,
    APP_SEARCH_RERANKER_OUTPUT_VERSION,
    ProviderRerankOutputError,
    apply_provider_rerank_output,
    rerank_app_search_candidates_with_llm,
)
from tests.factories import create_test_user

pytestmark = pytest.mark.integration


class _FakeRouter:
    def __init__(self, *responses: dict | BaseException):
        self.responses = list(responses)
        self.requests = []

    async def generate(self, req, *, key, timeout_s):
        del key, timeout_s
        self.requests.append(req)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return ModelResponse(
            text=json.dumps(response),
            usage=TokenUsage(input_tokens=17, output_tokens=11, total_tokens=28),
            provider_request_id=f"req_{len(self.requests)}",
        )


def _resolved_key(
    *, mode: Literal["platform", "byok"] = "platform", user_key_id: str | None = None
) -> ResolvedKey:
    return ResolvedKey(
        api_key="key",
        mode=mode,
        provider="anthropic",
        user_key_id=user_key_id,
    )


def _citation(text: str, *, score: float = 0.5) -> RetrievalCitation:
    source_id = str(uuid4())
    return RetrievalCitation(
        result_type="content_chunk",
        source_id=source_id,
        title=text,
        source_label="Source",
        snippet=text,
        deep_link=f"/reader/{source_id}",
        citation_target=f"content_chunk:{source_id}",
        citation_label="p. 1",
        locator={"type": "web_text_offsets", "section_id": "intro"},
        context_ref={"type": "content_chunk", "id": source_id},
        evidence_span_id=str(uuid4()),
        media_id=str(uuid4()),
        media_kind="web_article",
        score=score,
        source_map={"version": "source_map.v1", "context_header": "Chapter: Intro"},
    )


def _platform_rerank_user(db_session) -> UUID:
    user_id = create_test_user(db_session)
    grant_entitlement_override(
        db_session,
        user_id=user_id,
        plan_tier="ai_plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="search rerank test access",
        actor_label="test",
    )
    return user_id


async def test_llm_rerank_orders_by_validated_ordinals_and_ledgers_call(db_session):
    viewer_id = _platform_rerank_user(db_session)
    weak = _citation("weak context", score=0.8)
    direct = _citation("direct answer", score=0.4)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 1, "score": 0.97, "reason": "direct_answer"},
                {"ordinal": 0, "score": 0.31, "reason": "background_context"},
            ],
        }
    )

    result = await rerank_app_search_candidates_with_llm(
        db_session,
        viewer_id=viewer_id,
        owner=owner,
        llm=router,
        provider="anthropic",
        model_name="claude-haiku-4-5-20251001",
        resolved_key=_resolved_key(),
        key_mode_requested="auto",
        query="answer",
        query_class="cross_document_synthesis",
        citations=[weak, direct],
    )

    assert result.citations == [direct, weak]
    assert result.trace == [
        {
            "from": 1,
            "to": 0,
            "result_type": "content_chunk",
            "source_id": direct.source_id,
            "score": direct.score,
            "selection_score": 0.97,
            "citation_quality": 0.25,
            "provider_score": 0.97,
            "provider_reason": "direct_answer",
            "reason": "provider_direct_answer",
        },
        {
            "from": 0,
            "to": 1,
            "result_type": "content_chunk",
            "source_id": weak.source_id,
            "score": weak.score,
            "selection_score": 0.31,
            "citation_quality": 0.25,
            "provider_score": 0.31,
            "provider_reason": "background_context",
            "reason": "provider_background_context",
        },
    ]
    assert result.metadata["selection_strategy"] == APP_SEARCH_PROVIDER_RERANK_STRATEGY
    assert result.metadata["llm_call_id"]
    assert result.metadata["llm_call_ids"] == [result.metadata["llm_call_id"]]
    assert result.metadata["provider_request_id"] == "req_1"
    assert result.metadata["provider_request_ids"] == ["req_1"]
    assert result.metadata["input_tokens"] == 17
    assert result.metadata["output_tokens"] == 11
    assert result.metadata["total_tokens"] == 28
    assert result.metadata["rerank_input_count"] == 2
    assert result.metadata["rerank_output_count"] == 2
    assert result.metadata["private_snippet_policy"] == "allowed"
    assert (
        result.metadata["private_snippet_policy_reason"]
        == "platform_llm_entitlement_allows_private_deep_route"
    )

    prompt = router.requests[0].messages[1].content
    assert "citation_target" not in prompt
    assert weak.source_id not in prompt
    assert "Chapter: Intro" in prompt

    row = db_session.execute(
        text(
            """
            SELECT provider, model_name, llm_operation, error_class, provider_request_id,
                   key_mode_requested, key_mode_used, call_status, latency_ms,
                   total_cost_usd_micros, cost_status
            FROM llm_calls
            WHERE owner_kind = :owner_kind AND owner_id = :owner_id
            """
        ),
        {"owner_kind": owner.kind, "owner_id": owner.id},
    ).one()
    assert row.provider == "anthropic"
    assert row.model_name == "claude-haiku-4-5-20251001"
    assert row.llm_operation == APP_SEARCH_RERANK_LLM_OPERATION
    assert row.error_class is None
    assert row.provider_request_id == "req_1"
    assert row.key_mode_requested == "auto"
    assert row.key_mode_used == "platform"
    assert row.call_status == "succeeded"
    assert isinstance(row.latency_ms, int)
    assert row.latency_ms >= 0
    assert row.total_cost_usd_micros == result.metadata["estimated_cost_usd_micros"]
    assert row.cost_status == result.metadata["cost_status"]


async def test_llm_rerank_rejects_partial_output_without_repair(db_session):
    viewer_id = _platform_rerank_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 1, "score": 0.95, "reason": "direct_answer"},
                {"ordinal": 0, "score": 0.7, "reason": "supporting_context"},
            ],
        },
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("first"), _citation("second")],
        )

    assert exc.value.code is ApiErrorCode.E_LLM_BAD_REQUEST
    assert exc.value.details is not None
    assert exc.value.details["rerank_metadata"]["provider_request_id"] == "req_1"
    assert exc.value.details["rerank_metadata"]["provider_request_ids"] == ["req_1"]
    assert len(exc.value.details["rerank_metadata"]["llm_call_ids"]) == 1
    assert exc.value.details["rerank_metadata"]["input_tokens"] == 17
    assert exc.value.details["rerank_metadata"]["output_tokens"] == 11
    assert exc.value.details["rerank_metadata"]["total_tokens"] == 28
    assert len(router.requests) == 1


async def test_llm_rerank_metadata_is_scoped_to_current_invocation(db_session):
    viewer_id = _platform_rerank_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": 0.91, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.42, "reason": "background_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 1, "score": 0.94, "reason": "direct_answer"},
                {"ordinal": 0, "score": 0.51, "reason": "supporting_context"},
            ],
        },
    )

    first = await rerank_app_search_candidates_with_llm(
        db_session,
        viewer_id=viewer_id,
        owner=owner,
        llm=router,
        provider="anthropic",
        model_name="claude-haiku-4-5-20251001",
        resolved_key=_resolved_key(),
        key_mode_requested="auto",
        query="first answer",
        query_class="cross_document_synthesis",
        citations=[_citation("first direct"), _citation("first background")],
    )
    second = await rerank_app_search_candidates_with_llm(
        db_session,
        viewer_id=viewer_id,
        owner=owner,
        llm=router,
        provider="anthropic",
        model_name="claude-haiku-4-5-20251001",
        resolved_key=_resolved_key(),
        key_mode_requested="auto",
        query="second answer",
        query_class="cross_document_synthesis",
        citations=[_citation("second support"), _citation("second direct")],
    )

    assert first.metadata["provider_request_ids"] == ["req_1"]
    assert second.metadata["provider_request_ids"] == ["req_2"]
    assert len(first.metadata["llm_call_ids"]) == 1
    assert len(second.metadata["llm_call_ids"]) == 1
    assert first.metadata["llm_call_id"] != second.metadata["llm_call_id"]
    assert second.metadata["llm_call_ids"] == [second.metadata["llm_call_id"]]
    assert second.metadata["input_tokens"] == 17
    assert second.metadata["output_tokens"] == 11
    assert second.metadata["total_tokens"] == 28

    rows = (
        db_session.execute(
            text(
                """
            SELECT provider_request_id
            FROM llm_calls
            WHERE owner_kind = :owner_kind
              AND owner_id = :owner_id
              AND llm_operation = :llm_operation
            ORDER BY call_seq
            """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
            },
        )
        .scalars()
        .all()
    )
    assert rows == ["req_1", "req_2"]


async def test_llm_rerank_invalid_output_is_typed_and_not_ordered(db_session):
    viewer_id = _platform_rerank_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
        },
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_LLM_BAD_REQUEST
    assert exc.value.details is not None
    assert exc.value.details["rerank_metadata"]["provider_request_id"] == "req_1"
    assert exc.value.details["rerank_metadata"]["provider_request_ids"] == ["req_1"]
    assert len(exc.value.details["rerank_metadata"]["llm_call_ids"]) == 1
    assert exc.value.details["rerank_metadata"]["input_tokens"] == 17
    assert exc.value.details["rerank_metadata"]["output_tokens"] == 11
    assert exc.value.details["rerank_metadata"]["total_tokens"] == 28
    assert exc.value.details["rerank_metadata"]["private_snippet_policy"] == "allowed"
    assert len(router.requests) == 1
    assert (
        db_session.execute(
            text(
                """
            SELECT count(*)
            FROM llm_calls
            WHERE owner_kind = :owner_kind
              AND owner_id = :owner_id
              AND llm_operation = :llm_operation
            """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
            },
        ).scalar_one()
        == 1
    )


async def test_llm_rerank_invalid_output_does_not_repair_to_provider_failure(db_session):
    viewer_id = _platform_rerank_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
        },
        ModelCallError(
            ModelCallErrorCode.TIMEOUT,
            "rerank repair should not run",
            provider_request_id="req_repair_timeout",
        ),
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_LLM_BAD_REQUEST
    assert exc.value.details is not None
    assert exc.value.details["rerank_metadata"]["provider_request_id"] == "req_1"
    assert exc.value.details["rerank_metadata"]["provider_request_ids"] == ["req_1"]
    assert len(exc.value.details["rerank_metadata"]["llm_call_ids"]) == 1
    assert len(router.requests) == 1
    rows = db_session.execute(
        text(
            """
            SELECT provider_request_id, error_class
            FROM llm_calls
            WHERE owner_kind = :owner_kind
              AND owner_id = :owner_id
              AND llm_operation = :llm_operation
            ORDER BY call_seq
            """
        ),
        {
            "owner_kind": owner.kind,
            "owner_id": owner.id,
            "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
        },
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("req_1", None),
    ]


async def test_llm_rerank_provider_failure_is_typed_and_ledgered(db_session):
    viewer_id = create_test_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        ModelCallError(
            ModelCallErrorCode.TIMEOUT,
            "rerank timeout",
            provider_request_id="req_timeout",
        )
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(mode="byok", user_key_id=str(uuid4())),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_LLM_TIMEOUT
    assert exc.value.details is not None
    assert exc.value.details["rerank_metadata"]["provider_request_id"] == "req_timeout"
    assert exc.value.details["rerank_metadata"]["llm_call_id"]
    assert exc.value.details["rerank_metadata"]["private_snippet_policy_reason"] == (
        "resolved_byok_llm_key_for_private_deep_route"
    )
    row = db_session.execute(
        text(
            """
            SELECT error_class, provider_request_id
            FROM llm_calls
            WHERE owner_kind = :owner_kind AND owner_id = :owner_id
            """
        ),
        {"owner_kind": owner.kind, "owner_id": owner.id},
    ).one()
    assert tuple(row) == ("E_LLM_TIMEOUT", "req_timeout")


async def test_llm_rerank_provider_runtime_failure_is_typed_and_ledgered(db_session):
    viewer_id = _platform_rerank_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(RuntimeError("catalog setup failed"))

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_LLM_PROVIDER_DOWN
    assert exc.value.details is not None
    assert "catalog setup failed" in exc.value.details["detail"]
    assert exc.value.details["rerank_metadata"]["llm_call_id"]
    row = db_session.execute(
        text(
            """
            SELECT error_class
            FROM llm_calls
            WHERE owner_kind = :owner_kind AND owner_id = :owner_id
            """
        ),
        {"owner_kind": owner.kind, "owner_id": owner.id},
    ).one()
    assert row.error_class == "E_LLM_PROVIDER_DOWN"


async def test_llm_rerank_empty_candidates_do_not_require_private_snippet_policy(db_session):
    viewer_id = create_test_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [],
        }
    )

    result = await rerank_app_search_candidates_with_llm(
        db_session,
        viewer_id=viewer_id,
        owner=owner,
        llm=router,
        provider="anthropic",
        model_name="claude-haiku-4-5-20251001",
        resolved_key=_resolved_key(mode="byok"),
        key_mode_requested="auto",
        query="answer",
        query_class="cross_document_synthesis",
        citations=[],
    )

    assert result.citations == []
    assert result.trace == []
    assert result.metadata["rerank_input_count"] == 0
    assert result.metadata["rerank_output_count"] == 0
    assert result.metadata["private_snippet_policy"] == "not_applicable_no_candidates"
    assert router.requests == []


async def test_llm_rerank_rejects_byok_private_snippets_without_resolved_user_key(
    db_session,
):
    viewer_id = create_test_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": 0.91, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.42, "reason": "background_context"},
            ],
        }
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(mode="byok"),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_INVALID_REQUEST
    assert router.requests == []
    assert (
        db_session.execute(
            text(
                """
            SELECT count(*)
            FROM llm_calls
            WHERE owner_kind = :owner_kind
              AND owner_id = :owner_id
              AND llm_operation = :llm_operation
            """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
            },
        ).scalar_one()
        == 0
    )


async def test_llm_rerank_rejects_platform_private_snippets_without_entitlement(db_session):
    viewer_id = create_test_user(db_session)
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": 0.91, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.42, "reason": "background_context"},
            ],
        }
    )

    with pytest.raises(ApiError) as exc:
        await rerank_app_search_candidates_with_llm(
            db_session,
            viewer_id=viewer_id,
            owner=owner,
            llm=router,
            provider="anthropic",
            model_name="claude-haiku-4-5-20251001",
            resolved_key=_resolved_key(),
            key_mode_requested="auto",
            query="answer",
            query_class="cross_document_synthesis",
            citations=[_citation("a"), _citation("b")],
        )

    assert exc.value.code is ApiErrorCode.E_BILLING_REQUIRED
    assert router.requests == []
    assert (
        db_session.execute(
            text(
                """
            SELECT count(*)
            FROM llm_calls
            WHERE owner_kind = :owner_kind
              AND owner_id = :owner_id
              AND llm_operation = :llm_operation
            """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "llm_operation": APP_SEARCH_RERANK_LLM_OPERATION,
            },
        ).scalar_one()
        == 0
    )


def test_provider_rerank_output_rejects_partial_or_duplicate_rankings():
    citations = [_citation("a"), _citation("b")]

    with pytest.raises(ProviderRerankOutputError):
        apply_provider_rerank_output(
            citations,
            {
                "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
                "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
            },
        )
    with pytest.raises(ProviderRerankOutputError):
        apply_provider_rerank_output(
            citations,
            {
                "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
                "ranked": [
                    {"ordinal": 0, "score": 0.9, "reason": "direct_answer"},
                    {"ordinal": 0, "score": 0.8, "reason": "supporting_context"},
                ],
            },
        )


@pytest.mark.parametrize(
    "raw_output",
    [
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "answer": "use this evidence",
            "ranked": [
                {"ordinal": 0, "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {
                    "ordinal": 0,
                    "score": 0.9,
                    "reason": "direct_answer",
                    "citation_target": "content_chunk:generated",
                },
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {
                    "ordinal": 0,
                    "score": 0.9,
                    "reason": "direct_answer",
                    "uri": "media:generated",
                },
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": 0.9, "reason": "generated_evidence"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": "app_search_reranker.v0",
            "ranked": [
                {"ordinal": 0, "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {"version": APP_SEARCH_RERANKER_OUTPUT_VERSION, "ranked": []},
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 2, "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": -1, "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": -0.1, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": 1.1, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": float("nan"), "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": float("inf"), "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": float("-inf"), "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": "0", "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": 0, "score": "0.9", "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
        {
            "version": APP_SEARCH_RERANKER_OUTPUT_VERSION,
            "ranked": [
                {"ordinal": True, "score": 0.9, "reason": "direct_answer"},
                {"ordinal": 1, "score": 0.8, "reason": "supporting_context"},
            ],
        },
    ],
)
def test_provider_rerank_output_rejects_generated_evidence_or_citation_targets(
    raw_output,
):
    with pytest.raises(ProviderRerankOutputError):
        apply_provider_rerank_output([_citation("a"), _citation("b")], raw_output)
