"""Write-of-truth for chat_run_events: durable append plus run-state transitions."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.coerce import parse_uuid
from nexus.db.models import ChatRun, ChatRunEvent, SourceManifest
from nexus.schemas.conversation import chat_run_event_payload_json

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    seq = run.next_event_seq
    payload = chat_run_event_payload_json(event_type, payload)
    db.add(ChatRunEvent(run_id=run.id, seq=seq, event_type=event_type, payload=payload))
    if event_type == "source_manifest_delta":
        _persist_source_manifest_delta(db, run=run, payload=payload)
    run.next_event_seq = seq + 1
    run.updated_at = datetime.now(UTC)
    db.flush()


def append_and_commit(db: Session, run_id: UUID, event_type: str, payload: dict[str, Any]) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    append_run_event(db, run, event_type, payload)
    db.commit()


def mark_running(db: Session, run_id: UUID) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status == "queued":
        run.status = "running"
        run.started_at = run.started_at or datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
    db.commit()


def is_cancel_requested(db: Session, run_id: UUID) -> bool:
    run = db.get(ChatRun, run_id)
    return run is not None and run.cancel_requested_at is not None


def has_delta_without_terminal(db: Session, run_id: UUID) -> bool:
    rows = db.execute(
        text(
            """
            SELECT event_type
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('delta', 'done')
            """
        ),
        {"run_id": run_id},
    ).fetchall()
    event_types = {row[0] for row in rows}
    return "delta" in event_types and "done" not in event_types


def _persist_source_manifest_delta(
    db: Session,
    *,
    run: ChatRun,
    payload: dict[str, Any],
) -> None:
    assistant_message_id = UUID(str(payload["assistant_message_id"]))
    tool_call_index = int(payload["tool_call_index"])
    tool_call_id = parse_uuid(payload.get("tool_call_id"))
    latency_ms = payload["latency_ms"]
    manifest = (
        db.execute(
            select(SourceManifest)
            .where(
                SourceManifest.chat_run_id == run.id,
                SourceManifest.tool_call_index == tool_call_index,
            )
            .order_by(SourceManifest.created_at.desc(), SourceManifest.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if manifest is None:
        manifest = SourceManifest(
            conversation_id=run.conversation_id,
            assistant_message_id=assistant_message_id,
            chat_run_id=run.id,
            tool_call_id=tool_call_id,
            tool_call_index=tool_call_index,
            tool_name=str(payload["tool_name"]),
        )
        db.add(manifest)
    manifest.conversation_id = run.conversation_id
    manifest.assistant_message_id = assistant_message_id
    manifest.chat_run_id = run.id
    manifest.tool_call_id = tool_call_id
    manifest.tool_call_index = tool_call_index
    manifest.tool_name = str(payload["tool_name"])
    manifest.query_hash = payload["query_hash"]
    manifest.scope = str(payload["scope"])
    manifest.filters = dict(payload["filters"])
    manifest.requested_types = list(payload["requested_types"])
    manifest.candidate_count = int(payload["candidate_count"])
    manifest.result_count = int(payload["result_count"])
    manifest.selected_count = int(payload["selected_count"])
    manifest.included_in_prompt_count = int(payload["included_in_prompt_count"])
    manifest.excluded_by_budget_count = int(payload["excluded_by_budget_count"])
    manifest.excluded_by_scope_count = int(payload["excluded_by_scope_count"])
    manifest.stale_count = int(payload["stale_count"])
    manifest.unreadable_count = int(payload["unreadable_count"])
    manifest.index_versions = list(payload["index_versions"])
    manifest.metadata_json = dict(payload["metadata"])
    manifest.latency_ms = latency_ms if isinstance(latency_ms, int) else None
    manifest.status = str(payload["status"])
    manifest.updated_at = datetime.now(UTC)
