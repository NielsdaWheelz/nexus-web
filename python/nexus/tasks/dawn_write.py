"""Worker task: dawn write sweep — generate a morning brief for each user."""

from __future__ import annotations

from datetime import date
from uuid import UUID

from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import DawnWrite
from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    get_job,
    update_running_job_payload,
)
from nexus.logging import get_logger
from nexus.services.dawn_write import generate_dawn_write
from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_SPEC = LlmTaskSpec(label="dawn_write_sweep")
_WORKLIST_KEY = "dawn_write_worklist"


class _DawnWriteWorkItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    user_id: UUID
    time_zone: str
    local_date: date


_WORKLIST_ADAPTER: TypeAdapter[tuple[_DawnWriteWorkItem, ...]] = TypeAdapter(
    tuple[_DawnWriteWorkItem, ...]
)


def _frozen_worklist(
    db: Session,
    *,
    context: JobExecutionContext,
) -> tuple[_DawnWriteWorkItem, ...]:
    job = get_job(db, context.job_id)
    if job is None or job.kind != "dawn_write_job":
        raise AssertionError("dawn write sweep has no matching job")
    raw = job.payload.get(_WORKLIST_KEY)
    if raw is not None:
        return _WORKLIST_ADAPTER.validate_python(raw)

    rows = db.execute(
        text(
            "SELECT DISTINCT b.user_id, u.calendar_time_zone AS time_zone"
            " FROM daily_page_bindings b"
            " JOIN users u ON u.id = b.user_id"
            " ORDER BY b.user_id"
        )
    ).fetchall()
    items: list[_DawnWriteWorkItem] = []
    for row in rows:
        try:
            local_date = _local_date_for_tz(str(row.time_zone))
        except Exception:
            logger.warning(
                "dawn_write_tz_parse_error",
                user_id=str(row.user_id),
                tz=str(row.time_zone),
            )
            continue
        items.append(
            _DawnWriteWorkItem(
                user_id=UUID(str(row.user_id)),
                time_zone=str(row.time_zone),
                local_date=local_date,
            )
        )
    worklist = tuple(items)
    payload = {
        **job.payload,
        "capacity_wait_index": 0,
        _WORKLIST_KEY: _WORKLIST_ADAPTER.dump_python(worklist, mode="json"),
    }
    if not update_running_job_payload(
        db,
        job_id=context.job_id,
        worker_id=context.worker_id,
        attempt_no=context.attempt_no,
        payload=payload,
    ):
        db.rollback()
        raise AssertionError("dawn write sweep lost its claim while freezing work")
    db.commit()
    return worklist


def _reset_capacity_wait(
    db: Session,
    *,
    context: JobExecutionContext,
) -> None:
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError("dawn write sweep job disappeared")
    if job.payload.get("capacity_wait_index") == 0:
        db.commit()
        return
    if not update_running_job_payload(
        db,
        job_id=context.job_id,
        worker_id=context.worker_id,
        attempt_no=context.attempt_no,
        payload={**job.payload, "capacity_wait_index": 0},
    ):
        db.rollback()
        raise AssertionError("dawn write sweep lost its claim while advancing work")
    db.commit()


def dawn_write_sweep(*, context: JobExecutionContext) -> dict | RescheduleRequested:
    """Generate for the existing population of users with a daily Page binding."""

    async def _handler(db: Session, runtime: ExecutionRuntime) -> dict | RescheduleRequested:
        settings = get_settings()
        if not settings.dawn_write_enabled:
            logger.info("dawn_write_sweep_skipped", reason="disabled")
            return {"skipped": 0, "generated": 0, "already_exists": 0}

        # Freeze both population and account-local date before the first
        # dispatch. Capacity reschedules then replay this exact ordered sweep
        # even if midnight passes or account bindings change meanwhile.
        worklist = _frozen_worklist(db, context=context)

        skipped = 0
        generated = 0
        already_exists = 0

        for item in worklist:
            user_id = item.user_id
            tz = item.time_zone
            local_date = item.local_date

            # Idempotency: skip if a row already exists for this user + date.
            existing = db.scalar(
                select(DawnWrite.id).where(
                    DawnWrite.user_id == user_id,
                    DawnWrite.local_date == local_date,
                )
            )
            if existing is not None:
                already_exists += 1
                _reset_capacity_wait(db, context=context)
                continue

            result = await generate_dawn_write(
                db,
                user_id=user_id,
                local_date=local_date,
                tz=tz,
                context=context,
                runtime=runtime,
            )
            if isinstance(result, RescheduleRequested):
                return result
            if result is not None:
                generated += 1
            else:
                skipped += 1
            _reset_capacity_wait(db, context=context)

        logger.info(
            "dawn_write_sweep_complete",
            generated=generated,
            already_exists=already_exists,
            skipped=skipped,
        )
        return {"generated": generated, "already_exists": already_exists, "skipped": skipped}

    return run_llm_task(_SPEC, _handler)


def _local_date_for_tz(tz_name: str) -> date:
    """Return the current local date in *tz_name*."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(tz=ZoneInfo(tz_name)).date()
