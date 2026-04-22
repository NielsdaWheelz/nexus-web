"""Integration tests for Postgres queue worker contract hardening."""

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


def test_registry_job_kinds_match_task_catalog_contract():
    from nexus.jobs.registry import get_default_registry

    expected_kinds = {
        "ingest_web_article",
        "ingest_epub",
        "ingest_pdf",
        "ingest_youtube_video",
        "enrich_metadata",
        "podcast_sync_subscription_job",
        "podcast_transcribe_episode_job",
        "podcast_reindex_semantic_job",
        "podcast_active_subscription_poll_job",
        "reconcile_stale_ingest_media_job",
        "sync_gutenberg_catalog_job",
        "backfill_default_library_closure_job",
    }
    actual_kinds = set(get_default_registry().keys())
    assert actual_kinds == expected_kinds, (
        "Registry job kinds drifted from required worker contract. "
        f"Expected={sorted(expected_kinds)}, Actual={sorted(actual_kinds)}"
    )


def test_health_exposes_task_contract_version(client: TestClient):
    from nexus.jobs.registry import get_task_contract_version

    response = client.get("/health")
    assert response.status_code == 200, (
        f"Expected /health to return 200, got {response.status_code}: {response.text}"
    )
    payload = response.json()["data"]
    expected_version = get_task_contract_version()
    assert payload.get("task_contract_version") == expected_version, (
        "Health response must expose canonical task contract version for deployment checks. "
        f"Expected {expected_version}, got {payload}"
    )
