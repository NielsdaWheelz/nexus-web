"""Live YouTube transcript ingestion provider gate."""

from __future__ import annotations

import os
from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.config import get_settings
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
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


def test_live_youtube_transcript_ingest_indexes_real_video_evidence(
    auth_client, direct_db, tmp_path
):
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider gate must run with NEXUS_ENV=local, staging, or prod")
    if not settings.enable_openai or not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY and ENABLE_OPENAI=true are required for live video ingest")

    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    create_response = auth_client.post(
        "/media/from_url",
        json={"url": "https://www.youtube.com/watch?v=VMj-3S1tku0"},
        headers=headers,
    )
    assert create_response.status_code == 202, create_response.text
    media_id = UUID(create_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)

    result = _run_source_attempt_for_media(direct_db, media_id)

    assert result["status"] == "success", result
    assert result["segment_count"] >= 10, result
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "transcript", "transcript")
    search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "micrograd", "transcript"
    )
    write_trace(
        tmp_path,
        "live-youtube-micrograd-trace.json",
        {
            "source_url": "https://www.youtube.com/watch?v=VMj-3S1tku0",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "segment_count": result["segment_count"],
        },
    )
