"""Worker job handler for one Black Forest Oracle reading."""

from __future__ import annotations

from uuid import UUID

import httpx
from llm_calling.router import LLMRouter
from sqlalchemy.orm import Session

from nexus.db.models import OracleReading
from nexus.logging import get_logger
from nexus.schemas.oracle import oracle_done_payload
from nexus.services import run_kit
from nexus.services.oracle import execute_reading
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_SPEC = LlmTaskSpec(label="oracle_reading")


def oracle_reading_generate(reading_id: str) -> dict:
    reading_uuid = UUID(reading_id)
    logger.info("oracle_reading_started", reading_id=reading_id)

    async def _handler(db: Session, router: LLMRouter, _client: httpx.AsyncClient) -> dict:
        return await execute_reading(db, reading_id=reading_uuid, llm_router=router)

    def _on_worker_exception(db: Session, exc: Exception) -> dict:
        reading, failed_now = run_kit.fail_run_after_worker_exception(
            db,
            load_parent=lambda session: session.get(
                OracleReading, reading_uuid, populate_existing=True
            ),
            is_terminal=lambda r: r.status
            in run_kit.terminal_statuses(run_kit.RunStreamKind.OracleReading),
            write_failure=lambda session, r: run_kit.mark_terminal(
                session,
                stream=run_kit.oracle_reading_stream(r),
                status="failed",
                done_payload=oracle_done_payload(status="failed", error_code="E_INTERNAL"),
                error_code="E_INTERNAL",
                error_detail=f"{type(exc).__name__}: {exc}"[:1000],
            ),
        )
        if reading is None:
            return {"status": "failed", "error_code": "E_NOT_FOUND", "noop": True}
        if not failed_now:
            return {"status": reading.status, "noop": True}
        return {"status": "failed", "error_code": "E_INTERNAL"}

    result = run_llm_task(_SPEC, _handler, on_worker_exception=_on_worker_exception)
    logger.info("oracle_reading_completed", reading_id=reading_id, result=result)
    return result
