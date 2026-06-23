"""Live provider acceptance gate for app-search reranking."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from provider_runtime import ModelRuntime
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache, get_settings
from nexus.llm_catalog import MODEL_CATALOG, platform_key_for_provider, platform_provider_names
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.retrieval_citation import citation_from_search_result
from nexus.services.search import get_search_result
from nexus.services.search.llm_rerank import (
    APP_SEARCH_PROVIDER_RERANK_STRATEGY,
    APP_SEARCH_RERANK_LLM_OPERATION,
    rerank_app_search_candidates_with_llm,
)
from tests.factories import (
    create_searchable_media_in_library,
    create_test_library,
    create_test_user,
)
from tests.real_media.conftest import write_trace

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
    pytest.mark.search_rerank_live_eval,
]


def _grant_platform_llm(db: Session, user_id: UUID) -> None:
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="live search rerank eval",
        actor_label="test",
    )


def _first_content_chunk_id(db: Session, media_id: UUID) -> UUID:
    return db.execute(
        text(
            """
            SELECT id
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx ASC, id ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()


async def test_live_provider_reranks_app_search_candidates_and_ledgers_call(
    db_session: Session,
    tmp_path: Path,
) -> None:
    clear_settings_cache()
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider rerank eval must run with NEXUS_ENV=local, staging, or prod")

    providers = platform_provider_names(settings)
    models = []
    seen_providers = set()
    for entry in MODEL_CATALOG:
        if (
            entry.provider in providers
            and entry.model_tier == "light"
            and entry.provider not in seen_providers
        ):
            models.append(entry)
            seen_providers.add(entry.provider)
    if not models:
        pytest.fail("a configured platform LLM key is required for live search rerank eval")

    user_id = create_test_user(db_session)
    _grant_platform_llm(db_session, user_id)
    library_id = create_test_library(db_session, user_id, "Live Search Rerank Eval")
    target_phrase = f"ZEPHYR-RERANK-EVAL-{uuid4().hex} beacon rotates at 17 rpm"
    media_ids = [
        create_searchable_media_in_library(
            db_session,
            user_id,
            library_id,
            title="Background on orbital beacon maintenance without the target fact",
        ),
        create_searchable_media_in_library(
            db_session,
            user_id,
            library_id,
            title=f"Direct answer: {target_phrase}",
        ),
        create_searchable_media_in_library(
            db_session,
            user_id,
            library_id,
            title="Kitchen inventory and unrelated pantry planning notes",
        ),
    ]
    citations = [
        citation_from_search_result(
            get_search_result(db_session, user_id, "content_chunk", str(chunk_id)),
            filters={},
        )
        for chunk_id in [_first_content_chunk_id(db_session, media_id) for media_id in media_ids]
    ]

    target_ref = citations[1].citation_target
    assert [citation.citation_target for citation in citations].index(target_ref) != 0

    traces = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        runtime = ModelRuntime(
            client,
            enable_openai=settings.enable_openai,
            enable_anthropic=settings.enable_anthropic,
            enable_gemini=settings.enable_gemini,
            enable_openrouter=settings.enable_openrouter,
            enable_cloudflare=settings.enable_cloudflare,
            cloudflare_account_id=settings.cloudflare_ai_account_id,
        )
        for model in models:
            api_key = platform_key_for_provider(model.provider, settings)
            if not api_key:
                pytest.fail(
                    f"{model.provider} platform key is required for live search rerank eval"
                )
            result = await rerank_app_search_candidates_with_llm(
                db_session,
                viewer_id=user_id,
                owner=LlmCallOwner(kind="chat_run", id=uuid4()),
                llm=runtime,
                provider=model.provider,
                model_name=model.model_name,
                resolved_key=ResolvedKey(
                    api_key=api_key,
                    mode="platform",
                    provider=model.provider,
                ),
                key_mode_requested="platform_only",
                query=f"Which source states that the {target_phrase}?",
                query_class="multi_hop_search_read_inspect_question",
                citations=citations,
            )

            ordered_refs = [citation.citation_target for citation in result.citations]
            assert ordered_refs[0] == target_ref, result.trace
            assert result.metadata["selection_strategy"] == APP_SEARCH_PROVIDER_RERANK_STRATEGY
            assert result.metadata["rerank_input_count"] == len(citations)
            assert result.metadata["rerank_output_count"] == len(citations)
            assert result.metadata["llm_call_id"]
            assert len(result.trace) == len(citations)
            assert all(item["reason"].startswith("provider_") for item in result.trace)

            row = db_session.execute(
                text(
                    """
                    SELECT provider, model_name, llm_operation, call_status, error_class
                    FROM llm_calls
                    WHERE id = :llm_call_id
                    """
                ),
                {"llm_call_id": result.metadata["llm_call_id"]},
            ).one()
            assert row.provider == model.provider
            assert row.model_name == model.model_name
            assert row.llm_operation == APP_SEARCH_RERANK_LLM_OPERATION
            assert row.call_status == "succeeded"
            assert row.error_class is None
            traces.append(
                {
                    "provider": model.provider,
                    "model": model.model_name,
                    "selection_strategy": result.metadata["selection_strategy"],
                    "llm_call_id": result.metadata["llm_call_id"],
                    "provider_request_ids": result.metadata.get("provider_request_ids", []),
                    "latency_ms": result.metadata.get("latency_ms"),
                    "token_cost_usd_micros": result.metadata.get("estimated_cost_usd_micros"),
                    "input_tokens": result.metadata.get("input_tokens"),
                    "output_tokens": result.metadata.get("output_tokens"),
                    "provider_reranked_order": ordered_refs,
                    "trace": result.trace,
                }
            )

    write_trace(
        tmp_path,
        "live-search-rerank-trace.json",
        {
            "target_ref": target_ref,
            "providers": traces,
        },
    )
