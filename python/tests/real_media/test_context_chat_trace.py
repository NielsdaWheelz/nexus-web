"""Strict context, retrieval, prompt, and citation traces for real media."""

from __future__ import annotations

import hashlib
from uuid import UUID, uuid4

import pytest

from nexus.services.chat_runs import execute_chat_run
from nexus.storage import get_storage_client
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_context_chat_trace,
    assert_empty_chat_retrieval_status_trace,
    assert_media_ready,
    assert_pdf_ocr_required_trace,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    REAL_MEDIA_FIXTURES_DIR,
    capture_nasa_water_article,
    ensure_real_media_prerequisites,
    grant_ai_plus,
    register_background_job_cleanup,
    upload_file_media,
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


async def test_real_media_chat_persists_no_results_and_no_indexed_evidence_statuses(
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

    library_response = auth_client.post("/libraries", json={"name": "a"}, headers=headers)
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

    no_results_response = auth_client.post(
        "/chat-runs",
        headers={**headers, "Idempotency-Key": f"real-media-chat-no-results-{uuid4()}"},
        json={
            "content": "a",
            "model_id": str(model_id),
            "reasoning": "none",
            "key_mode": "platform_only",
            "conversation_scope": {"type": "library", "library_id": str(library_id)},
            "contexts": [],
            "web_search": {"mode": "off"},
        },
    )
    assert no_results_response.status_code == 200, no_results_response.text
    no_results_run_id = UUID(no_results_response.json()["data"]["run"]["id"])
    no_results_conversation_id = UUID(no_results_response.json()["data"]["conversation"]["id"])
    direct_db.register_cleanup("conversations", "id", no_results_conversation_id)
    direct_db.register_cleanup("background_jobs", "dedupe_key", f"chat_run:{no_results_run_id}")

    with direct_db.session() as session:
        no_results_result = await execute_chat_run(
            session,
            run_id=no_results_run_id,
            llm_router=auth_client.app.state.llm_router,
            web_search_provider=None,
        )
    assert no_results_result == {"status": "complete"}, no_results_result
    no_results_trace = assert_empty_chat_retrieval_status_trace(
        direct_db,
        run_id=no_results_run_id,
        expected_scope=f"library:{library_id}",
        expected_status="no_results",
    )

    pdf_bytes = (REAL_MEDIA_FIXTURES_DIR / "frz-1784-01-03-scanned.pdf").read_bytes()
    assert len(pdf_bytes) == 827_443
    assert hashlib.sha256(pdf_bytes).hexdigest() == (
        "14b6a1729b9047a3738f23b818eac6faee80ff5a2d82731c208775a3b33a0c75"
    )
    ocr_media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename="frz-1784-01-03-scanned.pdf",
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        ocr_result = ingest_pdf(str(ocr_media_id), request_id="real-media-chat-no-index-pdf")
        assert ocr_result["status"] == "success", ocr_result
        assert ocr_result["has_text"] is False, ocr_result
        register_background_job_cleanup(direct_db, ocr_media_id)
        ocr_trace = assert_pdf_ocr_required_trace(direct_db, ocr_media_id)

        no_index_response = auth_client.post(
            "/chat-runs",
            headers={**headers, "Idempotency-Key": f"real-media-chat-no-index-{uuid4()}"},
            json={
                "content": "a",
                "model_id": str(model_id),
                "reasoning": "none",
                "key_mode": "platform_only",
                "conversation_scope": {"type": "media", "media_id": str(ocr_media_id)},
                "contexts": [],
                "web_search": {"mode": "off"},
            },
        )
        assert no_index_response.status_code == 200, no_index_response.text
        no_index_run_id = UUID(no_index_response.json()["data"]["run"]["id"])
        no_index_conversation_id = UUID(no_index_response.json()["data"]["conversation"]["id"])
        direct_db.register_cleanup("conversations", "id", no_index_conversation_id)
        direct_db.register_cleanup("background_jobs", "dedupe_key", f"chat_run:{no_index_run_id}")

        with direct_db.session() as session:
            no_index_result = await execute_chat_run(
                session,
                run_id=no_index_run_id,
                llm_router=auth_client.app.state.llm_router,
                web_search_provider=None,
            )
        assert no_index_result == {"status": "complete"}, no_index_result
        no_index_trace = assert_empty_chat_retrieval_status_trace(
            direct_db,
            run_id=no_index_run_id,
            expected_scope=f"media:{ocr_media_id}",
            expected_status="no_indexed_evidence",
        )
    finally:
        get_storage_client().delete_object(storage_path)

    write_trace(
        tmp_path,
        "real-media-empty-chat-status-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon-and-pdf-frz-1784-01-03-scanned",
            "source_urls": [
                "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
                "https://zenodo.org/records/16506766",
            ],
            "licenses": [
                "NASA public web content",
                "Creative Commons Zero v1.0 Universal",
            ],
            "media": media_trace,
            "evidence": evidence_trace,
            "library": {"id": str(library_id), "name": "a"},
            "no_results_chat": no_results_trace,
            "ocr_required": ocr_trace,
            "no_indexed_evidence_chat": no_index_trace,
        },
    )
