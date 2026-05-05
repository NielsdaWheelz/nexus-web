"""Strict permission and deletion traces for real media evidence."""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.db.models import Fragment
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.sanitize_html import sanitize_html
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_media_ready,
    assert_no_search_results,
    assert_reingest_replacement_trace,
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

    media_id = capture_nasa_water_article(auth_client, direct_db, headers)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    first_evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    first_search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")

    replacement_html = """
    <article>
      <h1>There's Water on the Moon?</h1>
      <p>NASA recently announced that - for the first time - we have confirmed the water molecule, H2O, in sunlit areas of the Moon.</p>
      <h2>Did we already know water existed on the Moon?</h2>
      <p>In the late 2000s, a number of missions including the Indian Space Research Organization's Chandrayaan-1, and NASA's Cassini and Deep Impact detected hydration on the lunar surface.</p>
    </article>
    """
    replacement_sanitized = sanitize_html(
        replacement_html,
        "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
    )
    replacement_text = generate_canonical_text(replacement_sanitized)
    assert "Chandrayaan-1" in replacement_text
    assert "SOFIA" not in replacement_text

    with direct_db.session() as session:
        fragment = (
            session.execute(
                text(
                    """
                    SELECT id
                    FROM fragments
                    WHERE media_id = :media_id
                    ORDER BY idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .scalars()
            .one()
        )
        session.execute(
            text(
                """
                UPDATE fragments
                SET html_sanitized = :html_sanitized,
                    canonical_text = :canonical_text
                WHERE id = :fragment_id
                """
            ),
            {
                "fragment_id": fragment,
                "html_sanitized": replacement_sanitized,
                "canonical_text": replacement_text,
            },
        )
        session.execute(
            text("DELETE FROM fragment_blocks WHERE fragment_id = :fragment_id"),
            {"fragment_id": fragment},
        )
        insert_fragment_blocks(session, fragment, parse_fragment_blocks(replacement_text))
        session.flush()
        replacement_fragment = session.get(Fragment, fragment)
        assert replacement_fragment is not None
        result = rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment}",
            fragments=[replacement_fragment],
            reason="real_media_reingest",
            language="en",
        )
        assert result.status == "ready", result
        session.commit()

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
    second_search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "Chandrayaan-1", "web"
    )
    stale_search_trace = assert_no_search_results(auth_client, headers, media_id, "SOFIA")
    stale_context_response = auth_client.post(
        "/chat-runs",
        headers=headers,
        json={
            "content": "Use this stale evidence.",
            "model_id": str(model_id),
            "reasoning": "none",
            "key_mode": "platform_only",
            "conversation_scope": {"type": "media", "media_id": str(media_id)},
            "contexts": [
                {
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
            "first_evidence": first_evidence_trace,
            "first_search": first_search_trace,
            "replacement": replacement_trace,
            "second_evidence": second_evidence_trace,
            "second_search": second_search_trace,
            "stale_search": stale_search_trace,
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

    with direct_db.session() as session:
        counts = (
            session.execute(
                text(
                    """
                SELECT
                    (SELECT count(*) FROM media WHERE id = :media_id) AS media_count,
                    (SELECT count(*) FROM content_index_runs WHERE media_id = :media_id)
                        AS index_run_count,
                    (SELECT count(*) FROM content_chunks WHERE media_id = :media_id)
                        AS chunk_count,
                    (SELECT count(*) FROM evidence_spans WHERE media_id = :media_id)
                        AS evidence_count
                """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
    assert counts["media_count"] == 0, counts
    assert counts["index_run_count"] == 0, counts
    assert counts["chunk_count"] == 0, counts
    assert counts["evidence_count"] == 0, counts

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
            "post_delete_counts": dict(counts),
        },
    )
