"""Incarnation-bound native execution, closure evidence and owner-scoped recovery.

Binding precedes submission. Only provider evidence or the host's permanent
retirement proof permits settlement; unknown state retains the existing job.
Reconciliation never reconstructs a prompt or changes product outcomes.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Annotated, Literal
from uuid import UUID

from provider_runtime.agent_runtime import (
    AgentRuntimeDefect,
    AgentRuntimeError,
    CodexControl,
    CodexControlError,
    CodexThreadTarget,
    CredentialRejected,
    CredentialUnavailable,
    InvalidAgentRequest,
)
from provider_runtime.agent_runtime.codex_host import (
    CodexHostEndpoint,
    CodexHostRetired,
    CodexHostTarget,
    CodexHostUnavailable,
    resolve_codex_host,
    retire_codex_host,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.engine import async_database_scope
from nexus.db.models import LLMCall
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, open_control_async_session
from nexus.jobs import queue
from nexus.jobs.registry import registry, resolve
from nexus.logging import get_logger
from nexus.services.generation.contract import Owner
from nexus.services.generation.ledger import lock_job_generations, lock_open_generation

logger = get_logger(__name__)
RECOVERY_CODE = "E_NATIVE_FINALITY_UNKNOWN"


class NativeBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    profile_key: str = Field(min_length=1)
    thread_handle: str = Field(min_length=1)
    target: CodexHostTarget

    @property
    def thread(self) -> CodexThreadTarget:
        return CodexThreadTarget(self.profile_key, self.thread_handle)


class NativeTerminalClosure(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    kind: Literal["terminal"] = "terminal"
    turn_handle: str = Field(min_length=1)
    status: Literal["completed", "failed", "interrupted"]


class NotSubmittedClosure(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    kind: Literal["not_submitted"] = "not_submitted"


class RetiredClosure(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    kind: Literal["retired"] = "retired"
    target: CodexHostTarget


type Closure = Annotated[
    NativeTerminalClosure | NotSubmittedClosure | RetiredClosure, Field(discriminator="kind")
]


class NativeExecution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    binding: NativeBinding
    closure: Closure | None

    @model_validator(mode="after")
    def _target(self) -> NativeExecution:
        if isinstance(self.closure, RetiredClosure) and self.closure.target != self.binding.target:
            raise ValueError("native retirement differs from its binding")
        return self


@dataclass(frozen=True)
class _NativeCall:
    generation_id: UUID
    execution: NativeExecution


class NativeFinalityPending(queue.JobFailure):
    def __init__(self, reason: str = "closure_not_observed", *, hold: bool = False) -> None:
        self.reason = reason
        super().__init__(
            RECOVERY_CODE,
            f"native execution closure is unresolved: {reason}",
            "hold" if hold else "bounded_retry",
        )


def _execution(raw: dict[str, object]) -> NativeExecution:
    try:
        return NativeExecution.model_validate_json(json.dumps(raw))
    except ValidationError as error:
        raise NativeFinalityPending("invalid_state", hold=True) from error


async def bind(owner: Owner, generation_id: UUID, binding: NativeBinding) -> None:
    value = NativeExecution(binding=binding, closure=None)
    async with open_control_async_session() as database:

        def write(db: Session) -> None:
            if not lock_open_generation(db, generation_id=generation_id) or (
                queue.lock_running_job_claim(db, context=owner.job) is None
            ):
                raise queue.JobFailure(
                    "E_WORKER_INTERRUPTED", "The native job claim was lost.", "hold"
                )
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
        if raw is not None and _execution(raw).closure is None:
            raise NativeFinalityPending()


async def record_closure(generation_id: UUID, binding: NativeBinding, closure: Closure) -> None:
    """Record proof against its exact binding; a late observer cannot reopen history."""
    value = NativeExecution(binding=binding, closure=closure)
    async with open_control_async_session() as database:

        def write(db: Session) -> None:
            call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
            if call is None:
                return
            raw = call.native_execution
            if call.outcome is not None:
                archived = None if call.terminal is None else call.terminal.get("native_execution")
                assert isinstance(archived, dict), "closed native generation lost its binding"
                assert _execution(archived).binding == binding, "native closure changed binding"
                return
            assert raw is not None and _execution(raw).binding == binding, (
                "native closure changed binding"
            )
            if _execution(raw).closure is None:
                call.native_execution = value.model_dump(mode="json")

        await database.run_sync(write)
        await database.commit()


def _capture(db: Session, ids: list[UUID]) -> list[_NativeCall]:
    """Read bindings after their owner locked this exact generation set."""
    return [
        _NativeCall(call.id, _execution(call.native_execution))
        for call in db.scalars(
            select(LLMCall)
            .where(LLMCall.id.in_(ids), LLMCall.outcome.is_(None))
            .order_by(LLMCall.id)
        )
        if call.native_execution is not None
    ]


async def _confirm(calls: list[_NativeCall], host: CodexHostEndpoint) -> None:
    deadline = asyncio.get_running_loop().time() + 15
    for call in calls:
        if call.execution.closure is not None:
            continue
        binding = call.execution.binding
        try:
            async with asyncio.timeout_at(deadline):
                resolved = await resolve_codex_host(host, binding.target)
            if isinstance(resolved, CodexHostRetired):
                await record_closure(
                    call.generation_id, binding, RetiredClosure(target=resolved.target)
                )
                continue
            if isinstance(resolved, CodexHostUnavailable):
                raise NativeFinalityPending(
                    resolved.reason,
                    hold=resolved.reason not in {"starting", "retiring", "unreachable"},
                )
            control = CodexControl(
                {binding.profile_key: resolved.endpoint}, lambda _: False, native_owners=True
            )
            observed = None
            try:
                async with asyncio.timeout_at(deadline):
                    [observed] = await control.inspect((binding.thread,))
                    if not isinstance(observed, CodexControlError) and observed.turn is not None:
                        if (
                            observed.turn.status == "inProgress"
                            and observed.thread.status == "active"
                        ):
                            await control.interrupt_conversation(
                                binding.thread, observed.turn.target.turn_handle
                            )
                            [observed] = await control.inspect((binding.thread,))
            except (CredentialRejected, CredentialUnavailable, InvalidAgentRequest):
                raise
            except CodexControlError as error:
                observed = error
            except (AgentRuntimeError, TimeoutError):
                observed = None
            finally:
                await control.close()
            if isinstance(observed, CodexControlError) and observed.code not in {
                "missing",
                "busy",
                "stale",
                "unavailable",
            }:
                raise NativeFinalityPending(f"native_control_{observed.code}", hold=True)
            if (
                observed is not None
                and not isinstance(observed, CodexControlError)
                and observed.turn is not None
                and observed.turn.status != "inProgress"
            ):
                await record_closure(
                    call.generation_id,
                    binding,
                    NativeTerminalClosure(
                        turn_handle=observed.turn.target.turn_handle, status=observed.turn.status
                    ),
                )
                continue
            if not resolved.retirement_allowed:
                raise NativeFinalityPending("retirement_disabled", hold=True)
            retired = await retire_codex_host(host, binding.target)
            if isinstance(retired, CodexHostRetired):
                await record_closure(
                    call.generation_id, binding, RetiredClosure(target=retired.target)
                )
                continue
            raise NativeFinalityPending(
                retired.reason, hold=retired.reason not in {"starting", "retiring", "unreachable"}
            )
        except TimeoutError as error:
            raise NativeFinalityPending("unreachable") from error
        except (CredentialRejected, CredentialUnavailable) as error:
            raise NativeFinalityPending("credentials_rejected", hold=True) from error
        except InvalidAgentRequest as error:
            raise NativeFinalityPending("invalid_state", hold=True) from error
        except AgentRuntimeDefect as error:
            logger.error(
                "native_control_defect",
                generation_id=str(call.generation_id),
                error=type(error).__name__,
            )
            raise NativeFinalityPending("protocol_defect", hold=True) from error


async def confirm_generation(
    generation_id: UUID, context: queue.JobExecutionContext, host: CodexHostEndpoint
) -> bool:
    async with open_control_async_session() as database:

        def read(db: Session) -> list[_NativeCall] | None:
            ids = list(
                db.scalars(
                    select(LLMCall.id)
                    .where(
                        LLMCall.id == generation_id,
                        LLMCall.job_id == context.job_id,
                        LLMCall.outcome.is_(None),
                    )
                    .with_for_update()
                )
            )
            if queue.lock_running_job_claim(db, context=context) is None:
                return None
            return _capture(db, ids)

        calls = await database.run_sync(read)
        await database.commit()
    if calls is None:
        return False
    await _confirm(calls, host)
    return True


def _confirm_sync(calls: list[_NativeCall]) -> None:
    async def work() -> None:
        async with async_database_scope():
            await _confirm(calls, get_settings().codex_host)

    asyncio.run(work())


def confirm_job(context: queue.JobExecutionContext) -> bool:
    """Current worker authority; capture before external control, settle afterward."""
    with get_session_factory()() as db:
        ids = lock_job_generations(db, job_id=context.job_id)
        job = queue.get_job(db, context.job_id)
        if job is not None and (owner_lock := registry()[job.kind].lock_owner) is not None:
            resolve(owner_lock)(db, job)
        if queue.lock_running_job_claim(db, context=context) is None:
            return False
        calls = _capture(db, ids)
        db.commit()
    _confirm_sync(calls)
    return True


def confirm_deletion(context: queue.JobExecutionContext) -> bool:
    """A teardown owns only dependencies of its still-current retained intent."""
    from nexus.services.media_deletion import capture_native_generations

    with get_session_factory()() as db:

        def read() -> list[_NativeCall] | None:
            job = queue.get_job(db, context.job_id)
            if job is None:
                return None
            assert job.kind == "media_teardown"
            ids = capture_native_generations(db, job.payload)
            if queue.lock_running_job_claim(db, context=context) is None:
                return None
            return _capture(db, ids or [])

        calls = retry_serializable(db, "native.capture_deletion", read)
    if calls is None:
        return False
    _confirm_sync(calls)
    return True


def repair(job_id: UUID) -> dict[str, object]:
    """Maintenance repair of one native hold; never an inference or generic requeue."""
    from nexus.services.media_deletion import capture_native_generations

    result: dict[str, object] = {
        "status": "obsolete",
        "job_id": str(job_id),
        "executions": None,
        "reason": None,
        "affected_open_generations": None,
    }
    with get_session_factory()() as db:

        def read() -> tuple[queue.JobRow | None, list[_NativeCall] | None]:
            job = queue.get_job(db, job_id)
            if job is None or job.status != "held" or job.error_code != RECOVERY_CODE:
                return job, None
            if job.kind == "media_teardown":
                ids = capture_native_generations(db, job.payload)
                if ids is None:
                    return job, None
            else:
                ids = lock_job_generations(db, job_id=job_id)
                match job.kind:
                    case "chat_run":
                        from nexus.services.chat import events

                        run = events.lock_run(db, UUID(job.payload["run_id"]))
                        current_intent = run is not None and run.status in {"queued", "running"}
                    case "suggestion_shortlist_refresh":
                        from nexus.services import suggestion_shortlists

                        current_intent = suggestion_shortlists.lock_native_repair_intent(db, job)
                    case "enrich_metadata":
                        from nexus.tasks import enrich_metadata

                        current_intent = enrich_metadata.lock_native_repair_intent(db, job)
                    case "media_unit_build":
                        from nexus.tasks import media_unit_build

                        current_intent = media_unit_build.lock_native_repair_intent(db, job)
                    case "discover_document_parts":
                        from nexus.services import part_discovery

                        current_intent = part_discovery.lock_native_repair_intent(db, job)
                    case "connection_discovery_scan":
                        from nexus.services import connection_discovery

                        current_intent = connection_discovery.lock_native_repair_intent(db, job)
                    case "oracle_reading_generate":
                        from nexus.services.oracle import readings

                        current_intent = readings.lock_native_repair_intent(db, job)
                    case _:
                        raise NativeFinalityPending("invalid_state", hold=True)
                if not current_intent:
                    return job, None
            db.execute(
                text("SELECT id FROM background_jobs WHERE id=:id FOR UPDATE"), {"id": job_id}
            )
            current = queue.get_job(db, job_id)
            if current != job:
                return current, None
            return job, _capture(db, ids)

        try:
            job, calls = retry_serializable(db, "native.capture_repair", read)
        except NativeFinalityPending as error:
            result.update(status="still_held", reason=error.reason)
            return result
        if job is None or job.status in {"succeeded", "dead"}:
            return result
        if job.status != "held":
            result["status"] = "not_held"
            return result
        if job.error_code != RECOVERY_CODE:
            result.update(status="still_held", reason="not_native_recovery")
            return result
        if calls is None:
            return result
        result["executions"] = [
            {
                "generation_id": str(call.generation_id),
                "binding": call.execution.binding.model_dump(mode="json"),
            }
            for call in calls
        ]
        targets = [call.execution.binding.target.model_dump(mode="json") for call in calls]
        result["affected_open_generations"] = (
            db.scalar(
                select(func.count())
                .select_from(LLMCall)
                .where(
                    LLMCall.outcome.is_(None),
                    LLMCall.native_execution["binding"]["target"].in_(targets),
                )
            )
            if targets
            else 0
        )
        db.rollback()
        try:
            _confirm_sync(calls)
        except NativeFinalityPending as error:
            result.update(status="still_held", reason=error.reason)
            return result

        def resume() -> tuple[str, str | None]:
            current, remaining = read()
            if current is None or current.status in {"succeeded", "dead"}:
                return "obsolete", None
            if current.status != "held":
                return "not_held", None
            if current.error_code != RECOVERY_CODE:
                return "still_held", "not_native_recovery"
            if (
                remaining is None
                or current.execution_id != job.execution_id
                or current.payload != job.payload
            ):
                return "obsolete", None
            require_settled(db, [call.generation_id for call in remaining])
            return ("resumed" if queue.resume_held_job(db, job_id=job_id) else "not_held"), None

        try:
            result["status"], result["reason"] = retry_serializable(
                db, "native.resume_repair", resume
            )
        except NativeFinalityPending as error:
            result.update(status="still_held", reason=error.reason)
        return result
