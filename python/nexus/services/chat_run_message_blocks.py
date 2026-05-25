"""Block rendering for the persisted `message_document` on chat messages."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, SourceManifest


def message_document(role: str, content: str) -> dict[str, object]:
    text_value = content.strip()
    return {
        "type": "message_document",
        "version": 1,
        "blocks": []
        if not text_value
        else [
            {
                "type": "text",
                "format": "markdown" if role == "assistant" else "plain",
                "text": content,
            }
        ],
    }


def message_document_with_run_components(
    db: Session,
    *,
    run_id: UUID,
    role: str,
    content: str,
) -> dict[str, object]:
    document = message_document(role, content)
    run = db.get(ChatRun, run_id)
    document["blocks"] = [
        *cast(list[dict[str, object]], document["blocks"]),
        *(
            _verification_summary_blocks_for_message(
                db, assistant_message_id=run.assistant_message_id
            )
            if run is not None
            else []
        ),
        *(
            _citation_audit_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _claim_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _claim_evidence_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _retrieval_result_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *source_manifest_blocks_for_run(db, run_id),
    ]
    return document


def source_manifest_blocks_for_run(db: Session, run_id: UUID) -> list[dict[str, object]]:
    rows = (
        db.execute(
            select(SourceManifest)
            .where(SourceManifest.chat_run_id == run_id)
            .order_by(
                SourceManifest.tool_call_index.asc(),
                SourceManifest.created_at.desc(),
                SourceManifest.id.desc(),
            )
        )
        .scalars()
        .all()
    )
    blocks: list[dict[str, object]] = []
    seen_tool_call_indexes: set[int] = set()
    for manifest in rows:
        if manifest.tool_call_index in seen_tool_call_indexes:
            continue
        seen_tool_call_indexes.add(manifest.tool_call_index)
        blocks.append(
            {
                "type": "source_manifest",
                "assistant_message_id": str(manifest.assistant_message_id),
                "tool_call_id": str(manifest.tool_call_id) if manifest.tool_call_id else None,
                "tool_name": manifest.tool_name,
                "tool_call_index": manifest.tool_call_index,
                "query_hash": manifest.query_hash,
                "scope": manifest.scope,
                "filters": manifest.filters,
                "requested_types": manifest.requested_types,
                "candidate_count": manifest.candidate_count,
                "result_count": manifest.result_count,
                "selected_count": manifest.selected_count,
                "included_in_prompt_count": manifest.included_in_prompt_count,
                "excluded_by_budget_count": manifest.excluded_by_budget_count,
                "excluded_by_scope_count": manifest.excluded_by_scope_count,
                "stale_count": manifest.stale_count,
                "unreadable_count": manifest.unreadable_count,
                "web_search_mode": manifest.web_search_mode,
                "index_versions": manifest.index_versions,
                "metadata": manifest.metadata_json,
                "latency_ms": manifest.latency_ms,
                "status": manifest.status,
            }
        )
    return blocks


def _citation_audit_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    row = db.execute(
        text(
            """
            SELECT id,
                   chat_run_id,
                   verifier_run_id,
                   supported_claim_count,
                   supported_claims_with_valid_offsets_count,
                   supported_claims_with_citation_count,
                   missing_locator_count,
                   missing_source_version_count,
                   supported_claims_have_valid_offsets,
                   supported_claims_have_citation_placement,
                   claim_evidence_has_required_locators,
                   claim_evidence_has_source_versions,
                   details,
                   created_at
            FROM assistant_message_citation_audits
            WHERE message_id = :assistant_message_id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).first()
    if row is None:
        return []
    return [
        {
            "type": "citation_audit",
            "id": str(row[0]),
            "message_id": str(assistant_message_id),
            "chat_run_id": str(row[1]) if row[1] is not None else None,
            "verifier_run_id": str(row[2]) if row[2] is not None else None,
            "supported_claim_count": row[3],
            "supported_claims_with_valid_offsets_count": row[4],
            "supported_claims_with_citation_count": row[5],
            "missing_locator_count": row[6],
            "missing_source_version_count": row[7],
            "supported_claims_have_valid_offsets": row[8],
            "supported_claims_have_citation_placement": row[9],
            "claim_evidence_has_required_locators": row[10],
            "claim_evidence_has_source_versions": row[11],
            "details": row[12],
            "created_at": row[13].isoformat() if row[13] is not None else None,
        }
    ]


def _verification_summary_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    row = db.execute(
        text(
            """
            SELECT id,
                   scope_type,
                   scope_ref,
                   retrieval_status,
                   support_status,
                   verifier_status,
                   verifier_run_id,
                   claim_count,
                   supported_claim_count,
                   unsupported_claim_count,
                   not_enough_evidence_count,
                   prompt_assembly_id,
                   created_at,
                   updated_at
            FROM assistant_message_evidence_summaries
            WHERE message_id = :assistant_message_id
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).first()
    if row is None:
        return []
    return [
        {
            "type": "verification_summary",
            "id": str(row[0]),
            "message_id": str(assistant_message_id),
            "scope_type": row[1],
            "scope_ref": row[2],
            "retrieval_status": row[3],
            "support_status": row[4],
            "verifier_status": row[5],
            "claim_count": row[7],
            "supported_claim_count": row[8],
            "unsupported_claim_count": row[9],
            "not_enough_evidence_count": row[10],
            "prompt_assembly_id": str(row[11]) if row[11] is not None else None,
            "verifier_run_id": str(row[6]) if row[6] is not None else None,
            "created_at": row[12].isoformat() if row[12] is not None else None,
            "updated_at": row[13].isoformat() if row[13] is not None else None,
        }
    ]


def _claim_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT c.id,
                   c.ordinal,
                   c.claim_text,
                   c.answer_start_offset,
                   c.answer_end_offset,
                   c.claim_kind,
                   c.support_status,
                   c.unsupported_reason,
                   c.confidence,
                   c.verifier_status,
                   c.verifier_run_id,
                   c.created_at,
                   COALESCE(array_agg(e.id ORDER BY e.ordinal) FILTER (WHERE e.id IS NOT NULL), '{}')
            FROM assistant_message_claims c
            LEFT JOIN assistant_message_claim_evidence e ON e.claim_id = c.id
            WHERE c.message_id = :assistant_message_id
            GROUP BY c.id
            ORDER BY c.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    return [
        {
            "type": "claim",
            "claim_id": str(row[0]),
            "message_id": str(assistant_message_id),
            "ordinal": row[1],
            "claim_text": row[2],
            "answer_start_offset": row[3],
            "answer_end_offset": row[4],
            "claim_kind": row[5],
            "support_status": row[6],
            "unsupported_reason": row[7],
            "confidence": float(row[8]) if row[8] is not None else None,
            "verifier_status": row[9],
            "created_at": row[11].isoformat() if row[11] is not None else None,
            "evidence_ids": [str(evidence_id) for evidence_id in row[12]],
        }
        for row in rows
    ]


def _claim_evidence_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT e.id,
                   e.claim_id,
                   e.ordinal,
                   e.evidence_role,
                   e.source_ref,
                   e.retrieval_id,
                   e.evidence_span_id,
                   e.context_ref,
                   e.result_ref,
                   e.exact_snippet,
                   e.snippet_prefix,
                   e.snippet_suffix,
                   e.locator,
                   e.deep_link,
                   e.score,
                   e.retrieval_status,
                   e.selected,
                   e.included_in_prompt,
                   e.source_version,
                   e.created_at
            FROM assistant_message_claim_evidence e
            JOIN assistant_message_claims c ON c.id = e.claim_id
            WHERE c.message_id = :assistant_message_id
            ORDER BY c.ordinal ASC, e.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    return [
        {
            "type": "claim_evidence",
            "id": str(row[0]),
            "claim_id": str(row[1]),
            "ordinal": row[2],
            "evidence_role": row[3],
            "source_ref": row[4],
            "retrieval_id": str(row[5]) if row[5] is not None else None,
            "evidence_span_id": str(row[6]) if row[6] is not None else None,
            "context_ref": row[7],
            "result_ref": row[8],
            "exact_snippet": row[9],
            "snippet_prefix": row[10],
            "snippet_suffix": row[11],
            "locator": row[12],
            "deep_link": row[13],
            "score": float(row[14]) if row[14] is not None else None,
            "retrieval_status": row[15],
            "selected": row[16],
            "included_in_prompt": row[17],
            "source_version": row[18],
            "created_at": row[19].isoformat() if row[19] is not None else None,
        }
        for row in rows
    ]


def _retrieval_result_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT mr.id,
                   mr.tool_call_id,
                   mr.ordinal,
                   mr.result_type,
                   mr.source_id,
                   mr.media_id,
                   mr.evidence_span_id,
                   mr.context_ref,
                   mr.result_ref,
                   mr.deep_link,
                   mr.score,
                   mr.selected,
                   mr.source_title,
                   mr.section_label,
                   mr.exact_snippet,
                   mr.snippet_prefix,
                   mr.snippet_suffix,
                   mr.locator,
                   mr.retrieval_status,
                   mr.included_in_prompt,
                   mr.source_version,
                   mr.created_at
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    blocks: list[dict[str, object]] = []
    for row in rows:
        blocks.append(
            {
                "type": "retrieval_result",
                "id": str(row[0]),
                "tool_call_id": str(row[1]),
                "ordinal": row[2],
                "result_type": row[3],
                "source_id": row[4],
                "media_id": str(row[5]) if row[5] is not None else None,
                "evidence_span_id": str(row[6]) if row[6] is not None else None,
                "context_ref": row[7],
                "result_ref": row[8],
                "deep_link": row[9],
                "score": row[10],
                "selected": bool(row[11]),
                "source_title": row[12],
                "section_label": row[13],
                "exact_snippet": row[14],
                "snippet_prefix": row[15],
                "snippet_suffix": row[16],
                "locator": row[17],
                "retrieval_status": row[18],
                "included_in_prompt": bool(row[19]),
                "source_version": row[20],
                "created_at": row[21].isoformat() if row[21] is not None else None,
            }
        )
    return blocks
