"""Worker entrypoints for the artifact engine.

- ``library_dossier_generate`` / ``conversation_distill`` are thin per-kind wrappers
  over the shared ``engine.run_revision`` (D-6).
- ``conversation_distill_sweep`` is the periodic ambient night shift (D-3): enqueue
  a distill for each conversation idle > 7 days with >= 6 complete messages and no
  fresh distillate. Gated by ``DISTILL_ENABLED`` (D-14).
"""

from __future__ import annotations

from uuid import UUID

import httpx
from provider_runtime import ModelRuntime
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ArtifactRevision
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.logging import get_logger
from nexus.schemas.artifact import ArtifactDoneEventPayload
from nexus.services import run_kit
from nexus.services.artifacts import engine
from nexus.services.resource_graph.refs import ResourceRef
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_IDLE_DAYS = 7
_MIN_MESSAGES = 6


def library_dossier_generate(revision_id: str) -> dict:
    return _run_artifact_revision(revision_id, label="library_dossier")


def conversation_distill(revision_id: str) -> dict:
    return _run_artifact_revision(revision_id, label="conversation_distill")


def _run_artifact_revision(revision_id: str, *, label: str) -> dict:
    revision_uuid = UUID(revision_id)
    spec = LlmTaskSpec(label=label, http_timeout_s=120.0)

    async def _handler(db: Session, router: ModelRuntime, _client: httpx.AsyncClient) -> dict:
        await engine.run_revision(db, revision_id=revision_uuid, llm=router)
        return {"status": "ok", "revision_id": revision_id}

    def _boundary(db: Session, exc: Exception) -> dict:
        _fail_revision_after_worker_exception(db, exc, revision_id=revision_uuid)
        return {"status": "failed", "revision_id": revision_id}

    return run_llm_task(spec, _handler, on_worker_exception=_boundary)


def _fail_revision_after_worker_exception(
    db: Session, exc: Exception, *, revision_id: UUID
) -> None:
    def write_failure(s: Session, revision: ArtifactRevision) -> None:
        run_kit.mark_terminal(
            s,
            stream=run_kit.artifact_revision_stream(revision),
            status="failed",
            done_payload=ArtifactDoneEventPayload(
                status="failed",
                error_code=ApiErrorCode.E_INTERNAL.value,
                revision_id=revision_id,
            ).model_dump(mode="json"),
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_detail=exception_error_detail(exc),
        )

    run_kit.fail_run_after_worker_exception(
        db,
        load_parent=lambda s: engine.revision_orm_or_none(s, revision_id=revision_id),
        is_terminal=lambda revision: revision.status
        in run_kit.terminal_statuses(run_kit.RunStreamKind.ArtifactRevision),
        write_failure=write_failure,
    )


def conversation_distill_sweep() -> dict:
    """Periodic sweep: distill each idle conversation with no fresh distillate."""
    settings = get_settings()
    if not settings.distill_enabled:
        logger.info("conversation_distill_sweep_skipped", reason="disabled")
        return {"enqueued": 0, "skipped": 0}

    db = get_session_factory()()
    enqueued = 0
    skipped = 0
    try:
        candidates = db.execute(
            text(
                f"""
                SELECT c.id AS conversation_id, c.owner_user_id AS owner_user_id
                FROM conversations c
                WHERE c.updated_at < now() - interval '{_IDLE_DAYS} days'
                  AND (
                    SELECT count(*) FROM messages m
                    WHERE m.conversation_id = c.id AND m.status = 'complete'
                  ) >= {_MIN_MESSAGES}
                """
            )
        ).fetchall()

        for row in candidates:
            conversation_id = UUID(str(row.conversation_id))
            owner_id = UUID(str(row.owner_user_id))
            subject_ref = ResourceRef(scheme="conversation", id=conversation_id)
            head = (
                db.execute(
                    text(
                        "SELECT id, current_revision_id FROM artifacts "
                        "WHERE subject_scheme = 'conversation' AND subject_id = :cid "
                        "AND kind = 'conversation_distillate'"
                    ),
                    {"cid": conversation_id},
                )
                .mappings()
                .first()
            )
            if head is not None and head["current_revision_id"] is not None:
                if not engine.is_artifact_stale(
                    db,
                    subject_scheme="conversation",
                    subject_id=conversation_id,
                    kind="conversation_distillate",
                    current_revision_id=UUID(str(head["current_revision_id"])),
                ):
                    skipped += 1
                    continue
            live = engine.reducer_for_kind("conversation_distillate").live_fingerprint(
                db, subject_ref, owner_id
            )
            signature = live[0] if live else {}
            key = (
                f"sweep:{signature.get('active_leaf_message_id')}:"
                f"{signature.get('message_count')}"
            )
            engine.create_revision(
                db,
                viewer_id=owner_id,
                subject_ref=subject_ref,
                kind="conversation_distillate",
                idempotency_key=key,
            )
            enqueued += 1
        logger.info("conversation_distill_sweep_complete", enqueued=enqueued, skipped=skipped)
        return {"enqueued": enqueued, "skipped": skipped}
    finally:
        db.close()
