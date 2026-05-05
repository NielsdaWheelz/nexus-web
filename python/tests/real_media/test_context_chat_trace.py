"""Strict context, retrieval, prompt, and citation traces for real media."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from nexus.services.chat_runs import execute_chat_run
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_context_chat_trace,
    assert_media_ready,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    capture_nasa_water_article,
    ensure_real_media_prerequisites,
    grant_ai_plus,
    write_trace,
)
from tests.utils.db import DirectSessionManager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]


async def test_real_web_article_context_chat_persists_retrievals_prompt_and_citations(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)
    grant_ai_plus(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)

    media_id = capture_nasa_water_article(auth_client, direct_db, headers)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")
    chunk_id = UUID(search_trace["result_id"])
    evidence_span_id = UUID(search_trace["evidence_span_id"])

    create_response = auth_client.post(
        "/chat-runs",
        headers={**headers, "Idempotency-Key": f"real-media-chat-{uuid4()}"},
        json={
            "content": "What does this source say about SOFIA? Use the attached evidence.",
            "model_id": str(model_id),
            "reasoning": "none",
            "key_mode": "platform_only",
            "conversation_scope": {"type": "media", "media_id": str(media_id)},
            "contexts": [
                {
                    "type": "content_chunk",
                    "id": str(chunk_id),
                    "evidence_span_ids": [str(evidence_span_id)],
                }
            ],
            "web_search": {"mode": "off"},
        },
    )
    assert create_response.status_code == 200, create_response.text
    created = create_response.json()["data"]
    run_id = UUID(created["run"]["id"])
    conversation_id = UUID(created["conversation"]["id"])
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("background_jobs", "dedupe_key", f"chat_run:{run_id}")

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=auth_client.app.state.llm_router,
            web_search_provider=None,
        )
    assert result == {"status": "complete"}, result

    fetched = auth_client.get(f"/chat-runs/{run_id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    fetched_data = fetched.json()["data"]
    assert fetched_data["run"]["status"] == "complete", fetched_data["run"]
    assert fetched_data["assistant_message"]["status"] == "complete", fetched_data[
        "assistant_message"
    ]
    assert fetched_data["assistant_message"]["content"].strip(), fetched_data["assistant_message"]
    assert fetched_data["assistant_message"]["tool_calls"], fetched_data["assistant_message"]
    assert fetched_data["assistant_message"]["claim_evidence"], fetched_data["assistant_message"]

    chat_trace = assert_context_chat_trace(
        direct_db,
        run_id=run_id,
        media_id=media_id,
        evidence_span_id=evidence_span_id,
    )
    write_trace(
        tmp_path,
        "real-web-nasa-context-chat-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "chat": chat_trace,
        },
    )
