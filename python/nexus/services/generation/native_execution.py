"""Native execution identity and finality, independent of model output or replay.

A fresh thread is recorded before submission. Local process exit, timeout and
interrupt acknowledgement are not terminal evidence. An unknown native state
keeps the existing job held; its account queue cannot advance. A bound thread
without an observed turn is unresolved: its previous writer could still submit.
"""

import asyncio
from typing import Literal
from uuid import UUID

from provider_runtime.agent_runtime import (
    AgentRuntimeDefect,
    AgentRuntimeError,
    CodexControl,
    CodexControlError,
    CodexEndpoint,
    CodexThreadTarget,
)
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import LLMCall
from nexus.db.session import get_session_factory, open_control_async_session
from nexus.jobs.queue import JobExecutionContext, JobFailure, lock_running_job_claim
from nexus.logging import get_logger
from nexus.services.generation.contract import Owner
from nexus.services.generation.ledger import lock_open_generation

logger = get_logger(__name__)


class NativeExecution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    profile_key: str
    thread_handle: str
    settled: bool

    @property
    def target(self) -> CodexThreadTarget:
        return CodexThreadTarget(self.profile_key, self.thread_handle)


class NativeFinalityPending(JobFailure):
    def __init__(self) -> None:
        super().__init__(
            "E_NATIVE_FINALITY_UNKNOWN",
            "the previous native execution has not confirmed that it stopped.",
            "hold",
        )


async def bind(owner: Owner, generation_id: UUID, target: CodexThreadTarget) -> None:
    value = NativeExecution(
        profile_key=target.profile_key, thread_handle=target.thread_handle, settled=False
    )
    async with open_control_async_session() as database:

        def write(db: Session) -> None:
            if not lock_open_generation(db, generation_id=generation_id) or (
                lock_running_job_claim(db, context=owner.job) is None
            ):
                raise JobFailure("E_WORKER_INTERRUPTED", "The native job claim was lost.", "hold")
            call = db.get_one(LLMCall, generation_id)
            assert call.native_execution is None, "a generation binds one fresh native thread"
            call.native_execution = value.model_dump(mode="json")

        await database.run_sync(write)
        await database.commit()


def require_settled(db: Session, generation_ids: list[UUID]) -> None:
    for raw in db.scalars(
        select(LLMCall.native_execution).where(
            LLMCall.id.in_(generation_ids), LLMCall.outcome.is_(None)
        )
    ):
        if raw is not None and not NativeExecution.model_validate(raw).settled:
            raise NativeFinalityPending()


def record_settled(generation_id: UUID) -> None:
    with get_session_factory()() as db:
        db.execute(
            text("""UPDATE llm_calls SET native_execution=jsonb_set(native_execution,'{settled}','true')
            WHERE id=:id AND native_execution IS NOT NULL"""),
            {"id": generation_id},
        )
        db.commit()


async def confirm(generation_id: UUID, endpoint: CodexEndpoint) -> bool:
    with get_session_factory()() as db:
        raw = db.scalar(select(LLMCall.native_execution).where(LLMCall.id == generation_id))
    if raw is None:
        return True
    execution = NativeExecution.model_validate(raw)
    if execution.settled:
        return True
    control = CodexControl({execution.profile_key: endpoint}, lambda _: False, native_owners=True)
    try:
        async with asyncio.timeout(15):
            [observed] = await control.inspect((execution.target,))
            if isinstance(observed, CodexControlError):
                return False
            if observed.turn is None:
                return False
            if observed.turn.status == "inProgress":
                if observed.thread.status != "active":
                    return False
                await control.interrupt_conversation(
                    execution.target, observed.turn.target.turn_handle
                )
                [observed] = await control.inspect((execution.target,))
                if isinstance(observed, CodexControlError):
                    return False
            if observed.turn is None or observed.turn.status == "inProgress":
                return False
    except (AgentRuntimeError, AgentRuntimeDefect, TimeoutError) as error:
        logger.warning(
            "native_finality_unavailable",
            generation_id=str(generation_id),
            error=type(error).__name__,
        )
        return False
    finally:
        await control.close()
    record_settled(generation_id)
    return True


def confirm_job(
    job_id: UUID, *, claim: JobExecutionContext | None
) -> Literal["absent", "settled", "pending", "lost"]:
    """Capture exact generations under the current claim, then control outside locks.

    A null claim belongs to source teardown's independent deletion authority.
    A replaced worker cannot discover or interrupt its successor's generations.
    """
    with get_session_factory()() as db:
        if claim is not None:
            assert claim.job_id == job_id
            if lock_running_job_claim(db, context=claim) is None:
                return "lost"
        ids = list(
            db.scalars(
                select(LLMCall.id).where(
                    LLMCall.job_id == job_id,
                    LLMCall.outcome.is_(None),
                    LLMCall.native_execution.is_not(None),
                )
            )
        )
        db.commit()
    if not ids:
        return "absent"

    async def settle() -> bool:
        endpoint = get_settings().codex_endpoint
        for identity in ids:
            if not await confirm(identity, endpoint):
                return False
        return True

    return "settled" if asyncio.run(settle()) else "pending"
