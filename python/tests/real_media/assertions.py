"""Schema trace assertions for strict real-media acceptance tests."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text

from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
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
        "canonical_text_length": len(row["canonical_text"]),
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
                        mcis.active_embedding_provider AS embedding_provider,
                        mcis.active_embedding_model AS embedding_model,
                        (
                            SELECT count(*)
                            FROM content_blocks cb
                            WHERE cb.owner_kind = 'media' AND cb.owner_id = :media_id
                        ) AS block_count,
                        (
                            SELECT count(*)
                            FROM content_chunks cc
                            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                              AND cc.source_kind = :source_kind
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans es
                            WHERE es.owner_kind = 'media' AND es.owner_id = :media_id
                              AND es.resolver_kind = :resolver_kind
                        ) AS evidence_count,
                        (
                            SELECT count(DISTINCT ce.chunk_id)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                              AND cc.source_kind = :source_kind
                              AND ce.embedding_provider = mcis.active_embedding_provider
                              AND ce.embedding_model = mcis.active_embedding_model
                              AND ce.embedding_dimensions > 0
                        ) AS embedding_count
                        ,
                        (
                            SELECT count(DISTINCT ce.embedding_dimensions)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                              AND cc.source_kind = :source_kind
                        ) AS embedding_dimension_count,
                        (
                            SELECT max(ce.embedding_dimensions)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                              AND cc.source_kind = :source_kind
                        ) AS embedding_dimensions
                    FROM content_index_states mcis
                    WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
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
        expected_embedding_model = current_transcript_embedding_model()
        expected_embedding_provider = current_transcript_embedding_provider()
        assert row["status"] == "ready", row
        assert row["embedding_provider"] == expected_embedding_provider, row
        assert row["embedding_model"] == expected_embedding_model, row
        assert row["block_count"] > 0, row
        assert row["chunk_count"] > 0, row
        assert row["evidence_count"] == row["chunk_count"], row
        assert row["embedding_count"] == row["chunk_count"], row
        assert row["embedding_dimension_count"] == 1, row
        assert row["embedding_dimensions"] > 0, row

        block_rows = (
            session.execute(
                text(
                    """
                    SELECT id, block_idx, block_kind,
                           canonical_text,
                           source_start_offset, source_end_offset,
                           locator, selector
                    FROM content_blocks
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    ORDER BY block_idx ASC
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .all()
        )
        previous_end = -1
        for block in block_rows:
            assert block["source_start_offset"] >= previous_end, block
            assert block["source_end_offset"] >= block["source_start_offset"], block
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
                        cc.token_count,
                        es.span_text,
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
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                      AND cc.source_kind = :source_kind
                    GROUP BY cc.id, cc.primary_evidence_span_id, cc.chunk_text,
                             cc.token_count, es.span_text, es.selector, es.citation_label
                    ORDER BY cc.chunk_idx
                    """
                ),
                {"media_id": media_id, "source_kind": source_kind},
            )
            .mappings()
            .all()
        )
        assert chunk_rows, f"media {media_id} had no current chunks"
        for chunk in chunk_rows:
            assert chunk["reconstructed"] == chunk["chunk_text"], chunk
            assert chunk["span_text"] == chunk["chunk_text"], chunk

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
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                      AND cc.source_kind = :source_kind
                    ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                    """
                ),
                {"media_id": media_id, "source_kind": source_kind},
            )
            .mappings()
            .all()
        )
        assert part_rows, f"media {media_id} had no current chunk parts"

    return {
        "media_id": str(media_id),
        "source_kind": source_kind,
        "resolver_kind": resolver_kind,
        "embedding_provider": row["embedding_provider"],
        "embedding_model": row["embedding_model"],
        "embedding_dimensions": row["embedding_dimensions"],
        "block_count": row["block_count"],
        "chunk_count": row["chunk_count"],
        "evidence_count": row["evidence_count"],
        "embedding_count": row["embedding_count"],
        "chunk_ids": [str(chunk["id"]) for chunk in chunk_rows],
        "evidence_span_ids": [str(chunk["primary_evidence_span_id"]) for chunk in chunk_rows],
        "content_blocks": [
            {
                "id": str(block["id"]),
                "block_idx": block["block_idx"],
                "block_kind": block["block_kind"],
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
                        (
                            SELECT count(*)
                            FROM content_blocks
                            WHERE owner_kind = 'media' AND owner_id = :media_id
                        ) AS block_count,
                        (
                            SELECT count(*)
                            FROM content_chunks
                            WHERE owner_kind = 'media' AND owner_id = :media_id
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM content_embeddings ce
                            JOIN content_chunks cc ON cc.id = ce.chunk_id
                            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                        ) AS embedding_count
                    FROM media m
                    JOIN content_index_states mcis ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
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
        assert row["block_count"] > 0, row
        assert row["chunk_count"] == 0, row
        assert row["embedding_count"] == 0, row

        block = (
            session.execute(
                text(
                    """
                    SELECT canonical_text, locator, selector
                    FROM content_blocks
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    ORDER BY block_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        assert block["canonical_text"] == "", block
        assert isinstance(block["locator"], dict) and block["locator"], block
        assert isinstance(block["selector"], dict) and block["selector"], block

    return {
        "media_id": str(media_id),
        "status": row["status"],
        "status_reason": row["status_reason"],
        "block_count": row["block_count"],
        "chunk_count": row["chunk_count"],
        "embedding_count": row["embedding_count"],
    }


def assert_reingest_replacement_trace(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    old_chunk_id: UUID,
    old_evidence_span_id: UUID,
) -> dict:
    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT
                        mcis.status,
                        (
                            SELECT count(*)
                            FROM content_chunks
                            WHERE id = :old_chunk_id
                        ) AS old_chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans
                            WHERE id = :old_evidence_span_id
                        ) AS old_span_count
                    FROM content_index_states mcis
                    WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "old_chunk_id": old_chunk_id,
                    "old_evidence_span_id": old_evidence_span_id,
                },
            )
            .mappings()
            .one()
        )
        assert row["status"] == "ready", row
        assert row["old_chunk_count"] == 0, row
        assert row["old_span_count"] == 0, row

    return {
        "media_id": str(media_id),
        "status": row["status"],
        "old_chunk_id": str(old_chunk_id),
        "old_evidence_span_id": str(old_evidence_span_id),
        "old_artifacts_removed": True,
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
            "kinds": "documents",
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
    # Hybrid retrieval (FTS ∪ vector ANN) is always on; a second request exercises
    # the same path and confirms the indexed chunk is still surfaced.
    semantic_response = auth_client.get(
        "/search",
        params={
            "q": query,
            "scope": f"media:{media_id}",
            "kinds": "documents",
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
    expected_locator_type = {
        "epub": "epub_fragment_offsets",
        "pdf": "pdf_page_geometry",
        "transcript": "transcript_time_range",
        "web": "web_text_offsets",
    }.get(resolver_kind)
    assert expected_locator_type is not None, resolver_kind
    assert result["locator"]["type"] == expected_locator_type, result
    assert result["deep_link"].startswith(f"/media/{media_id}#evidence-"), result

    evidence_span_id = result["evidence_span_ids"][0]
    assert result["deep_link"].endswith(str(evidence_span_id)), result
    resolver_response = auth_client.get(
        f"/media/{media_id}/evidence/{evidence_span_id}",
        headers=headers,
    )
    assert resolver_response.status_code == 200, resolver_response.text
    resolved = resolver_response.json()["data"]
    assert resolved["media_id"] == str(media_id), resolved
    assert resolved["resolver"]["kind"] == resolver_kind, resolved
    if resolver_kind == "pdf":
        assert resolved["resolver"]["status"] == "resolved", resolved
    elif resolver_kind in {"web", "epub", "transcript"}:
        assert resolved["resolver"]["status"] == "resolved", resolved
    else:
        raise AssertionError(f"Unsupported resolver kind {resolver_kind!r}: {resolved}")
    assert query.casefold() in resolved["span_text"].casefold(), resolved

    for legacy_type in ("transcript_chunk",):
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
        "span_text_length": len(resolved["span_text"]),
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
        "exact_length": len(row["exact"]),
        "prefix_length": len(str(row["prefix"] or "")),
        "suffix_length": len(str(row["suffix"] or "")),
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
                    FROM content_index_states mcis
                    JOIN content_blocks cb ON cb.owner_kind = mcis.owner_kind AND cb.owner_id = mcis.owner_id
                    JOIN highlights h ON h.id = :highlight_id
                    JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                    WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
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
        "canonical_text_length": len(block_text),
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
                            FROM content_chunks
                            WHERE owner_kind = 'media' AND owner_id = :media_id
                        ) AS chunk_count,
                        (
                            SELECT count(*)
                            FROM evidence_spans
                            WHERE owner_kind = 'media' AND owner_id = :media_id
                        ) AS evidence_count,
                        mcis.status
                    FROM content_index_states mcis
                    WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
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
    assert row["chunk_count"] > 0, row
    assert row["evidence_count"] > 0, row
    assert row["status"] == "ready", row

    return {
        "media_id": str(media_id),
        "library_id": str(library_id),
        "removed_library_entry_count": row["removed_library_entry_count"],
        "default_intrinsic_count": row["default_intrinsic_count"],
        "media_count": row["media_count"],
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
            "kinds": "documents",
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
                        (SELECT count(*) FROM content_chunks
                            WHERE owner_kind = 'media' AND owner_id = :media_id)
                            AS chunk_count,
                        (SELECT count(*) FROM evidence_spans
                            WHERE owner_kind = 'media' AND owner_id = :media_id)
                            AS evidence_count
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
    assert counts["media_count"] == 0, counts
    assert counts["chunk_count"] == 0, counts
    assert counts["evidence_count"] == 0, counts
    return dict(counts)
