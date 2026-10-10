"""Completed assistant-write receipts, account inspection, and atomic undo."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, cast
from uuid import UUID

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from nexus.db.models import (
    AssistantWriteAuthorship,
    GenerationEffectReceipt,
    LLMToolPosition,
    MessageToolCall,
)
from nexus.services.tool_runtime.catalog import write_tool_ids

if TYPE_CHECKING:
    from nexus.services.generation.contract import Owner
    from nexus.services.tool_authority import ToolPositionRecord


class GenerationEffectRefusal(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def persist_generation_effect_receipt_in_current_transaction(
    db: Session,
    *,
    principal_user_id: UUID,
    owner: Owner,
    position: ToolPositionRecord,
) -> None:
    """Stage the original completed write and its successful target authorship."""

    from nexus.services.assistant_write_authorship import persist_assistant_write_authorships

    evidence = position.result_evidence
    if (
        position.replay_status != "Completed"
        or position.completed_at is None
        or position.canonical_tool_id not in write_tool_ids()
        or position.effect_identity
        != {
            "effect_id": str(position.id),
            "generation_id": str(position.generation_id),
            "position_path": position.path,
        }
        or evidence is None
    ):
        raise AssertionError("effect receipt requires the exact completed write position")
    result = evidence.get("tool_result")
    refs = evidence.get("created_refs")
    if (
        not isinstance(result, dict)
        or result.get("type") not in {"Success", "Failure"}
        or not isinstance(refs, list)
        or any(not isinstance(ref, dict) for ref in refs)
        or (result["type"] == "Failure" and refs)
    ):
        raise AssertionError("completed write lacks its closed result and created refs")
    facts: dict[str, object] = {
        "id": position.id,
        "principal_user_id": principal_user_id,
        "owner_kind": owner.kind,
        "owner_id": owner.id,
        "generation_id": position.generation_id,
        "generation_seq": position.generation_seq,
        "tool_position": position.position,
        "canonical_tool_id": position.canonical_tool_id,
        "effect_identity": position.effect_identity,
        "result_evidence": evidence,
        "created_at": position.created_at,
        "completed_at": position.completed_at,
        "reverted_at": position.reverted_at,
    }
    receipt = db.get(GenerationEffectReceipt, position.id)
    if receipt is None:
        db.add(GenerationEffectReceipt(**facts))
        db.flush()
    elif any(getattr(receipt, name) != value for name, value in facts.items()):
        raise AssertionError("completed effect receipt changed its original facts")
    if result["type"] == "Success":
        persist_assistant_write_authorships(
            db,
            position=position,
            created_refs=cast(list[dict[str, object]], refs),
        )


def undo_generation_position(db: Session, *, viewer_id: UUID, position_id: UUID) -> bool:
    """Undo one account-owned success and stamp every extant projection once."""

    from nexus.services.agent_tools.writes import revert_created_refs_in_current_transaction

    try:
        row = db.scalar(
            select(GenerationEffectReceipt)
            .where(
                GenerationEffectReceipt.id == position_id,
                GenerationEffectReceipt.principal_user_id == viewer_id,
            )
            .with_for_update()
        )
        if row is None:
            raise GenerationEffectRefusal(404, "write_position_not_found")
        result = row.result_evidence
        tool_result = result.get("tool_result")
        if not isinstance(tool_result, dict):
            raise AssertionError("completed effect receipt lacks its original result")
        if tool_result.get("type") != "Success":
            raise GenerationEffectRefusal(409, "write_did_not_succeed")
        refs = result.get("created_refs")
        if not isinstance(refs, list) or any(not isinstance(ref, dict) for ref in refs):
            raise AssertionError("completed effect receipt lacks original created refs")
        if not refs:
            raise GenerationEffectRefusal(409, "write_created_no_items")
        if row.reverted_at is not None:
            db.commit()
            return False
        revert_created_refs_in_current_transaction(
            db, viewer_id=viewer_id, refs=cast(list[dict[str, object]], refs)
        )
        now = db.scalar(func.clock_timestamp())
        if not isinstance(now, datetime):
            raise AssertionError("database clock did not return a timestamp")
        row.reverted_at = now
        db.execute(
            update(AssistantWriteAuthorship)
            .where(AssistantWriteAuthorship.tool_position_id == position_id)
            .values(reverted_at=now)
        )
        db.execute(
            update(LLMToolPosition).where(LLMToolPosition.id == position_id).values(reverted_at=now)
        )
        db.execute(
            update(MessageToolCall)
            .where(MessageToolCall.tool_position_id == position_id)
            .values(reverted_at=now, updated_at=now)
        )
        db.commit()
        return True
    except BaseException:
        db.rollback()
        raise


def list_generation_effects(
    db: Session,
    *,
    viewer_id: UUID,
    generation_id: UUID | None = None,
    before: UUID | None = None,
) -> dict[str, object]:
    """Read one bounded page of all account-owned completed assistant writes."""

    base = select(GenerationEffectReceipt).where(
        GenerationEffectReceipt.principal_user_id == viewer_id
    )
    if generation_id is not None:
        base = base.where(GenerationEffectReceipt.generation_id == generation_id)
    if before is not None:
        cursor = db.scalar(base.where(GenerationEffectReceipt.id == before))
        if cursor is None:
            raise GenerationEffectRefusal(404, "effect_cursor_not_found")
        base = base.where(
            or_(
                GenerationEffectReceipt.created_at < cursor.created_at,
                and_(
                    GenerationEffectReceipt.created_at == cursor.created_at,
                    GenerationEffectReceipt.id < cursor.id,
                ),
            )
        )
    rows = db.scalars(
        base.order_by(
            GenerationEffectReceipt.created_at.desc(), GenerationEffectReceipt.id.desc()
        ).limit(31)
    ).all()
    items: list[dict[str, object]] = []
    for row in rows[:30]:
        result = row.result_evidence["tool_result"]
        assert isinstance(result, dict)
        undo_allowed = (
            result["type"] == "Success"
            and bool(row.result_evidence["created_refs"])
            and row.reverted_at is None
        )
        items.append(
            {
                "position_id": str(row.id),
                "generation_id": str(row.generation_id),
                "canonical_id": row.canonical_tool_id,
                "replay_status": "Completed",
                "created_at": row.created_at.isoformat(),
                "created_refs": row.result_evidence["created_refs"],
                "result": result,
                "reverted_at": row.reverted_at.isoformat() if row.reverted_at else None,
                "undo_allowed": undo_allowed,
                "undo_url": f"/generation-effects/{row.id}/undo" if undo_allowed else None,
            }
        )
    return {"items": items, "next_cursor": str(rows[29].id) if len(rows) > 30 else None}
