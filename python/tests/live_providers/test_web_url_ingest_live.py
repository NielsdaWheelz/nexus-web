"""Live web URL ingestion provider gate."""

from __future__ import annotations

import os
from uuid import UUID

import pytest

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
        result = run_ingest_sync(session, media_id, user_id)
        session.commit()

    assert result["status"] == "success", result
    register_background_job_cleanup(direct_db, media_id)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")
    write_trace(
        tmp_path,
        "live-web-url-nasa-trace.json",
        {
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
        },
    )
