"""Strict permission and deletion traces for real media evidence."""

from __future__ import annotations

from uuid import UUID

import pytest

from nexus.tasks.ingest_web_article import run_ingest_sync as run_web_article_ingest_sync
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_library_removed_evidence_trace,
    assert_media_deleted_evidence_trace,
    assert_media_ready,
    assert_no_search_results,
    assert_reingest_replacement_trace,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    capture_nasa_water_article,
    ensure_real_media_prerequisites,
    grant_ai_plus,
    register_background_job_cleanup,
    register_media_cleanup,
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


def test_real_web_article_reingest_replaces_active_index_and_hides_stale_evidence(
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

    create_response = auth_client.post(
        "/media/from_url",
        json={"url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/"},
        headers=headers,
    )
    assert create_response.status_code == 202, create_response.text
    media_id = UUID(create_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)
    register_background_job_cleanup(direct_db, media_id)
    with direct_db.session() as session:
        first_ingest_result = run_web_article_ingest_sync(
            session,
            media_id,
            user_id,
            "real-media-web-url-initial-fixture",
        )
        session.commit()
    assert first_ingest_result["status"] == "success", first_ingest_result

    media_trace = assert_media_ready(auth_client, headers, media_id)
    first_evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    first_search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")

    refresh_response = auth_client.post(f"/media/{media_id}/refresh", headers=headers)
    assert refresh_response.status_code == 202, refresh_response.text
    assert refresh_response.json()["data"]["refresh_enqueued"] is True, refresh_response.json()
    with direct_db.session() as session:
        result = run_web_article_ingest_sync(
            session,
            media_id,
            user_id,
            "real-media-web-refresh-fixture",
        )
        session.commit()
    assert result["status"] == "success", result

    replacement_trace = assert_reingest_replacement_trace(
        direct_db,
        media_id=media_id,
        old_run_id=UUID(first_evidence_trace["active_run_id"]),
        old_chunk_id=UUID(first_search_trace["result_id"]),
        old_evidence_span_id=UUID(first_search_trace["evidence_span_id"]),
    )
    second_evidence_trace = assert_complete_evidence_trace(
        direct_db, media_id, "web_article", "web"
    )
    second_search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")
    assert second_search_trace["result_id"] != first_search_trace["result_id"], (
        first_search_trace,
        second_search_trace,
    )
    stale_context_response = auth_client.post(
        "/chat-runs",
        headers={**headers, "Idempotency-Key": f"real-media-stale-context-{media_id}"},
        json={
            "content": "Use this stale evidence.",
            "model_id": str(model_id),
            "reasoning": "none",
            "key_mode": "platform_only",
            "conversation_scope": {"type": "media", "media_id": str(media_id)},
            "contexts": [
                {
                    "kind": "object_ref",
                    "type": "content_chunk",
                    "id": first_search_trace["result_id"],
                    "evidence_span_ids": [first_search_trace["evidence_span_id"]],
                }
            ],
            "web_search": {"mode": "off"},
        },
    )
    assert stale_context_response.status_code == 400, stale_context_response.text
    assert stale_context_response.json()["error"]["code"] == "E_INVALID_REQUEST"

    write_trace(
        tmp_path,
        "real-web-nasa-reingest-replacement-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "media": media_trace,
            "initial_worker_result": first_ingest_result,
            "first_evidence": first_evidence_trace,
            "first_search": first_search_trace,
            "refresh": refresh_response.json()["data"],
            "worker_result": result,
            "replacement": replacement_trace,
            "second_evidence": second_evidence_trace,
            "second_search": second_search_trace,
            "stale_context": stale_context_response.json()["error"],
        },
    )


def test_real_web_article_permissions_and_delete_remove_retrievable_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    owner_id = create_test_user_id()
    outsider_id = create_test_user_id()
    owner_headers = auth_headers(owner_id)
    outsider_headers = auth_headers(outsider_id)
    auth_client.get("/me", headers=owner_headers)
    auth_client.get("/me", headers=outsider_headers)
    direct_db.register_cleanup("users", "id", owner_id)
    direct_db.register_cleanup("users", "id", outsider_id)

    media_id = capture_nasa_water_article(auth_client, direct_db, owner_headers)
    media_trace = assert_media_ready(auth_client, owner_headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    search_trace = assert_search_and_resolver(auth_client, owner_headers, media_id, "SOFIA", "web")

    outsider_media = auth_client.get(f"/media/{media_id}", headers=outsider_headers)
    assert outsider_media.status_code == 404, outsider_media.text
    outsider_search = auth_client.get(
        "/search",
        params={
            "q": "SOFIA",
            "scope": f"media:{media_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=outsider_headers,
    )
    assert outsider_search.status_code == 200, outsider_search.text
    assert outsider_search.json()["results"] == [], outsider_search.json()

    delete_response = auth_client.delete(f"/media/{media_id}", headers=owner_headers)
    assert delete_response.status_code == 200, delete_response.text
    assert delete_response.json()["data"]["status"] == "deleted", delete_response.json()
    assert delete_response.json()["data"]["hard_deleted"] is True, delete_response.json()

    owner_media = auth_client.get(f"/media/{media_id}", headers=owner_headers)
    assert owner_media.status_code == 404, owner_media.text
    no_result_trace = assert_no_search_results(auth_client, owner_headers, media_id, "SOFIA")

    deleted_evidence_trace = assert_media_deleted_evidence_trace(direct_db, media_id)

    write_trace(
        tmp_path,
        "real-web-nasa-delete-permissions-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "outsider_search": {"media_id": str(media_id), "query": "SOFIA", "result_count": 0},
            "delete": delete_response.json()["data"],
            "post_delete_search": no_result_trace,
            "post_delete_counts": deleted_evidence_trace,
        },
    )


def test_real_web_article_library_removal_hides_scope_without_deleting_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    media_id = capture_nasa_water_article(auth_client, direct_db, headers)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")

    library_response = auth_client.post(
        "/libraries",
        json={"name": "Real media removal"},
        headers=headers,
    )
    assert library_response.status_code == 201, library_response.text
    library_id = UUID(library_response.json()["data"]["id"])
    direct_db.register_cleanup("library_entries", "library_id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    add_response = auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=headers,
    )
    assert add_response.status_code == 201, add_response.text

    scoped_search = auth_client.get(
        "/search",
        params={
            "q": "SOFIA",
            "scope": f"library:{library_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=headers,
    )
    assert scoped_search.status_code == 200, scoped_search.text
    scoped_results = scoped_search.json()["results"]
    assert any(
        result["type"] == "content_chunk" and result["source"]["media_id"] == str(media_id)
        for result in scoped_results
    ), scoped_search.json()

    remove_response = auth_client.delete(
        f"/media/{media_id}",
        params={"library_id": str(library_id)},
        headers=headers,
    )
    assert remove_response.status_code == 200, remove_response.text
    assert remove_response.json()["data"]["status"] == "removed", remove_response.json()
    assert remove_response.json()["data"]["hard_deleted"] is False, remove_response.json()

    removed_scope_search = auth_client.get(
        "/search",
        params={
            "q": "SOFIA",
            "scope": f"library:{library_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=headers,
    )
    assert removed_scope_search.status_code == 200, removed_scope_search.text
    assert removed_scope_search.json()["results"] == [], removed_scope_search.json()

    media_after_removal = assert_media_ready(auth_client, headers, media_id)
    post_removal_search = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")
    removal_trace = assert_library_removed_evidence_trace(
        direct_db,
        media_id=media_id,
        library_id=library_id,
    )

    write_trace(
        tmp_path,
        "real-web-nasa-library-removal-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "library": {"id": str(library_id), "name": "Real media removal"},
            "media": media_trace,
            "evidence": evidence_trace,
            "scoped_search_before_removal": {
                "scope": f"library:{library_id}",
                "result_count": len(scoped_results),
            },
            "remove": remove_response.json()["data"],
            "scoped_search_after_removal": {
                "scope": f"library:{library_id}",
                "result_count": 0,
            },
            "media_after_removal": media_after_removal,
            "post_removal_search": post_removal_search,
            "removal_trace": removal_trace,
        },
    )
