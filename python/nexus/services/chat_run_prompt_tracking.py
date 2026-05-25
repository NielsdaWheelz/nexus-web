"""Reconcile message_retrievals + emit source_manifest_delta events from a prompt assembly."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent
from nexus.services.chat_run_event_store import append_run_event


def prompt_assembly_metadata(
    db: Session,
    *,
    run_id: UUID,
) -> tuple[str | None, str | None]:
    row = db.execute(
        text(
            """
            SELECT prompt_plan_version, stable_prefix_hash
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run_id},
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


def reconcile_prompt_retrievals(db: Session, *, run: ChatRun, assembly: Any) -> None:
    included_ids = [str(retrieval_id) for retrieval_id in assembly.ledger.included_retrieval_ids]
    dropped_ids = [
        item["key"].split(":", 1)[1]
        for item in assembly.ledger.dropped_items
        if item.get("lane") in {"retrieved_evidence", "web_evidence"}
        and isinstance(item.get("key"), str)
        and ":" in item["key"]
        and item["key"].split(":", 1)[0] in {"retrieved_evidence", "web_evidence"}
    ]
    if included_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = true,
                    retrieval_status = CASE
                        WHEN result_type = 'web_result' THEN 'web_result'
                        ELSE 'included_in_prompt'
                    END
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator,
                    source_version
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       true,
                       'included_in_prompt',
                       'prompt_assembly',
                       result_ref,
                       locator,
                       source_version
                FROM message_retrievals
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
    if dropped_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = false,
                    retrieval_status = 'excluded_by_budget'
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator,
                    source_version
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       false,
                       'excluded_by_budget',
                       'prompt_assembly',
                       result_ref,
                       locator,
                       source_version
                FROM message_retrievals
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )

    existing_manifest_rows = (
        db.execute(
            select(ChatRunEvent.payload)
            .where(
                ChatRunEvent.run_id == run.id,
                ChatRunEvent.event_type == "source_manifest_delta",
            )
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    manifest_payloads: dict[str, dict[str, Any]] = {}
    for payload in existing_manifest_rows:
        if not isinstance(payload, dict):
            continue
        key = str(payload.get("tool_call_id") or payload.get("tool_call_index") or "")
        if key:
            manifest_payloads[key] = payload

    rows = db.execute(
        text(
            """
            SELECT mtc.id,
                   mtc.tool_name,
                   mtc.tool_call_index,
                   mtc.query_hash,
                   mtc.scope,
                   mtc.requested_types,
                   mtc.status,
                   mtc.latency_ms,
                   count(mr.id),
                   count(mr.id) FILTER (WHERE mr.selected),
                   count(mr.id) FILTER (WHERE mr.included_in_prompt),
                   count(mr.id) FILTER (
                       WHERE mr.retrieval_status = 'excluded_by_budget'
                   ),
                   count(mr.id) FILTER (
                       WHERE mr.retrieval_status = 'excluded_by_scope'
                   )
            FROM message_tool_calls mtc
            LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
            WHERE mtc.assistant_message_id = :assistant_message_id
            GROUP BY mtc.id
            ORDER BY mtc.tool_call_index ASC
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    ).fetchall()
    for row in rows:
        manifest_key = str(row[0])
        existing_manifest = manifest_payloads.get(manifest_key) or manifest_payloads.get(
            str(row[2])
        )
        filters = {}
        if existing_manifest is not None and isinstance(existing_manifest.get("filters"), dict):
            filters = existing_manifest["filters"]
        manifest = {
            "assistant_message_id": str(run.assistant_message_id),
            "tool_call_id": str(row[0]),
            "tool_name": row[1],
            "tool_call_index": row[2],
            "query_hash": row[3],
            "scope": row[4],
            "filters": filters,
            "requested_types": row[5] or [],
            "candidate_count": row[8],
            "result_count": row[8],
            "selected_count": row[9],
            "included_in_prompt_count": row[10],
            "excluded_by_budget_count": row[11],
            "excluded_by_scope_count": row[12],
            "stale_count": existing_manifest.get("stale_count", 0)
            if existing_manifest is not None
            else 0,
            "unreadable_count": existing_manifest.get("unreadable_count", 0)
            if existing_manifest is not None
            else 0,
            "latency_ms": row[7],
            "status": row[6],
            "index_versions": [],
            "metadata": {},
        }
        if existing_manifest is not None:
            if "web_search_mode" in existing_manifest:
                manifest["web_search_mode"] = existing_manifest.get("web_search_mode")
            if isinstance(existing_manifest.get("index_versions"), list):
                manifest["index_versions"] = existing_manifest["index_versions"]
            if isinstance(existing_manifest.get("metadata"), dict):
                manifest["metadata"] = existing_manifest["metadata"]
        append_run_event(
            db,
            run,
            "source_manifest_delta",
            manifest,
        )
