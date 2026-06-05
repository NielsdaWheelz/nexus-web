"""Live X author-thread ingestion provider gate."""

from __future__ import annotations

import os
from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.config import get_settings
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_fragment_content_contains,
    assert_media_ready,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
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


def _run_source_attempt_for_media(direct_db, media_id: UUID) -> dict[str, object]:
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT payload
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            )
            .mappings()
            .one()
        )
    payload = row["payload"]
    with direct_db.session() as session:
        return run_source_attempt(
            db=session,
            media_id=UUID(payload["media_id"]),
            attempt_id=UUID(payload["attempt_id"]),
            actor_user_id=UUID(payload["actor_user_id"]),
            request_id=payload.get("request_id"),
        )


def test_live_x_author_thread_ingest_indexes_real_provider_thread(
    auth_client, direct_db, tmp_path
):
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider gate must run with NEXUS_ENV=local, staging, or prod")
    if not settings.enable_openai or not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY and ENABLE_OPENAI=true are required for live X ingest")
    if not settings.x_api_bearer_token:
        pytest.fail("X_API_BEARER_TOKEN must be set for live X ingest")

    source_url = os.environ.get("X_LIVE_TEST_POST_URL")
    if not source_url:
        pytest.fail("X_LIVE_TEST_POST_URL must name the real public post to capture")
    expected_text = os.environ.get("X_LIVE_TEST_EXPECTED_TEXT")
    if not expected_text:
        pytest.fail("X_LIVE_TEST_EXPECTED_TEXT must be a searchable phrase from that post")

    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    create_response = auth_client.post(
        "/media/from_url",
        json={"url": source_url},
        headers=headers,
    )
    assert create_response.status_code == 202, create_response.text
    data = create_response.json()["data"]
    media_id = UUID(data["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    assert data["source_type"] == "x_author_thread"
    assert data["processing_status"] == "pending"
    assert data["ingest_enqueued"] is True

    ingest_result = _run_source_attempt_for_media(direct_db, media_id)
    resolved_media_id = UUID(str(ingest_result["media_id"]))
    if resolved_media_id != media_id:
        register_media_cleanup(direct_db, resolved_media_id)
        register_background_job_cleanup(direct_db, resolved_media_id)
        media_id = resolved_media_id

    with direct_db.session() as session:
        provider_event = (
            session.execute(
                text(
                    """
                    SELECT id, provider, capability, status, target_ref, metadata
                    FROM external_provider_events
                    WHERE media_id = :media_id
                      AND provider = 'x'
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
    direct_db.register_cleanup("external_provider_events", "id", provider_event["id"])

    media_trace = assert_media_ready(auth_client, headers, media_id)
    fragment_trace = assert_fragment_content_contains(direct_db, media_id, expected_text)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, expected_text, "web"
    )

    assert provider_event["provider"] == "x", provider_event
    assert provider_event["capability"] == "author-thread", provider_event
    assert provider_event["status"] == "success", provider_event
    assert str(provider_event["target_ref"]).startswith("author-thread:"), provider_event
    assert int(provider_event["metadata"]["post_count"]) >= 1, provider_event

    write_trace(
        tmp_path,
        "live-x-author-thread-trace.json",
        {
            "source_url": source_url,
            "media": media_trace,
            "fragment": fragment_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "provider_event": {
                "provider": provider_event["provider"],
                "capability": provider_event["capability"],
                "status": provider_event["status"],
                "target_ref": provider_event["target_ref"],
                "metadata": provider_event["metadata"],
            },
        },
    )
