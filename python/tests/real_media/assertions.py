"""Schema trace assertions for strict real-media acceptance tests."""

from __future__ import annotations

import hashlib
from uuid import UUID

from sqlalchemy import text

from tests.utils.db import DirectSessionManager


def assert_media_ready(auth_client, headers: dict[str, str], media_id: UUID) -> dict:
    response = auth_client.get(f"/media/{media_id}", headers=headers)
    assert response.status_code == 200, response.text
    media = response.json()["data"]
    assert media["processing_status"] == "ready_for_reading", media
    assert media["retrieval_status"] == "ready", media
    assert media["capabilities"]["can_read"] is True, media["capabilities"]
    assert media["capabilities"]["can_search"] is True, media["capabilities"]
    assert media["capabilities"]["can_quote"] is True, media["capabilities"]
    return media


def assert_fragment_content_contains(
    direct_db: DirectSessionManager,
    media_id: UUID,
    expected_text: str,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT id, canonical_text
                    FROM fragments
                    WHERE media_id = :media_id
                      AND canonical_text ILIKE :needle
                    ORDER BY idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id, "needle": f"%{expected_text}%"},
            )
            .mappings()
            .one_or_none()
        )
    assert row is not None, f"media {media_id} had no fragment containing {expected_text!r}"
    return {
        "media_id": str(media_id),
        "fragment_id": str(row["id"]),
        "expected_text": expected_text,
        "canonical_text_sha256": hashlib.sha256(row["canonical_text"].encode()).hexdigest(),
    }


def assert_complete_evidence_trace(
    direct_db: DirectSessionManager,
    media_id: UUID,
    source_kind: str,
    resolver_kind: str,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.status,
                        mcis.active_run_id,
                        cir.state,
                        cir.embedding_provider,
                        cir.embedding_model,
                        cir.embedding_config_hash,
                        (
                            SELECT count(*)
                            FROM source_snapshots ss
                            WHERE ss.media_id = :media_id
                              AND ss.index_run_id = mcis.active_run_id
                        ) AS snapshot_count,
                        (
                            SELECT count(*)
                            FROM content_blocks cb
                            WHERE cb.media_id = :media_id
                              AND cb.index_run_id = mcis.active_run_id
                        ) AS block_count,
                        (
                            SELECT count(*)
                            FROM content_chunks cc
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                              AND cc.source_kind = :source_kind
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans es
                            WHERE es.media_id = :media_id
                              AND es.index_run_id = mcis.active_run_id
                              AND es.resolver_kind = :resolver_kind
                        ) AS evidence_count,
                        (
                            SELECT count(DISTINCT ce.chunk_id)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                              AND ce.embedding_provider = cir.embedding_provider
                              AND ce.embedding_model = cir.embedding_model
                              AND ce.embedding_version = cir.embedding_version
                              AND ce.embedding_config_hash = cir.embedding_config_hash
                              AND ce.embedding_dimensions > 0
                              AND char_length(ce.embedding_sha256) = 64
                        ) AS embedding_count
                        ,
                        (
                            SELECT count(DISTINCT ce.embedding_dimensions)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                        ) AS embedding_dimension_count,
                        (
                            SELECT max(ce.embedding_dimensions)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.media_id = :media_id
                              AND cc.index_run_id = mcis.active_run_id
                        ) AS embedding_dimensions
                    FROM media_content_index_states mcis
                    JOIN content_index_runs cir ON cir.id = mcis.active_run_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "source_kind": source_kind,
                    "resolver_kind": resolver_kind,
                },
            )
            .mappings()
            .one()
        )
        assert row["status"] == "ready", row
        assert row["state"] == "ready", row
        assert row["embedding_provider"] != "test", row
        assert str(row["embedding_model"]).startswith("openai_"), row
        assert row["embedding_config_hash"], row
        assert row["snapshot_count"] > 0, row
        assert row["block_count"] > 0, row
        assert row["chunk_count"] > 0, row
        assert row["evidence_count"] == row["chunk_count"], row
        assert row["embedding_count"] == row["chunk_count"], row
        assert row["embedding_dimension_count"] == 1, row
        assert row["embedding_dimensions"] > 0, row

        source_snapshot_rows = (
            session.execute(
                text(
                    """
                    SELECT
                        id,
                        source_kind,
                        artifact_kind,
                        artifact_ref,
                        content_type,
                        byte_length,
                        source_fingerprint,
                        source_version,
                        extractor_version,
                        content_sha256,
                        language
                    FROM source_snapshots
                    WHERE media_id = :media_id
                      AND index_run_id = :active_run_id
                    ORDER BY id ASC
                    """
                ),
                {"media_id": media_id, "active_run_id": row["active_run_id"]},
            )
            .mappings()
            .all()
        )
        assert source_snapshot_rows, f"media {media_id} had no source snapshots in active run"

        block_rows = (
            session.execute(
                text(
                    """
                    SELECT id, source_snapshot_id, block_idx, block_kind,
                           canonical_text, text_sha256,
                           source_start_offset, source_end_offset,
                           locator, selector
                    FROM content_blocks
                    WHERE media_id = :media_id
                      AND index_run_id = :active_run_id
                    ORDER BY block_idx ASC
                    """
                ),
                {"media_id": media_id, "active_run_id": row["active_run_id"]},
            )
            .mappings()
            .all()
        )
        previous_end = -1
        for block in block_rows:
            assert block["source_start_offset"] >= previous_end, block
            assert block["source_end_offset"] >= block["source_start_offset"], block
            assert (
                hashlib.sha256(block["canonical_text"].encode()).hexdigest() == block["text_sha256"]
            ), block
            assert isinstance(block["locator"], dict) and block["locator"], block
            assert isinstance(block["selector"], dict) and block["selector"], block
            previous_end = block["source_end_offset"]

        chunk_rows = (
            session.execute(
                text(
                    """
                    SELECT
                        cc.id,
                        cc.primary_evidence_span_id,
                        cc.chunk_text,
                        cc.chunk_sha256,
                        cc.token_count,
                        es.span_text,
                        es.span_sha256,
                        es.selector,
                        es.citation_label,
                        string_agg(
                            ccp.separator_before ||
                            substr(
                                cb.canonical_text,
                                ccp.block_start_offset + 1,
                                ccp.block_end_offset - ccp.block_start_offset
                            ),
                            ''
                            ORDER BY ccp.part_idx
                        ) AS reconstructed
                    FROM content_chunks cc
                    JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                    JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                    JOIN content_blocks cb ON cb.id = ccp.block_id
                    WHERE cc.media_id = :media_id
                      AND cc.index_run_id = :active_run_id
                    GROUP BY cc.id, cc.primary_evidence_span_id, cc.chunk_text,
                             cc.chunk_sha256, cc.token_count, es.span_text,
                             es.span_sha256, es.selector, es.citation_label
                    ORDER BY cc.chunk_idx
                    """
                ),
                {"media_id": media_id, "active_run_id": row["active_run_id"]},
            )
            .mappings()
            .all()
        )
        assert chunk_rows, f"media {media_id} had no chunks in active run"
        for chunk in chunk_rows:
            assert chunk["reconstructed"] == chunk["chunk_text"], chunk
            assert chunk["span_text"] == chunk["chunk_text"], chunk
            assert (
                hashlib.sha256(chunk["chunk_text"].encode()).hexdigest() == chunk["chunk_sha256"]
            ), chunk
            assert (
                hashlib.sha256(chunk["span_text"].encode()).hexdigest() == chunk["span_sha256"]
            ), chunk

        part_rows = (
            session.execute(
                text(
                    """
                    SELECT
                        ccp.chunk_id,
                        ccp.part_idx,
                        ccp.block_id,
                        ccp.block_start_offset,
                        ccp.block_end_offset,
                        ccp.chunk_start_offset,
                        ccp.chunk_end_offset,
                        ccp.separator_before
                    FROM content_chunk_parts ccp
                    JOIN content_chunks cc ON cc.id = ccp.chunk_id
                    WHERE cc.media_id = :media_id
                      AND cc.index_run_id = :active_run_id
                    ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                    """
                ),
                {"media_id": media_id, "active_run_id": row["active_run_id"]},
            )
            .mappings()
            .all()
        )
        assert part_rows, f"media {media_id} had no chunk parts in active run"

    return {
        "media_id": str(media_id),
        "active_run_id": str(row["active_run_id"]),
        "source_kind": source_kind,
        "resolver_kind": resolver_kind,
        "embedding_provider": row["embedding_provider"],
        "embedding_model": row["embedding_model"],
        "embedding_dimensions": row["embedding_dimensions"],
        "embedding_config_hash": row["embedding_config_hash"],
        "snapshot_count": row["snapshot_count"],
        "block_count": row["block_count"],
        "chunk_count": row["chunk_count"],
        "evidence_count": row["evidence_count"],
        "embedding_count": row["embedding_count"],
        "chunk_ids": [str(chunk["id"]) for chunk in chunk_rows],
        "evidence_span_ids": [str(chunk["primary_evidence_span_id"]) for chunk in chunk_rows],
        "source_snapshots": [
            {
                "id": str(snapshot["id"]),
                "source_kind": snapshot["source_kind"],
                "artifact_kind": snapshot["artifact_kind"],
                "artifact_ref": snapshot["artifact_ref"],
                "content_type": snapshot["content_type"],
                "byte_length": snapshot["byte_length"],
                "source_fingerprint": snapshot["source_fingerprint"],
                "source_version": snapshot["source_version"],
                "extractor_version": snapshot["extractor_version"],
                "content_sha256": snapshot["content_sha256"],
                "language": snapshot["language"],
            }
            for snapshot in source_snapshot_rows
        ],
        "content_blocks": [
            {
                "id": str(block["id"]),
                "source_snapshot_id": str(block["source_snapshot_id"]),
                "block_idx": block["block_idx"],
                "block_kind": block["block_kind"],
                "text_sha256": block["text_sha256"],
                "source_start_offset": block["source_start_offset"],
                "source_end_offset": block["source_end_offset"],
                "locator": block["locator"],
                "selector": block["selector"],
            }
            for block in block_rows
        ],
        "content_chunks": [
            {
                "id": str(chunk["id"]),
                "primary_evidence_span_id": str(chunk["primary_evidence_span_id"]),
                "chunk_sha256": chunk["chunk_sha256"],
                "token_count": chunk["token_count"],
            }
            for chunk in chunk_rows
        ],
        "chunk_parts": [
            {
                "chunk_id": str(part["chunk_id"]),
                "part_idx": part["part_idx"],
                "block_id": str(part["block_id"]),
                "block_start_offset": part["block_start_offset"],
                "block_end_offset": part["block_end_offset"],
                "chunk_start_offset": part["chunk_start_offset"],
                "chunk_end_offset": part["chunk_end_offset"],
                "separator_before": part["separator_before"],
            }
            for part in part_rows
        ],
        "evidence_spans": [
            {
                "id": str(chunk["primary_evidence_span_id"]),
                "span_sha256": chunk["span_sha256"],
                "selector": chunk["selector"],
                "citation_label": chunk["citation_label"],
            }
            for chunk in chunk_rows
        ],
    }


def assert_pdf_ocr_required_trace(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        m.processing_status,
                        m.last_error_code,
                        m.plain_text,
                        mcis.status,
                        mcis.status_reason,
                        mcis.latest_run_id,
                        cir.state,
                        (
                            SELECT count(*)
                            FROM content_blocks
                            WHERE media_id = :media_id
                              AND index_run_id = mcis.latest_run_id
                        ) AS block_count,
                        (
                            SELECT count(*)
                            FROM content_chunks
                            WHERE media_id = :media_id
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.media_id = :media_id
                        ) AS embedding_count
                    FROM media m
                    JOIN media_content_index_states mcis ON mcis.media_id = m.id
                    JOIN content_index_runs cir ON cir.id = mcis.latest_run_id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        assert row["processing_status"] == "ready_for_reading", row
        assert row["last_error_code"] == "E_PDF_TEXT_UNAVAILABLE", row
        assert row["plain_text"] is None, row
        assert row["status"] == "ocr_required", row
        assert row["status_reason"] == "ocr_required", row
        assert row["state"] == "ocr_required", row
        assert row["block_count"] > 0, row
        assert row["chunk_count"] == 0, row
        assert row["embedding_count"] == 0, row

        block = (
            session.execute(
                text(
                    """
                    SELECT canonical_text, locator, selector
                    FROM content_blocks
                    WHERE media_id = :media_id
                      AND index_run_id = :run_id
                    ORDER BY block_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id, "run_id": row["latest_run_id"]},
            )
            .mappings()
            .one()
        )
        assert block["canonical_text"] == "", block
        assert isinstance(block["locator"], dict) and block["locator"], block
        assert isinstance(block["selector"], dict) and block["selector"], block

    return {
        "media_id": str(media_id),
        "latest_run_id": str(row["latest_run_id"]),
        "status": row["status"],
        "status_reason": row["status_reason"],
        "state": row["state"],
        "block_count": row["block_count"],
        "chunk_count": row["chunk_count"],
        "embedding_count": row["embedding_count"],
    }


def assert_reingest_replacement_trace(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    old_run_id: UUID,
    old_chunk_id: UUID,
    old_evidence_span_id: UUID,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.active_run_id AS new_run_id,
                        old_run.state AS old_run_state,
                        old_run.deactivated_at AS old_run_deactivated_at,
                        old_run.superseded_by_run_id AS old_run_superseded_by_run_id,
                        old_chunk.index_run_id AS old_chunk_run_id,
                        old_span.index_run_id AS old_span_run_id
                    FROM media_content_index_states mcis
                    JOIN content_index_runs old_run ON old_run.id = :old_run_id
                    JOIN content_chunks old_chunk ON old_chunk.id = :old_chunk_id
                    JOIN evidence_spans old_span ON old_span.id = :old_evidence_span_id
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "old_run_id": old_run_id,
                    "old_chunk_id": old_chunk_id,
                    "old_evidence_span_id": old_evidence_span_id,
                },
            )
            .mappings()
            .one()
        )
        assert row["new_run_id"] != old_run_id, row
        assert row["old_run_state"] == "ready", row
        assert row["old_run_deactivated_at"] is not None, row
        assert row["old_run_superseded_by_run_id"] == row["new_run_id"], row
        assert row["old_chunk_run_id"] == old_run_id, row
        assert row["old_span_run_id"] == old_run_id, row

    return {
        "media_id": str(media_id),
        "old_run_id": str(old_run_id),
        "new_run_id": str(row["new_run_id"]),
        "old_chunk_id": str(old_chunk_id),
        "old_evidence_span_id": str(old_evidence_span_id),
        "old_run_deactivated_at": row["old_run_deactivated_at"].isoformat(),
    }


def assert_search_and_resolver(
    auth_client,
    headers: dict[str, str],
    media_id: UUID,
    query: str,
    resolver_kind: str,
) -> dict:
    search_response = auth_client.get(
        "/search",
        params={
            "q": query,
            "scope": f"media:{media_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=headers,
    )
    assert search_response.status_code == 200, search_response.text
    matches = [
        result
        for result in search_response.json()["results"]
        if result["type"] == "content_chunk" and result["source"]["media_id"] == str(media_id)
    ]
    assert matches, f"search did not return indexed content_chunk for {media_id}"

    result = matches[0]
    semantic_response = auth_client.get(
        "/search",
        params={
            "q": query,
            "scope": f"media:{media_id}",
            "types": "content_chunk",
            "semantic": "true",
            "limit": 5,
        },
        headers=headers,
    )
    assert semantic_response.status_code == 200, semantic_response.text
    semantic_matches = [
        item
        for item in semantic_response.json()["results"]
        if item["type"] == "content_chunk" and item["source"]["media_id"] == str(media_id)
    ]
    assert semantic_matches, f"semantic search did not return indexed content_chunk for {media_id}"

    assert result["context_ref"]["type"] == "content_chunk", result
    assert result["context_ref"]["evidence_span_ids"], result
    assert result["evidence_span_ids"] == result["context_ref"]["evidence_span_ids"], result
    assert result["resolver"]["kind"] == resolver_kind, result
    assert result["deep_link"].startswith(f"/media/{media_id}?"), result

    evidence_span_id = result["evidence_span_ids"][0]
    resolver_response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=headers,
    )
    assert resolver_response.status_code == 200, resolver_response.text
    resolved = resolver_response.json()["data"]
    assert resolved["media_id"] == str(media_id), resolved
    assert resolved["resolver"]["kind"] == resolver_kind, resolved
    if resolver_kind == "pdf":
        assert resolved["resolver"]["status"] in {"resolved", "no_geometry"}, resolved
    elif resolver_kind in {"web", "epub", "transcript"}:
        assert resolved["resolver"]["status"] == "resolved", resolved
    else:
        raise AssertionError(f"Unsupported resolver kind {resolver_kind!r}: {resolved}")
    assert query.casefold() in resolved["span_text"].casefold(), resolved

    for legacy_type in ("fragment", "transcript_chunk"):
        legacy_response = auth_client.get(
            "/search",
            params={"q": query, "types": legacy_type},
            headers=headers,
        )
        assert legacy_response.status_code == 400, legacy_response.text
        assert legacy_response.json()["error"]["code"] == "E_INVALID_REQUEST"

    return {
        "media_id": str(media_id),
        "query": query,
        "result_id": result["id"],
        "semantic_result_id": semantic_matches[0]["id"],
        "context_ref": result["context_ref"],
        "evidence_span_id": evidence_span_id,
        "resolver": resolved["resolver"],
        "span_sha256": hashlib.sha256(resolved["span_text"].encode()).hexdigest(),
        "span_text_length": len(resolved["span_text"]),
    }


def assert_context_chat_trace(
    direct_db: DirectSessionManager,
    *,
    run_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        cr.status AS run_status,
                        cr.conversation_id,
                        cr.user_message_id,
                        cr.assistant_message_id,
                        um.status AS user_message_status,
                        am.status AS assistant_message_status,
                        mci.object_type,
                        mci.object_id,
                        mci.context_snapshot_json,
                        mtc.id AS tool_call_id,
                        mtc.tool_name,
                        mtc.scope,
                        mtc.requested_types,
                        mtc.status AS tool_status,
                        mr.id AS retrieval_id,
                        mr.result_type,
                        mr.media_id,
                        mr.evidence_span_id,
                        mr.context_ref,
                        mr.deep_link,
                        mr.retrieval_status,
                        mr.included_in_prompt,
                        cpa.id AS prompt_assembly_id,
                        cpa.included_retrieval_ids,
                        cpa.prompt_block_manifest,
                        cpa.stable_prefix_hash AS prompt_stable_prefix_hash,
                        ml.provider AS llm_provider,
                        ml.model_name AS llm_model_name,
                        ml.provider_request_id,
                        ml.stable_prefix_hash AS llm_stable_prefix_hash,
                        ames.retrieval_status AS evidence_summary_retrieval_status,
                        ames.support_status AS evidence_summary_support_status,
                        ace.id AS claim_evidence_id,
                        ace.evidence_span_id AS claim_evidence_span_id,
                        ace.context_ref AS claim_context_ref,
                        ace.deep_link AS claim_deep_link
                    FROM chat_runs cr
                    JOIN messages um ON um.id = cr.user_message_id
                    JOIN messages am ON am.id = cr.assistant_message_id
                    JOIN message_context_items mci ON mci.message_id = um.id
                    JOIN message_tool_calls mtc ON mtc.assistant_message_id = am.id
                    JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                    JOIN chat_prompt_assemblies cpa ON cpa.chat_run_id = cr.id
                    JOIN message_llm ml ON ml.message_id = am.id
                    JOIN assistant_message_evidence_summaries ames
                      ON ames.message_id = am.id
                    JOIN assistant_message_claims ac ON ac.message_id = am.id
                    JOIN assistant_message_claim_evidence ace ON ace.claim_id = ac.id
                    WHERE cr.id = :run_id
                      AND mci.object_type = 'content_chunk'
                      AND mr.selected = true
                      AND mr.evidence_span_id = :evidence_span_id
                      AND ace.evidence_span_id = :evidence_span_id
                    ORDER BY mr.ordinal ASC, ac.ordinal ASC, ace.ordinal ASC
                    LIMIT 1
                    """
                ),
                {"run_id": run_id, "evidence_span_id": evidence_span_id},
            )
            .mappings()
            .one()
        )
        assert row["run_status"] == "complete", row
        assert row["user_message_status"] == "complete", row
        assert row["assistant_message_status"] == "complete", row
        assert row["context_snapshot_json"]["evidence_span_ids"] == [str(evidence_span_id)], row
        assert row["tool_name"] == "app_search", row
        assert row["scope"] == f"media:{media_id}", row
        assert row["requested_types"] == ["content_chunk"], row
        assert row["tool_status"] == "complete", row
        assert row["result_type"] == "content_chunk", row
        assert row["media_id"] == media_id, row
        assert row["context_ref"]["type"] == "content_chunk", row
        assert row["deep_link"].startswith(f"/media/{media_id}?"), row
        assert row["retrieval_status"] == "included_in_prompt", row
        assert row["included_in_prompt"] is True, row
        assert str(row["retrieval_id"]) in row["included_retrieval_ids"], row
        assert isinstance(row["prompt_block_manifest"], dict) and row["prompt_block_manifest"], row
        assert row["llm_provider"] == "openai", row
        assert str(row["llm_model_name"]).startswith("gpt-"), row
        assert row["provider_request_id"], row
        assert row["llm_stable_prefix_hash"] == row["prompt_stable_prefix_hash"], row
        assert row["evidence_summary_retrieval_status"] == "included_in_prompt", row
        assert row["evidence_summary_support_status"] == "supported", row
        assert row["claim_evidence_span_id"] == evidence_span_id, row
        assert row["claim_context_ref"]["type"] == "content_chunk", row
        assert row["claim_deep_link"].startswith(f"/media/{media_id}?"), row

        event_rows = (
            session.execute(
                text(
                    """
                    SELECT id, seq, event_type
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
        assert event_rows, f"chat run {run_id} did not persist replay events"
        event_types = [event["event_type"] for event in event_rows]
        assert "tool_call" in event_types, event_types
        assert "tool_result" in event_types, event_types
        assert "citation" in event_types, event_types
        assert event_types[-1] == "done", event_types

    return {
        "run_id": str(run_id),
        "conversation_id": str(row["conversation_id"]),
        "user_message_id": str(row["user_message_id"]),
        "assistant_message_id": str(row["assistant_message_id"]),
        "context_item": {
            "object_type": row["object_type"],
            "object_id": str(row["object_id"]),
            "evidence_span_ids": row["context_snapshot_json"]["evidence_span_ids"],
        },
        "tool_call_id": str(row["tool_call_id"]),
        "retrieval_id": str(row["retrieval_id"]),
        "prompt_assembly_id": str(row["prompt_assembly_id"]),
        "prompt_block_manifest": row["prompt_block_manifest"],
        "llm": {
            "provider": row["llm_provider"],
            "model_name": row["llm_model_name"],
            "provider_request_id": row["provider_request_id"],
            "stable_prefix_hash": row["llm_stable_prefix_hash"],
        },
        "events": [
            {
                "id": str(event["id"]),
                "seq": event["seq"],
                "event_type": event["event_type"],
            }
            for event in event_rows
        ],
        "claim_evidence_id": str(row["claim_evidence_id"]),
        "evidence_span_id": str(evidence_span_id),
    }


def assert_empty_chat_retrieval_status_trace(
    direct_db: DirectSessionManager,
    *,
    run_id: UUID,
    expected_scope: str,
    expected_status: str,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        cr.status AS run_status,
                        cr.conversation_id,
                        cr.user_message_id,
                        cr.assistant_message_id,
                        um.status AS user_message_status,
                        am.status AS assistant_message_status,
                        mtc.id AS tool_call_id,
                        mtc.tool_name,
                        mtc.scope,
                        mtc.requested_types,
                        mtc.status AS tool_status,
                        mtc.result_refs,
                        mr.id AS retrieval_id,
                        mr.result_type,
                        mr.source_id,
                        mr.media_id,
                        mr.evidence_span_id,
                        mr.context_ref,
                        mr.result_ref,
                        mr.exact_snippet,
                        mr.selected,
                        mr.included_in_prompt,
                        mr.retrieval_status,
                        cpa.id AS prompt_assembly_id,
                        cpa.included_retrieval_ids,
                        cpa.prompt_block_manifest,
                        ames.retrieval_status AS evidence_summary_retrieval_status,
                        ames.support_status AS evidence_summary_support_status,
                        ames.claim_count,
                        ames.not_enough_evidence_count,
                        ac.claim_kind,
                        ac.support_status AS claim_support_status,
                        (
                            SELECT count(*)
                            FROM assistant_message_claim_evidence ace
                            WHERE ace.claim_id = ac.id
                        ) AS claim_evidence_count
                    FROM chat_runs cr
                    JOIN messages um ON um.id = cr.user_message_id
                    JOIN messages am ON am.id = cr.assistant_message_id
                    JOIN message_tool_calls mtc ON mtc.assistant_message_id = am.id
                    JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                    JOIN chat_prompt_assemblies cpa ON cpa.chat_run_id = cr.id
                    JOIN assistant_message_evidence_summaries ames
                      ON ames.message_id = am.id
                    JOIN assistant_message_claims ac ON ac.message_id = am.id
                    WHERE cr.id = :run_id
                    ORDER BY mr.ordinal ASC, ac.ordinal ASC
                    LIMIT 1
                    """
                ),
                {"run_id": run_id},
            )
            .mappings()
            .one()
        )
        assert row["run_status"] == "complete", row
        assert row["user_message_status"] == "complete", row
        assert row["assistant_message_status"] == "complete", row
        assert row["tool_name"] == "app_search", row
        assert row["scope"] == expected_scope, row
        assert row["requested_types"] == ["content_chunk"], row
        assert row["tool_status"] == "complete", row
        assert row["result_refs"][0]["status"] == expected_status, row
        assert row["result_refs"][0]["scope"] == expected_scope, row
        assert row["result_type"] == "content_chunk", row
        assert row["source_id"] == expected_status, row
        assert row["media_id"] is None, row
        assert row["evidence_span_id"] is None, row
        assert row["context_ref"]["type"] == "content_chunk", row
        assert row["result_ref"]["status"] == expected_status, row
        assert row["result_ref"]["scope"] == expected_scope, row
        assert f'status="{expected_status}"' in row["exact_snippet"], row
        assert row["selected"] is True, row
        assert row["included_in_prompt"] is True, row
        assert row["retrieval_status"] == "included_in_prompt", row
        assert str(row["retrieval_id"]) in row["included_retrieval_ids"], row
        assert isinstance(row["prompt_block_manifest"], dict) and row["prompt_block_manifest"], row
        assert row["evidence_summary_retrieval_status"] == "retrieved", row
        assert row["evidence_summary_support_status"] == "not_enough_evidence", row
        assert row["claim_count"] == 1, row
        assert row["not_enough_evidence_count"] == 1, row
        assert row["claim_kind"] == "insufficient_evidence", row
        assert row["claim_support_status"] == "not_enough_evidence", row
        assert row["claim_evidence_count"] == 0, row

    return {
        "run_id": str(run_id),
        "conversation_id": str(row["conversation_id"]),
        "user_message_id": str(row["user_message_id"]),
        "assistant_message_id": str(row["assistant_message_id"]),
        "tool_call_id": str(row["tool_call_id"]),
        "retrieval_id": str(row["retrieval_id"]),
        "prompt_assembly_id": str(row["prompt_assembly_id"]),
        "scope": expected_scope,
        "status": expected_status,
        "retrieval_status": row["retrieval_status"],
        "support_status": row["evidence_summary_support_status"],
        "claim_kind": row["claim_kind"],
    }


def assert_saved_highlight_trace(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    highlight_id: UUID,
    expected_exact: str,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        h.id,
                        h.anchor_media_id,
                        h.anchor_kind,
                        h.exact,
                        h.prefix,
                        h.suffix,
                        h.color,
                        hfa.fragment_id,
                        hfa.start_offset,
                        hfa.end_offset,
                        hpa.page_number
                    FROM highlights h
                    LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                    LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
                    WHERE h.id = :highlight_id
                    """
                ),
                {"highlight_id": highlight_id},
            )
            .mappings()
            .one()
        )
        assert row["anchor_media_id"] == media_id, row
        assert row["exact"] == expected_exact, row
        assert row["anchor_kind"] in {"fragment_offsets", "pdf_page_geometry"}, row
        if row["anchor_kind"] == "fragment_offsets":
            assert row["fragment_id"] is not None, row
            assert row["start_offset"] >= 0, row
            assert row["end_offset"] > row["start_offset"], row
        elif row["anchor_kind"] == "pdf_page_geometry":
            assert row["page_number"] is not None and row["page_number"] >= 1, row
        else:
            raise AssertionError(f"Unsupported highlight anchor kind: {row}")

    return {
        "highlight_id": str(row["id"]),
        "media_id": str(media_id),
        "anchor_kind": row["anchor_kind"],
        "fragment_id": str(row["fragment_id"]) if row["fragment_id"] else None,
        "page_number": row["page_number"],
        "start_offset": row["start_offset"],
        "end_offset": row["end_offset"],
        "exact_sha256": hashlib.sha256(row["exact"].encode()).hexdigest(),
        "prefix_sha256": hashlib.sha256(str(row["prefix"] or "").encode()).hexdigest(),
        "suffix_sha256": hashlib.sha256(str(row["suffix"] or "").encode()).hexdigest(),
        "color": row["color"],
    }


def assert_export_trace(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    highlight_id: UUID,
    files: list[dict],
    expected_needle: str,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        string_agg(cb.canonical_text, E'\n\n' ORDER BY cb.block_idx)
                            FILTER (WHERE cb.canonical_text <> '') AS block_text,
                        h.exact AS highlight_exact,
                        hfa.fragment_id,
                        hfa.start_offset
                    FROM media_content_index_states mcis
                    JOIN content_blocks cb ON cb.index_run_id = mcis.active_run_id
                    JOIN highlights h ON h.id = :highlight_id
                    JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                    WHERE mcis.media_id = :media_id
                      AND mcis.status = 'ready'
                    GROUP BY h.exact, hfa.fragment_id, hfa.start_offset
                    """
                ),
                {"media_id": media_id, "highlight_id": highlight_id},
            )
            .mappings()
            .one()
        )
    block_text = row["block_text"]
    assert block_text and expected_needle in block_text, row

    canonical_files = [
        file
        for file in files
        if file["path"].startswith("Sources/") and file["path"].endswith("/canonical.txt")
    ]
    assert len(canonical_files) == 1, files
    assert canonical_files[0]["content"] == block_text, canonical_files[0]

    highlight_files = [
        file
        for file in files
        if file["path"].startswith("Highlights/") and file["path"].endswith(".md")
    ]
    assert len(highlight_files) == 1, files
    assert 'selector_kind: "fragment_offsets"' in highlight_files[0]["content"], highlight_files[0]
    assert f'fragment_handle: "frag_{row["fragment_id"].hex}"' in highlight_files[0]["content"], (
        highlight_files[0]
    )
    assert f"start_offset: {row['start_offset']}" in highlight_files[0]["content"], highlight_files[
        0
    ]
    assert f'exact: "{row["highlight_exact"]}"' in highlight_files[0]["content"], highlight_files[0]

    return {
        "canonical_path": canonical_files[0]["path"],
        "canonical_sha256": hashlib.sha256(block_text.encode()).hexdigest(),
        "highlight_id": str(highlight_id),
        "highlight_path": highlight_files[0]["path"],
        "highlight_exact": row["highlight_exact"],
        "fragment_id": str(row["fragment_id"]),
        "start_offset": row["start_offset"],
    }


def assert_library_removed_evidence_trace(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    library_id: UUID,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        (
                            SELECT count(*)
                            FROM library_entries
                            WHERE library_id = :library_id
                              AND media_id = :media_id
                        ) AS removed_library_entry_count,
                        (
                            SELECT count(*)
                            FROM default_library_intrinsics
                            WHERE media_id = :media_id
                        ) AS default_intrinsic_count,
                        (
                            SELECT count(*)
                            FROM media
                            WHERE id = :media_id
                        ) AS media_count,
                        (
                            SELECT count(*)
                            FROM content_index_runs
                            WHERE media_id = :media_id
                        ) AS index_run_count,
                        (
                            SELECT count(*)
                            FROM content_chunks
                            WHERE media_id = :media_id
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans
                            WHERE media_id = :media_id
                        ) AS evidence_count,
                        mcis.status,
                        mcis.active_run_id
                    FROM media_content_index_states mcis
                    WHERE mcis.media_id = :media_id
                    """
                ),
                {"media_id": media_id, "library_id": library_id},
            )
            .mappings()
            .one()
        )
    assert row["removed_library_entry_count"] == 0, row
    assert row["default_intrinsic_count"] == 1, row
    assert row["media_count"] == 1, row
    assert row["index_run_count"] > 0, row
    assert row["chunk_count"] > 0, row
    assert row["evidence_count"] > 0, row
    assert row["status"] == "ready", row

    return {
        "media_id": str(media_id),
        "library_id": str(library_id),
        "active_run_id": str(row["active_run_id"]),
        "removed_library_entry_count": row["removed_library_entry_count"],
        "default_intrinsic_count": row["default_intrinsic_count"],
        "media_count": row["media_count"],
        "index_run_count": row["index_run_count"],
        "chunk_count": row["chunk_count"],
        "evidence_count": row["evidence_count"],
        "status": row["status"],
    }


def assert_no_search_results(
    auth_client,
    headers: dict[str, str],
    media_id: UUID,
    query: str,
) -> dict:
    response = auth_client.get(
        "/search",
        params={
            "q": query,
            "scope": f"media:{media_id}",
            "types": "content_chunk",
            "limit": 5,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"] == [], response.json()
    return {"media_id": str(media_id), "query": query, "result_count": 0}


def assert_media_deleted_evidence_trace(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> dict:
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
    return dict(counts)
