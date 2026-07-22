"""Worker job handler for one per-media intelligence unit build."""

from __future__ import annotations

from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from nexus.db.models import MediaSummary
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.services import run_kit
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.media_intelligence import (
    fail_media_unit,
    media_summary_orm_or_none,
    run_media_unit_build,
)
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_SPEC = LlmTaskSpec(label="media_unit_build")


def media_unit_build(media_id: str) -> dict:
    media_uuid = UUID(media_id)

    async def _handler(db: Session, runtime: ExecutionRuntime, _client: httpx.AsyncClient) -> dict:
        status = await run_media_unit_build(db, media_id=media_uuid, runtime=runtime)
        return {"status": status, "media_id": media_id}

    def _boundary(db: Session, exc: Exception) -> dict:
        _fail_unit_after_worker_exception(db, exc, media_id=media_uuid)
        return {"status": "failed", "media_id": media_id}

    return run_llm_task(_SPEC, _handler, on_worker_exception=_boundary)


def _fail_unit_after_worker_exception(db: Session, exc: Exception, *, media_id: UUID) -> None:
    """Worker-boundary failure write: a nonterminal unit head -> ``failed`` + error floor."""

    def write_failure(s: Session, summary: MediaSummary) -> None:
        fail_media_unit(
            s,
            summary_id=summary.id,
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_detail=exception_error_detail(exc),
        )

    run_kit.fail_run_after_worker_exception(
        db,
        load_parent=lambda s: media_summary_orm_or_none(s, media_id=media_id),
        is_terminal=lambda summary: summary.status in ("ready", "failed"),
        write_failure=write_failure,
    )
