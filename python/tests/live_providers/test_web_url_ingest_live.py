"""Live web URL ingestion provider gate."""

from __future__ import annotations

import os
from uuid import UUID

import pytest

from nexus.config import get_settings
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_media_ready,
    assert_reingest_replacement_trace,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    grant_ai_plus,
    register_background_job_cleanup,
    register_media_cleanup,
    write_trace,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
    pytest.mark.live_provider,
]


def test_live_web_url_ingest_indexes_real_article_evidence(auth_client, direct_db, tmp_path):
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider gate must run with NEXUS_ENV=local, staging, or prod")
    if not settings.enable_openai or not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY and ENABLE_OPENAI=true are required for live web ingest")

    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)
    grant_ai_plus(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)

    create_response = auth_client.post(
        "/media/from_url",
        json={"url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/"},
        headers=headers,
    )
    assert create_response.status_code == 202, create_response.text
    media_id = UUID(create_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)

    from nexus.tasks.ingest_web_article import run_ingest_sync

    with direct_db.session() as session:
        initial_result = run_ingest_sync(session, media_id, user_id, "live-provider-web-initial")
        session.commit()

    assert initial_result["status"] == "success", initial_result
    register_background_job_cleanup(direct_db, media_id)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    initial_evidence_trace = assert_complete_evidence_trace(
        direct_db, media_id, "web_article", "web"
    )
    initial_search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "SOFIA", "web"
    )

    refresh_response = auth_client.post(f"/media/{media_id}/refresh", headers=headers)
    assert refresh_response.status_code == 202, refresh_response.text
    refresh_trace = refresh_response.json()["data"]
    assert refresh_trace["refresh_enqueued"] is True, refresh_trace
    with direct_db.session() as session:
        refresh_result = run_ingest_sync(session, media_id, user_id, "live-provider-web-refresh")
        session.commit()
    assert refresh_result["status"] == "success", refresh_result

    replacement_trace = assert_reingest_replacement_trace(
        direct_db,
        media_id=media_id,
        old_run_id=UUID(initial_evidence_trace["active_run_id"]),
        old_chunk_id=UUID(initial_search_trace["result_id"]),
        old_evidence_span_id=UUID(initial_search_trace["evidence_span_id"]),
    )
    refreshed_evidence_trace = assert_complete_evidence_trace(
        direct_db, media_id, "web_article", "web"
    )
    refreshed_search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "SOFIA", "web"
    )
    assert refreshed_search_trace["result_id"] != initial_search_trace["result_id"], (
        initial_search_trace,
        refreshed_search_trace,
    )
    stale_context_response = auth_client.post(
        "/chat-runs",
        headers={**headers, "Idempotency-Key": f"live-provider-web-stale-context-{media_id}"},
        json={
            "content": "Use this stale evidence.",
            "model_id": str(model_id),
            "reasoning": "none",
            "key_mode": "platform_only",
            "conversation_scope": {"type": "media", "media_id": str(media_id)},
            "contexts": [
                {
                    "type": "content_chunk",
                    "id": initial_search_trace["result_id"],
                    "evidence_span_ids": [initial_search_trace["evidence_span_id"]],
                }
            ],
            "web_search": {"mode": "off"},
        },
    )
    assert stale_context_response.status_code == 400, stale_context_response.text
    assert stale_context_response.json()["error"]["code"] == "E_INVALID_REQUEST"

    write_trace(
        tmp_path,
        "live-web-url-nasa-trace.json",
        {
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "media": media_trace,
            "initial_worker_result": initial_result,
            "initial_evidence": initial_evidence_trace,
            "initial_search": initial_search_trace,
            "refresh": refresh_trace,
            "refresh_worker_result": refresh_result,
            "replacement": replacement_trace,
            "refreshed_evidence": refreshed_evidence_trace,
            "refreshed_search": refreshed_search_trace,
            "stale_context": stale_context_response.json()["error"],
        },
    )
