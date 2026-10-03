"""Historical and native effects share persisted account ownership and undo."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from nexus.db.models import AssistantWriteAuthorship, LLMCall, LLMToolPosition
from nexus.services.tool_runtime.catalog import write_tool_ids


class GenerationEffectRefusal(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def undo_generation_position(db: Session, *, viewer_id: UUID, position_id: UUID) -> bool:
    """Undo one completed background write and stamp provenance atomically."""

    from nexus.services.agent_tools.writes import revert_created_refs_in_current_transaction

    try:
        row = db.scalar(
            select(LLMToolPosition)
            .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
            .where(
                LLMToolPosition.id == position_id,
                LLMToolPosition.canonical_tool_id.in_(write_tool_ids()),
                LLMCall.tool_principal_user_id == viewer_id,
                LLMCall.owner_kind != "chat_run",
            )
            .with_for_update()
        )
        if row is None:
            raise GenerationEffectRefusal(404, "write_position_not_found")
        if row.replay_status != "Completed":
            raise GenerationEffectRefusal(409, "operation_in_progress_or_uncertain")
        result = row.result_evidence
        if not isinstance(result, dict) or not isinstance(result.get("tool_result"), dict):
            raise RuntimeError("completed generation position lacks result evidence")
        tool_result = result["tool_result"]
        assert isinstance(tool_result, dict)
        if tool_result.get("type") != "Success":
            raise GenerationEffectRefusal(409, "write_did_not_succeed")
        refs = result.get("created_refs")
        if not isinstance(refs, list) or any(not isinstance(ref, dict) for ref in refs):
            raise RuntimeError("completed generation write lacks created refs")
        if row.reverted_at is not None:
            return False
        revert_created_refs_in_current_transaction(db, viewer_id=viewer_id, refs=refs)
        now = db.scalar(func.clock_timestamp())
        if not isinstance(now, datetime):
            raise RuntimeError("database clock did not return a timestamp")
        row.reverted_at = now
        db.execute(
            update(AssistantWriteAuthorship)
            .where(AssistantWriteAuthorship.tool_position_id == position_id)
            .values(reverted_at=now)
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
    """Read one bounded page of account-owned additive operation positions."""

    base = (
        select(LLMToolPosition)
        .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
        .where(
            LLMCall.tool_principal_user_id == viewer_id,
            LLMCall.owner_kind != "chat_run",
            LLMToolPosition.canonical_tool_id.in_(write_tool_ids()),
        )
    )
    if generation_id is not None:
        base = base.where(LLMToolPosition.generation_id == generation_id)
    if before is not None:
        cursor = db.scalar(base.where(LLMToolPosition.id == before))
        if cursor is None:
            raise GenerationEffectRefusal(404, "effect_cursor_not_found")
        base = base.where(
            or_(
                LLMToolPosition.created_at < cursor.created_at,
                and_(
                    LLMToolPosition.created_at == cursor.created_at,
                    LLMToolPosition.id < cursor.id,
                ),
            )
        )
    rows = db.scalars(
        base.order_by(LLMToolPosition.created_at.desc(), LLMToolPosition.id.desc()).limit(31)
    ).all()
    items: list[dict[str, object]] = []
    for row in rows[:30]:
        evidence = row.result_evidence or {}
        result = evidence.get("tool_result")
        created_refs = evidence.get("created_refs")
        undo_allowed = (
            row.replay_status == "Completed"
            and isinstance(result, dict)
            and result.get("type") == "Success"
            and row.reverted_at is None
        )
        items.append(
            {
                "position_id": str(row.id),
                "generation_id": str(row.generation_id),
                "canonical_id": row.canonical_tool_id,
                "replay_status": row.replay_status,
                "created_at": row.created_at.isoformat(),
                "created_refs": created_refs if isinstance(created_refs, list) else None,
                "result": result if isinstance(result, dict) else None,
                "reverted_at": row.reverted_at.isoformat() if row.reverted_at else None,
                "undo_allowed": undo_allowed,
                "undo_url": f"/generation-effects/{row.id}/undo" if undo_allowed else None,
            }
        )
    return {"items": items, "next_cursor": str(rows[29].id) if len(rows) > 30 else None}
