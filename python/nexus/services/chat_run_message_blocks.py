"""Block rendering for the persisted `message_document` on chat messages."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun


def message_document(role: str, content: str) -> dict[str, object]:
    text_value = content.strip()
    return {
        "type": "message_document",
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
            _retrieval_result_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
    ]
    return document


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
                   mr.created_at,
                   mr.citation_ordinal
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
                "created_at": row[20].isoformat() if row[20] is not None else None,
                "citation_ordinal": row[21],
            }
        )
    return blocks
