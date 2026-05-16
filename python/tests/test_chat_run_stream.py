"""Tests for chat-run SSE delivery and stream auth boundaries."""

import json
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from llm_calling.types import LLMChunk, LLMUsage
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.api.routes import stream as stream_routes
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.stream_token import (
    STREAM_TOKEN_AUDIENCE,
    STREAM_TOKEN_ISSUER,
    STREAM_TOKEN_SCOPE,
    STREAM_TOKEN_TTL_SECONDS,
    _get_signing_key_bytes,
    mint_stream_token,
    verify_stream_token,
)
from nexus.config import clear_settings_cache
from nexus.db.models import ChatRun, MessageRetrieval, MessageToolCall
from nexus.errors import ApiError, ApiErrorCode
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_runs import VERIFICATION_FAILURE_CONTENT, execute_chat_run
from nexus.services.rate_limit import RateLimiter, set_rate_limiter
from nexus.services.search import get_search_result
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_message,
    create_test_model,
)
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _require_chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.fail(f"chat-runs schema missing: {', '.join(sorted(missing))}")


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    _require_chat_runs_schema(engine)


def _insert_terminal_run(
    direct_db: DirectSessionManager,
    *,
    owner_user_id: UUID,
    status: str = "complete",
) -> tuple[UUID, UUID]:
    run_id = uuid4()
    with direct_db.session() as session:
        ensure_user_and_default_library(session, owner_user_id)
        model_id = create_test_model(session)
        conversation_id = create_test_conversation(session, owner_user_id)
        user_message_id = create_test_message(
            session,
            conversation_id=conversation_id,
            seq=1,
            role="user",
            content="Hello",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id=conversation_id,
            seq=2,
            role="assistant",
            content="Hi",
            status=status,
            model_id=model_id,
        )
        session.execute(
            text(
                """
                INSERT INTO chat_runs (
                    id, owner_user_id, conversation_id, user_message_id,
                    assistant_message_id, idempotency_key, payload_hash, status,
                    model_id, reasoning, key_mode, web_search, completed_at,
                    next_event_seq
                )
                VALUES (
                    :id, :owner_user_id, :conversation_id, :user_message_id,
                    :assistant_message_id, :idempotency_key, :payload_hash, :status,
                    :model_id, 'none', 'auto', '{"mode": "off"}'::jsonb, :completed_at,
                    4
                )
                """
            ),
            {
                "id": run_id,
                "owner_user_id": owner_user_id,
                "conversation_id": conversation_id,
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
                "idempotency_key": f"stream-run-{run_id}",
                "payload_hash": f"payload-{run_id}",
                "status": status,
                "model_id": model_id,
                "completed_at": datetime.now(UTC),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                VALUES
                    (:meta_id, :run_id, 1, 'meta', CAST(:meta_payload AS jsonb)),
                    (:delta_id, :run_id, 2, 'delta', CAST(:delta_payload AS jsonb)),
                    (:done_id, :run_id, 3, 'done', CAST(:done_payload AS jsonb))
                """
            ),
            {
                "meta_id": uuid4(),
                "delta_id": uuid4(),
                "done_id": uuid4(),
                "run_id": run_id,
                "meta_payload": json.dumps(
                    {
                        "run_id": str(run_id),
                        "conversation_id": str(conversation_id),
                        "user_message_id": str(user_message_id),
                        "assistant_message_id": str(assistant_message_id),
                        "model_id": str(model_id),
                        "provider": "openai",
                    }
                ),
                "delta_payload": json.dumps({"delta": "Hi"}),
                "done_payload": json.dumps({"status": status}),
            },
        )
        session.commit()

    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("chat_runs", "id", run_id)
    direct_db.register_cleanup("chat_run_events", "run_id", run_id)
    return run_id, conversation_id


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO billing_accounts (
                    id,
                    user_id,
                    plan_tier,
                    subscription_status,
                    current_period_start,
                    current_period_end,
                    created_at,
                    updated_at
                )
                VALUES (
                    gen_random_uuid(),
                    :user_id,
                    'ai_plus',
                    'active',
                    now(),
                    now() + interval '30 days',
                    now(),
                    now()
                )
                """
            ),
            {"user_id": user_id},
        )
        session.commit()
    direct_db.register_cleanup("billing_accounts", "user_id", user_id)


class _StreamingAnswerRouter:
    def __init__(self, *deltas: str) -> None:
        self.deltas = deltas

    async def generate_stream(self, _provider, _req, _api_key, *, timeout_s):
        for delta in self.deltas:
            yield LLMChunk(delta_text=delta, done=False)
        yield LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(input_tokens=10, output_tokens=20, total_tokens=30),
            provider_request_id="resp_source_backed_test",
        )

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        answer = "".join(self.deltas)
        first = self.deltas[0].rstrip()
        second_start = len(first) + 1
        second = answer[second_start:]
        if "Generate one concise artifact" in request.messages[0].content:
            payload = json.loads(request.messages[1].content)
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "artifact_kind": payload["requested_artifact_kind"],
                        "title": "Source timeline",
                        "preview_text": "A source-backed timeline was generated.",
                        "parts": [
                            {
                                "part_key": "event-1",
                                "part_type": "event",
                                "text": first,
                                "evidence_ordinals": [0],
                                "support_state": "source_grounded",
                            }
                        ],
                    }
                )
            )
        if "Extract every atomic factual claim" in request.messages[0].content:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "claims": [
                            {
                                "text": first,
                                "answer_start_offset": 0,
                                "answer_end_offset": len(first),
                            },
                            {
                                "text": second,
                                "answer_start_offset": second_start,
                                "answer_end_offset": second_start + len(second),
                            },
                        ]
                    }
                )
            )
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "ordinal": 0,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(first),
                            "support_status": "supported",
                            "evidence_ordinals": [0],
                            "confidence": 0.98,
                        },
                        {
                            "ordinal": 1,
                            "answer_start_offset": second_start,
                            "answer_end_offset": second_start + len(second),
                            "support_status": "not_enough_evidence",
                            "evidence_ordinals": [],
                            "unsupported_reason": "not in selected evidence",
                            "confidence": 0.1,
                        },
                    ]
                }
            )
        )


def _parse_sse_events(body: str) -> list[dict]:
    events = []
    for block in body.strip().split("\n\n"):
        fields = {}
        for line in block.splitlines():
            if line.startswith(":"):
                continue
            key, value = line.split(": ", 1)
            fields[key] = value
        if fields:
            fields["data"] = json.loads(fields["data"])
            events.append(fields)
    return events


def _response_start_headers(sent_messages: list[dict]) -> dict[str, str]:
    start = next(message for message in sent_messages if message["type"] == "http.response.start")
    return {
        key.decode("latin1").lower(): value.decode("latin1")
        for key, value in start.get("headers", [])
    }


class TestSourceBackedChatRunStreaming:
    @pytest.mark.parametrize(
        ("evidence_mutation", "expected_claim_evidence_count"),
        [
            (None, 1),
            ("media_id", 0),
            ("source_version", 0),
            ("locator", 0),
            ("snippet", 0),
        ],
    )
    @pytest.mark.asyncio
    async def test_source_backed_evidence_span_is_revalidated_before_claim_verification(
        self,
        evidence_mutation,
        expected_claim_evidence_count,
        monkeypatch,
        direct_db: DirectSessionManager,
        chat_runs_schema,
    ):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
        clear_settings_cache()
        user_id = uuid4()
        supported = "The observatory detected water vapor in the target atmosphere."
        unsupported = "The archive includes methane on page five."
        run_id = None
        conversation_id = None
        assistant_message_id = None
        media_id = None
        other_media_id = None

        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=1,
                role="user",
                content="hello",
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=2,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
                parent_message_id=user_message_id,
            )
            media_id = create_searchable_media(session, user_id, title="Verifier Hardening Source")
            if evidence_mutation == "media_id":
                other_media_id = create_searchable_media(
                    session,
                    user_id,
                    title="Wrong Verifier Hardening Source",
                )
            chunk_row = session.execute(
                text(
                    """
                    SELECT cc.id, cc.primary_evidence_span_id
                    FROM content_chunks cc
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).one()
            chunk_id = chunk_row[0]
            evidence_span_id = chunk_row[1]
            search_result = get_search_result(
                session,
                user_id,
                "content_chunk",
                str(chunk_id),
                [evidence_span_id],
            )
            result_payload = search_result.model_dump(mode="json")
            context_ref = {
                "type": "content_chunk",
                "id": str(chunk_id),
                "evidence_span_ids": [str(evidence_span_id)],
            }
            locator = dict(result_payload["locator"])
            source_version = str(result_payload["source_version"])
            exact_snippet = str(result_payload["snippet"])
            if evidence_mutation == "source_version":
                source_version = f"{source_version}-stale"
            elif evidence_mutation == "locator":
                locator["start_offset"] = int(locator["start_offset"]) + 1
            elif evidence_mutation == "snippet":
                exact_snippet = "This text is not present in the canonical source span."
            result_ref = {
                "type": "content_chunk",
                "id": str(chunk_id),
                "result_type": "content_chunk",
                "source_id": str(chunk_id),
                "source_kind": result_payload["source_kind"],
                "title": result_payload["title"],
                "source_label": result_payload.get("source_label") or result_payload["title"],
                "snippet": exact_snippet,
                "deep_link": result_payload["deep_link"],
                "citation_label": result_payload["citation_label"],
                "context_ref": context_ref,
                "evidence_span_id": str(evidence_span_id),
                "evidence_span_ids": [str(evidence_span_id)],
                "source_version": source_version,
                "locator": locator,
                "media_id": str(media_id),
                "media_kind": result_payload.get("media_kind"),
                "score": 1.0,
                "selected": True,
            }
            run = ChatRun(
                owner_user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                idempotency_key=f"source-evidence-hardening-{uuid4()}",
                payload_hash=f"source-evidence-hardening-{uuid4()}",
                status="queued",
                model_id=model_id,
                reasoning="none",
                key_mode="auto",
                web_search={"mode": "off"},
                artifact_intent={"kind": "off"},
            )
            retrieval_media_id = other_media_id if other_media_id is not None else media_id
            tool_call = MessageToolCall(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                tool_name="app_search",
                tool_call_index=0,
                scope="all",
                requested_types=["content_chunk"],
                status="complete",
                result_refs=[result_ref],
                selected_context_refs=[context_ref],
                retrievals=[
                    MessageRetrieval(
                        ordinal=0,
                        result_type="content_chunk",
                        source_id=str(chunk_id),
                        media_id=retrieval_media_id,
                        evidence_span_id=evidence_span_id,
                        scope="all",
                        context_ref=context_ref,
                        result_ref=result_ref,
                        selected=True,
                        source_title=result_payload["title"],
                        exact_snippet=exact_snippet,
                        locator=locator,
                        retrieval_status="selected",
                        included_in_prompt=True,
                        source_version=source_version,
                    )
                ],
            )
            session.add_all([run, tool_call])
            session.commit()
            run_id = run.id

        if media_id is not None:
            direct_db.register_cleanup("media", "id", media_id)
        if other_media_id is not None:
            direct_db.register_cleanup("media", "id", other_media_id)
        direct_db.register_cleanup("users", "id", user_id)
        _seed_ai_plus_billing(direct_db, user_id)
        set_rate_limiter(
            RateLimiter(session_factory=direct_db.session, rpm_limit=100, concurrent_limit=20)
        )

        try:
            with direct_db.session() as session:
                result = await execute_chat_run(
                    session,
                    run_id=run_id,
                    llm_router=_StreamingAnswerRouter(f"{supported} ", unsupported),
                    web_search_provider=None,
                )

                assert result == {"status": "complete"}
                assistant_content = session.execute(
                    text("SELECT content FROM messages WHERE id = :message_id"),
                    {"message_id": assistant_message_id},
                ).scalar_one()
                claim_evidence_count = session.execute(
                    text(
                        """
                        SELECT COUNT(*)
                        FROM assistant_message_claim_evidence e
                        JOIN assistant_message_claims c ON c.id = e.claim_id
                        WHERE c.message_id = :message_id
                        """
                    ),
                    {"message_id": assistant_message_id},
                ).scalar_one()
                assert claim_evidence_count == expected_claim_evidence_count
                if expected_claim_evidence_count:
                    assert assistant_content == supported
                else:
                    assert assistant_content == VERIFICATION_FAILURE_CONTENT
        finally:
            clear_settings_cache()

    @pytest.mark.asyncio
    async def test_source_backed_run_buffers_raw_deltas_until_verified(
        self,
        monkeypatch,
        direct_db: DirectSessionManager,
        chat_runs_schema,
    ):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
        clear_settings_cache()
        user_id = uuid4()
        conversation_id = None
        assistant_message_id = None
        run_id = None
        supported = "The observatory detected water vapor in the target atmosphere."
        unsupported = "The archive includes methane on page five."
        exact_snippet = (
            "The launch report states that the observatory detected water vapor "
            "in the target atmosphere during the second observation window."
        )

        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=1,
                role="user",
                content="What did the launch report say?",
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=2,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
                parent_message_id=user_message_id,
            )
            run = ChatRun(
                owner_user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                idempotency_key=f"source-backed-{uuid4()}",
                payload_hash="source-backed-buffer-test",
                status="queued",
                model_id=model_id,
                reasoning="none",
                key_mode="auto",
                web_search={"mode": "off"},
                artifact_intent={"kind": "timeline"},
            )
            result_ref = {
                "type": "web_result",
                "id": "https://example.test/source",
                "title": "Launch report",
                "url": "https://example.test/source",
                "source_name": "Example",
                "snippet": exact_snippet,
                "provider": "test",
                "source_version": "web:test:v1",
                "context_ref": {
                    "type": "web_result",
                    "id": "https://example.test/source",
                },
                "locator": {
                    "type": "external_url",
                    "url": "https://example.test/source",
                },
            }
            tool_call = MessageToolCall(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                tool_name="web_search",
                tool_call_index=0,
                scope="public_web",
                requested_types=["web_result"],
                status="complete",
                result_refs=[result_ref],
                selected_context_refs=[{"type": "web_result", "id": "https://example.test/source"}],
                retrievals=[
                    MessageRetrieval(
                        ordinal=0,
                        result_type="web_result",
                        source_id="https://example.test/source",
                        scope="public_web",
                        context_ref={
                            "type": "web_result",
                            "id": "https://example.test/source",
                        },
                        result_ref=result_ref,
                        selected=True,
                        source_title="Launch report",
                        exact_snippet=exact_snippet,
                        locator={
                            "type": "external_url",
                            "url": "https://example.test/source",
                        },
                        retrieval_status="web_result",
                        included_in_prompt=True,
                        source_version="web:test:v1",
                    )
                ],
            )
            session.add_all([run, tool_call])
            session.commit()
            run_id = run.id

        _seed_ai_plus_billing(direct_db, user_id)
        set_rate_limiter(
            RateLimiter(session_factory=direct_db.session, rpm_limit=100, concurrent_limit=20)
        )

        try:
            with direct_db.session() as session:
                result = await execute_chat_run(
                    session,
                    run_id=run_id,
                    llm_router=_StreamingAnswerRouter(f"{supported} ", unsupported),
                    web_search_provider=None,
                )

                assert result == {"status": "complete"}

                events = (
                    session.execute(
                        text(
                            """
                        SELECT event_type, payload
                        FROM chat_run_events
                        WHERE run_id = :run_id
                        ORDER BY seq ASC
                        """
                        ),
                        {"run_id": run_id},
                    )
                    .mappings()
                    .all()
                )
                deltas = [row["payload"]["delta"] for row in events if row["event_type"] == "delta"]
                assert deltas == [supported]
                assert all(unsupported not in delta for delta in deltas)
                artifact_events = [
                    row["payload"] for row in events if row["event_type"] == "artifact_delta"
                ]
                retrieval_id = session.execute(
                    text(
                        """
                        SELECT mr.id
                        FROM message_retrievals mr
                        JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                        WHERE mtc.assistant_message_id = :message_id
                        """
                    ),
                    {"message_id": assistant_message_id},
                ).scalar_one()
                assert len(artifact_events) == 1
                artifact_event = artifact_events[0]
                assert artifact_event["artifact_id"] == "generated-artifact"
                assert artifact_event["artifact_kind"] == "timeline"
                assert artifact_event["status"] == "complete"
                assert artifact_event["delta"] == "A source-backed timeline was generated."
                artifact_part = artifact_event["parts"][0]
                assert artifact_part["text"] == supported
                assert artifact_part["source_version"]
                assert isinstance(artifact_part["locator"], dict)
                assert artifact_part["source_ref"]["retrieval_id"] == str(retrieval_id)
                assert artifact_part["context_ref"]["type"] in {"message", "web_result"}
                assert artifact_part["metadata"]["support_state"] == "source_grounded"

                assistant_content = session.execute(
                    text("SELECT content FROM messages WHERE id = :message_id"),
                    {"message_id": assistant_message_id},
                ).scalar_one()
                assert assistant_content == supported
                durable_artifact = (
                    session.execute(
                        text(
                            """
                            SELECT ma.artifact_key,
                                   ma.artifact_kind,
                                   ma.status,
                                   map.text,
                                   map.source_ref,
                                   map.result_ref,
                                   map.metadata
                            FROM message_artifacts ma
                            JOIN message_artifact_parts map ON map.artifact_id = ma.id
                            WHERE ma.message_id = :message_id
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    .mappings()
                    .one()
                )
                assert durable_artifact["artifact_key"] == "generated-artifact"
                assert durable_artifact["artifact_kind"] == "timeline"
                assert durable_artifact["status"] == "complete"
                assert durable_artifact["text"] == supported
                assert durable_artifact["source_ref"]["retrieval_id"] == str(retrieval_id)
                assert durable_artifact["result_ref"]["type"] in {"message", "web_result"}
                assert durable_artifact["metadata"]["source_provenance"]["source_version"]
                assert isinstance(
                    durable_artifact["metadata"]["source_provenance"]["locator"],
                    dict,
                )

                metadata = session.execute(
                    text(
                        """
                        SELECT metadata
                        FROM assistant_message_verifier_runs
                        WHERE message_id = :message_id
                        """
                    ),
                    {"message_id": assistant_message_id},
                ).scalar_one()
                draft_texts = [item["text"] for item in metadata["draft_claim_statuses"]]
                removed_texts = [item["text"] for item in metadata["removed_claim_statuses"]]
                unsupported_texts = [
                    item["text"] for item in metadata["unsupported_claim_statuses"]
                ]
                final_texts = [item["text"] for item in metadata["claim_statuses"]]
                assert metadata["rewrote_answer"] is True
                assert supported in final_texts
                assert unsupported in draft_texts
                assert unsupported in removed_texts
                assert unsupported in unsupported_texts
                assert unsupported in final_texts
                assert metadata["claim_statuses"][1]["claim_kind"] == "insufficient_evidence"
                assert metadata["claim_statuses"][1]["answer_start_offset"] is None
        finally:
            clear_settings_cache()
            with direct_db.session() as cleanup:
                if assistant_message_id is not None:
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM message_artifact_parts
                            WHERE artifact_id IN (
                                SELECT id
                                FROM message_artifacts
                                WHERE message_id = :message_id
                            )
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM message_artifacts WHERE message_id = :message_id"),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM assistant_message_claim_evidence
                            WHERE claim_id IN (
                                SELECT id
                                FROM assistant_message_claims
                                WHERE message_id = :message_id
                            )
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM assistant_message_claims WHERE message_id = :message_id"),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM assistant_message_citation_audits
                            WHERE message_id = :message_id
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM assistant_message_evidence_summaries
                            WHERE message_id = :message_id
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM assistant_message_verifier_runs
                            WHERE message_id = :message_id
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE assistant_message_id = :message_id
                            )
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE assistant_message_id = :message_id
                            )
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            "DELETE FROM source_manifests WHERE assistant_message_id = :message_id"
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            """
                            DELETE FROM message_retrievals
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE assistant_message_id = :message_id
                            )
                            """
                        ),
                        {"message_id": assistant_message_id},
                    )
                    cleanup.execute(
                        text(
                            "DELETE FROM message_tool_calls WHERE assistant_message_id = :message_id"
                        ),
                        {"message_id": assistant_message_id},
                    )
                if run_id is not None:
                    cleanup.execute(
                        text("DELETE FROM chat_run_events WHERE run_id = :run_id"),
                        {"run_id": run_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM chat_prompt_assemblies WHERE chat_run_id = :run_id"),
                        {"run_id": run_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM source_manifests WHERE chat_run_id = :run_id"),
                        {"run_id": run_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM chat_runs WHERE id = :run_id"),
                        {"run_id": run_id},
                    )
                if conversation_id is not None:
                    cleanup.execute(
                        text("DELETE FROM messages WHERE conversation_id = :conversation_id"),
                        {"conversation_id": conversation_id},
                    )
                    cleanup.execute(
                        text("DELETE FROM conversations WHERE id = :conversation_id"),
                        {"conversation_id": conversation_id},
                    )
                cleanup.execute(
                    text("DELETE FROM billing_accounts WHERE user_id = :user_id"),
                    {"user_id": user_id},
                )
                cleanup.execute(
                    text("DELETE FROM memberships WHERE user_id = :user_id"),
                    {"user_id": user_id},
                )
                cleanup.execute(
                    text("DELETE FROM libraries WHERE owner_user_id = :user_id"),
                    {"user_id": user_id},
                )
                cleanup.execute(text("DELETE FROM users WHERE id = :user_id"), {"user_id": user_id})
                cleanup.commit()


class TestStreamTokenMint:
    def test_mint_returns_token_and_url(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        assert isinstance(result["token"], str)
        assert result["stream_base_url"]
        assert result["expires_at"]

    def test_mint_token_is_valid_jwt(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        key = _get_signing_key_bytes()
        payload = jwt.decode(
            result["token"],
            key,
            algorithms=["HS256"],
            audience=STREAM_TOKEN_AUDIENCE,
        )
        assert payload["sub"] == str(user_id)
        assert payload["iss"] == STREAM_TOKEN_ISSUER
        assert payload["scope"] == STREAM_TOKEN_SCOPE
        assert payload["exp"] - payload["iat"] == STREAM_TOKEN_TTL_SECONDS


class TestStreamTokenVerify:
    def test_valid_token(self, direct_db: DirectSessionManager):
        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            session.commit()
        result = mint_stream_token(user_id)
        uid, jti = verify_stream_token(result["token"])
        direct_db.register_cleanup("stream_token_jti_claims", "jti", jti)
        assert uid == user_id
        assert isinstance(jti, str) and jti

    def test_expired_token_rejected(self):
        user_id = uuid4()
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(user_id),
            "exp": int(time.time()) - 10,
            "iat": int(time.time()) - 70,
            "jti": str(uuid4()),
            "scope": STREAM_TOKEN_SCOPE,
        }
        token = jwt.encode(payload, key, algorithm="HS256")

        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)

        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_EXPIRED

    def test_wrong_scope_rejected(self):
        user_id = uuid4()
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(user_id),
            "exp": int(time.time()) + 60,
            "iat": int(time.time()),
            "jti": str(uuid4()),
            "scope": "wrong",
        }
        token = jwt.encode(payload, key, algorithm="HS256")

        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)

        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID


class TestChatRunEventStream:
    def test_replays_events_after_query_cursor(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id)["token"]

        response = auth_client.get(
            f"/chat-runs/{run_id}/events?after=1",
            headers={"Authorization": f"Bearer {stream_token}"},
        )

        assert response.status_code == 200, (
            f"Expected stream replay to succeed, got {response.status_code}: {response.text}"
        )
        events = _parse_sse_events(response.text)
        assert [(event["id"], event["event"]) for event in events] == [
            ("2", "delta"),
            ("3", "done"),
        ]
        assert events[0]["data"] == {"delta": "Hi"}
        assert events[1]["data"] == {
            "status": "complete",
            "usage": None,
            "error_code": None,
            "final_chars": None,
        }

    def test_replays_events_after_last_event_id_header(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id)["token"]

        response = auth_client.get(
            f"/chat-runs/{run_id}/events",
            headers={
                "Authorization": f"Bearer {stream_token}",
                "Last-Event-ID": "2",
            },
        )

        assert response.status_code == 200, (
            f"Expected Last-Event-ID replay to succeed, got {response.status_code}: {response.text}"
        )
        events = _parse_sse_events(response.text)
        assert [(event["id"], event["event"]) for event in events] == [("3", "done")]
        assert events[0]["data"] == {
            "status": "complete",
            "usage": None,
            "error_code": None,
            "final_chars": None,
        }

    def test_closes_when_cursor_is_at_terminal_run(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id)["token"]

        response = auth_client.get(
            f"/chat-runs/{run_id}/events?after=3",
            headers={"Authorization": f"Bearer {stream_token}"},
        )

        assert response.status_code == 200, (
            f"Expected terminal cursor stream to close, got {response.status_code}: {response.text}"
        )
        assert response.text == ""

    @pytest.mark.asyncio
    async def test_tail_closes_when_run_disappears_after_stream_open(self, chat_runs_schema):
        class Request:
            async def is_disconnected(self) -> bool:
                return False

        chunks = [
            chunk
            async for chunk in stream_routes._tail_chat_run_events(
                request=Request(),
                run_id=uuid4(),
                viewer_id=uuid4(),
                after=0,
            )
        ]

        assert chunks == []


class TestStreamCORSMiddleware:
    @pytest.mark.asyncio
    async def test_non_stream_path_passes_through(self):
        calls = []

        async def app(scope, receive, send):
            calls.append(scope)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {"type": "http", "path": "/chat-runs", "method": "GET", "headers": []}
        await middleware(scope, None, None)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_stream_path_without_origin_passes_through(self):
        calls = []

        async def app(scope, receive, send):
            calls.append(scope)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [],
        }
        await middleware(scope, None, None)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_stream_path_wrong_origin_rejected(self):
        async def app(scope, receive, send):
            raise AssertionError("App should not be called for rejected CORS request")

        sent_messages = []

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [(b"origin", b"https://evil.com")],
        }
        await middleware(scope, None, send)

        assert any(message.get("status") == 403 for message in sent_messages)

    @pytest.mark.asyncio
    async def test_options_preflight_handled(self):
        sent_messages = []

        async def app(scope, receive, send):
            raise AssertionError("App should not be called for preflight")

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "OPTIONS",
            "headers": [(b"origin", b"https://nexus.test")],
        }
        await middleware(scope, None, send)

        assert any(message.get("status") == 204 for message in sent_messages)
        headers = _response_start_headers(sent_messages)
        assert headers["access-control-allow-origin"] == "https://nexus.test"
        assert headers["access-control-allow-methods"] == "GET, OPTIONS"
        assert headers["access-control-allow-headers"] == "Authorization, Last-Event-ID"

    @pytest.mark.asyncio
    async def test_actual_get_injects_stream_cors_headers(self):
        sent_messages = []

        async def app(scope, receive, send):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"text/event-stream; charset=utf-8")],
                }
            )
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [
                (b"origin", b"https://nexus.test"),
                (b"authorization", b"Bearer token"),
                (b"last-event-id", b"3"),
            ],
        }
        await middleware(scope, None, send)

        headers = _response_start_headers(sent_messages)
        assert headers["access-control-allow-origin"] == "https://nexus.test"
        assert headers["access-control-expose-headers"] == "X-Request-Id"


class TestStreamAuthMiddlewareBoundary:
    def test_chat_run_events_use_stream_token_auth_boundary(self):
        app = FastAPI()

        @app.get("/chat-runs/{run_id}/events")
        def events(run_id: str):
            return {"run_id": run_id}

        app.add_middleware(
            AuthMiddleware,
            verifier=object(),
            requires_internal_header=True,
            internal_secret="secret",
            bootstrap_callback=lambda user_id, email=None: user_id,
        )

        response = TestClient(app).get("/chat-runs/00000000-0000-0000-0000-000000000000/events")

        assert response.status_code == 200


class TestLegacyStreamSendRoutesRemoved:
    def test_old_stream_send_routes_are_removed(self, auth_client, chat_runs_schema):
        stream_token = mint_stream_token(uuid4())["token"]

        new_conversation_response = auth_client.post(
            "/stream/conversations/messages",
            headers={"Authorization": f"Bearer {stream_token}"},
            json={},
        )
        existing_conversation_response = auth_client.post(
            f"/stream/conversations/{uuid4()}/messages",
            headers={"Authorization": f"Bearer {stream_token}"},
            json={},
        )

        assert new_conversation_response.status_code == 404
        assert existing_conversation_response.status_code == 404
