"""Worker entrypoint for library-intelligence artifact generation (the reduce)."""

from __future__ import annotations

from uuid import UUID

import httpx
from llm_calling.router import LLMRouter
from sqlalchemy.orm import Session

from nexus.db.models import LibraryIntelligenceArtifactRevision
from nexus.errors import ApiErrorCode
from nexus.schemas.library_intelligence import LibraryIntelligenceDoneEventPayload
from nexus.services import run_kit
from nexus.services.library_intelligence import revision_orm_or_none
from nexus.services.library_intelligence_reduce import run_artifact_generation
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_SPEC = LlmTaskSpec(label="library_intelligence", http_timeout_s=120.0)


def library_intelligence_artifact_generate(revision_id: str) -> dict:
    revision_uuid = UUID(revision_id)

    async def _handler(db: Session, router: LLMRouter, _client: httpx.AsyncClient) -> dict:
        await run_artifact_generation(db, revision_id=revision_uuid, llm=router)
        return {"status": "ok", "revision_id": revision_id}

    def _boundary(db: Session, exc: Exception) -> dict:
        _fail_revision_after_worker_exception(db, exc, revision_id=revision_uuid)
        return {"status": "failed", "revision_id": revision_id}

    return run_llm_task(_SPEC, _handler, on_worker_exception=_boundary)


def _fail_revision_after_worker_exception(
    db: Session, exc: Exception, *, revision_id: UUID
) -> None:
    """Worker-boundary failure write: a nonterminal revision -> ``failed`` + error floor."""

    def write_failure(s: Session, revision: LibraryIntelligenceArtifactRevision) -> None:
        run_kit.mark_terminal(
            s,
            stream=run_kit.library_intelligence_revision_stream(revision),
            status="failed",
            done_payload=LibraryIntelligenceDoneEventPayload(
                status="failed",
                error_code=ApiErrorCode.E_INTERNAL.value,
                revision_id=revision_id,
            ).model_dump(mode="json"),
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_detail=f"{type(exc).__name__}: {exc}"[:1000],
        )

    run_kit.fail_run_after_worker_exception(
        db,
        load_parent=lambda s: revision_orm_or_none(s, revision_id=revision_id),
        is_terminal=lambda revision: revision.status
        in run_kit.terminal_statuses(run_kit.RunStreamKind.LibraryIntelligence),
        write_failure=write_failure,
    )
