"""One generation's tool authority, its executor, and the one durable row per tool call.

Every call that reaches dispatch writes one ``llm_tool_positions`` row before it
runs and completes it in the same transaction as the handler's domain effects,
so a crash leaves no effect without its row. Nothing is replayed: a repeated
call runs again, and a rerun generation is new work.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID, uuid4

from llm_tools import (
    BudgetState,
    EffectId,
    ExecutionContext,
    InvocationPosition,
    ParsedJson,
    PlanCatalogView,
    PositionState,
    Principal,
    RecoveryRequired,
    ReplayPolicy,
    Reservation,
    RunBudgetState,
    Scope,
    Settlement,
    ToolEffect,
    ToolExecutor,
    ToolId,
    ToolResult,
    canonical_json_bytes,
    raw_input_digest,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.db.models import LLMToolPosition
from nexus.jobs.queue import lock_running_job_claim
from nexus.services.chat.retrievals import RetrievalCitation
from nexus.services.generation.contract import Owner
from nexus.services.generation.ledger import lock_open_generation
from nexus.services.tool_runtime.catalog import FrozenToolOperation

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import RejectedToolArguments, ToolCallResolution

    from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

type ToolExecutionProjection = ChatToolExecutionProjection

type ToolReplayStatus = Literal["Prepared", "Completed"]
type ToolTransportKind = Literal["ProviderApi", "NativeCallback"]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_TRANSPORT_CALL_ID_BYTES = 1_024


class ToolAuthorityRefused(RuntimeError):
    """The generation closed, or its owner or job claim is no longer live."""


@dataclass(frozen=True, slots=True)
class ToolPositionRecord:
    id: UUID
    generation_id: UUID
    generation_seq: int
    position: int
    transport_kind: ToolTransportKind
    model_turn_seq: int
    transport_call_id: str
    canonical_tool_id: str
    canonical_input_digest: str
    tool_contract_revision: str
    plan_revision: str
    binding_revision: str
    result_evidence: dict[str, object] | None
    effect_identity: dict[str, object] | None
    replay_status: ToolReplayStatus
    created_at: datetime
    completed_at: datetime | None
    reverted_at: datetime | None

    @property
    def path(self) -> str:
        return f"generation/{self.generation_seq}/tool/{self.position}"


@dataclass(frozen=True, slots=True)
class ToolModelOutput:
    call_id: str
    output: str = field(repr=False)
    is_error: bool


@dataclass(frozen=True, slots=True)
class ModelToolExecutionResult:
    """The model-facing result plus the call's durable row."""

    model_output: ToolModelOutput
    position: ToolPositionRecord


@dataclass(slots=True)
class ToolAuditProjection:
    """In-process audit view a handler stages for the terminal domain projection."""

    scope: str
    requested_types: list[str] = field(default_factory=list)
    filters: dict[str, Any] = field(default_factory=dict)
    citations: list[RetrievalCitation] = field(default_factory=list)
    selected_citations: list[RetrievalCitation] = field(default_factory=list)
    created_refs: list[dict[str, Any]] = field(default_factory=list)
    provider_request_ids: list[str] = field(default_factory=list)
    search_query_fingerprint: str | None = None
    latency_ms: int | None = None


@dataclass(frozen=True, slots=True)
class ToolAuthority:
    """One open generation's plan, admitted scope and in-memory run budget."""

    session_factory: sessionmaker[Session] = field(repr=False, compare=False)
    owner: Owner
    generation_id: UUID
    generation_seq: int
    operation: FrozenToolOperation = field(repr=False, compare=False)
    transport_kind: ToolTransportKind
    admitted_resource_uris: frozenset[str]
    projection: ToolExecutionProjection | None = field(repr=False, compare=False)
    budgets: RunBudgetState = field(repr=False, compare=False)

    @property
    def user_id(self) -> UUID:
        return self.owner.user_id

    def lock_in_current_transaction(self, db: Session) -> None:
        """Fence one effect transaction: open generation, live owner, live job claim."""

        if not lock_open_generation(db, generation_id=self.generation_id):
            raise ToolAuthorityRefused("generation is closed")
        if self.projection is not None:
            self.projection.lock_owner(db, user_id=self.user_id, owner=self.owner)
        if not lock_running_job_claim(db, context=self.owner.job):
            raise ToolAuthorityRefused("worker lease is absent or expired")

    async def prepare_position(
        self,
        *,
        model_turn_seq: int,
        transport_call_id: str,
        tool_id: ToolId,
        input_digest: str,
        provider_wire_name: str,
        arguments: object,
    ) -> ToolPositionRecord:
        """Write the call's one row, at the next position, before it runs."""

        if not transport_call_id or len(transport_call_id.encode()) > _MAX_TRANSPORT_CALL_ID_BYTES:
            raise ValueError("transport call id must be bounded nonblank text")
        if not _SHA256_RE.fullmatch(input_digest):
            raise ValueError("tool input digest must be lowercase SHA-256")
        try:
            binding = self.operation.plan.catalog_view.binding(tool_id)
        except KeyError as error:
            raise ToolAuthorityRefused("tool is outside the frozen catalogue") from error

        def prepare(db: Session) -> ToolPositionRecord:
            with db.begin():
                self.lock_in_current_transaction(db)
                position = int(
                    db.scalar(
                        select(func.coalesce(func.max(LLMToolPosition.position), 0) + 1).where(
                            LLMToolPosition.generation_id == self.generation_id
                        )
                    )
                    or 1
                )
                position_id = uuid4()
                row = LLMToolPosition(
                    id=position_id,
                    generation_id=self.generation_id,
                    position=position,
                    transport_kind=self.transport_kind,
                    model_turn_seq=model_turn_seq,
                    transport_call_id=transport_call_id,
                    canonical_tool_id=str(tool_id),
                    canonical_input_digest=input_digest,
                    tool_contract_revision=binding.spec.tool_contract_revision,
                    plan_revision=self.operation.plan.plan_revision,
                    binding_revision=binding.policy_revision,
                    arguments={"value": arguments},
                    result_evidence=None,
                    effect_identity=(
                        {
                            "effect_id": str(position_id),
                            "generation_id": str(self.generation_id),
                            "position_path": f"generation/{self.generation_seq}/tool/{position}",
                        }
                        if binding.spec.effect is ToolEffect.Write
                        else None
                    ),
                    replay_status="Prepared",
                )
                db.add(row)
                db.flush()
                record = _position_record(row, generation_seq=self.generation_seq)
                if self.projection is not None:
                    self.projection.stage_started(
                        db,
                        authority=self,
                        position=record,
                        provider_wire_name=provider_wire_name,
                        arguments=arguments
                        if isinstance(arguments, Mapping)
                        else {"invalid_arguments": True},
                    )
                return record

        async with open_async_session(self.session_factory) as database:
            return await database.run_sync(prepare)


class ToolPositionRecorder:
    """The llm-tools recorder over one call's row; budgets live in process memory."""

    def __init__(
        self, *, db: AsyncSession, authority: ToolAuthority, position: ToolPositionRecord
    ) -> None:
        self.database = db
        self.db = db.sync_session
        self.authority = authority
        self.position_record = position
        self.position = InvocationPosition(str(position.id))
        self.catalog_view: PlanCatalogView = authority.operation.plan.catalog_view
        self.max_live_writes = authority.operation.definition.max_live_writes
        self.audit = ToolAuditProjection(scope="conversation_context")
        self.reserved = False

    @property
    def durable(self) -> bool:
        # The one row commits with the handler's effects; nothing is replayed from it.
        return True

    @property
    def principal_id(self) -> UUID:
        return self.authority.user_id

    @property
    def admitted_resource_uris(self) -> frozenset[str]:
        return self.authority.admitted_resource_uris

    def stage_audit(self, audit: ToolAuditProjection) -> None:
        self.audit = audit

    def live_write_count(self, db: Session) -> int:
        projection = self.authority.projection
        if projection is not None:
            return projection.live_write_count(db, authority=self.authority)
        from nexus.services.tool_runtime.catalog import write_tool_ids

        return (
            db.scalar(
                select(func.count(LLMToolPosition.id)).where(
                    LLMToolPosition.generation_id == self.authority.generation_id,
                    LLMToolPosition.canonical_tool_id.in_(write_tool_ids()),
                    LLMToolPosition.replay_status == "Completed",
                    LLMToolPosition.reverted_at.is_(None),
                    LLMToolPosition.result_evidence["tool_result"]["type"].astext == "Success",
                )
            )
            or 0
        )

    def authorize_effect_in_current_transaction(self, db: Session) -> None:
        self.authority.lock_in_current_transaction(db)
        self._lock_row()

    async def occupy(
        self,
        *,
        position: InvocationPosition,
        tool_id: ToolId,
        tool_contract_revision: str,
        policy_revision: str,
        plan_revision: str,
        input_digest: str,
        replay_policy: ReplayPolicy,
    ) -> PositionState:
        del position, tool_id, tool_contract_revision, policy_revision, plan_revision
        del input_digest, replay_policy
        return PositionState(terminal_result=None, uncertain=False, actual_attempts=0)

    async def reserve(
        self, *, position: InvocationPosition, budgets: BudgetState, reservation: Reservation
    ) -> bool:
        self.reserved = await budgets.reserve(position, reservation)
        return self.reserved

    async def dispatch_started(
        self, *, position: InvocationPosition, replay_policy: ReplayPolicy
    ) -> PositionState:
        del position, replay_policy
        return PositionState(terminal_result=None, uncertain=False, actual_attempts=0)

    async def dispatch_abandoned(
        self,
        *,
        position: InvocationPosition,
        replay_policy: ReplayPolicy,
        actual_attempts: int,
        lease_recovered: bool,
    ) -> None:
        raise AssertionError("no tool dispatch is ever re-admitted")

    async def uncertain(self, *, position: InvocationPosition) -> None:
        del position

    async def terminalize_and_settle(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        result: ToolResult,
        settlement: Settlement,
    ) -> ToolResult:
        """Complete the row, its receipt and projection with the handler's effects."""

        if self.reserved:
            await budgets.settle(position, settlement)

        def operation(_db: Session) -> ToolResult:
            evidence: dict[str, object] = {"tool_result": cast(object, result)}
            if self.position_record.effect_identity is not None:
                evidence["created_refs"] = cast(object, self.audit.created_refs)
            try:
                row = self._lock_row()
                row.result_evidence = evidence
                row.replay_status = "Completed"
                row.completed_at = func.now()
                self.db.flush()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if (
                    record.effect_identity is not None
                    and record.canonical_tool_id != "memory.save_note"
                ):
                    # Shared notes have canonical tool receipts, without Nexus resource undo.
                    from nexus.services.generation_effects import (
                        persist_generation_effect_receipt_in_current_transaction,
                    )

                    persist_generation_effect_receipt_in_current_transaction(
                        self.db,
                        principal_user_id=self.authority.user_id,
                        owner=self.authority.owner,
                        position=record,
                    )
                if self.authority.projection is not None:
                    self.authority.projection.stage_terminal(
                        self.db,
                        authority=self.authority,
                        position=record,
                        result=result,
                        audit=self.audit,
                    )
                self.position_record = record
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
            return result

        return await self.database.run_sync(operation)

    async def render_output(self, result: ToolResult) -> str:
        def operation(_db: Session) -> str:
            if self.db.in_transaction():
                raise RuntimeError("tool output rendering requires a committed terminal phase")
            with self.db.begin():
                row = self._lock_row()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status != "Completed":
                    raise AssertionError("model output requires the completed tool row")
                projection = self.authority.projection
                if projection is None:
                    return canonical_json_bytes(result).decode("utf-8")
                return projection.render_output(
                    self.db, authority=self.authority, position=record, result=result
                )

        return await self.database.run_sync(operation)

    def _lock_row(self) -> LLMToolPosition:
        row = self.db.scalar(
            select(LLMToolPosition)
            .where(LLMToolPosition.id == self.position_record.id)
            .with_for_update()
        )
        if row is None:
            raise ToolAuthorityRefused("tool position does not exist")
        return row


class _AuthorityCancellation:
    def __init__(self, authority: ToolAuthority) -> None:
        self._authority = authority
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    async def refresh(self, database: AsyncSession) -> None:
        def check(db: Session) -> None:
            with db.begin():
                self._authority.lock_in_current_transaction(db)

        try:
            await database.run_sync(check)
        except ToolAuthorityRefused:
            self._cancelled = True


class _ToolTelemetry:
    def event(self, name: str, attributes: dict[str, Any]) -> None:
        del name, attributes


@dataclass(frozen=True, slots=True)
class GenerationToolExecutor:
    """Run one model tool call under its generation's authority."""

    authority: ToolAuthority

    async def execute(self, proposal: ToolCallResolution, *, turn: int) -> ToolModelOutput:
        """Run one provider proposal; a malformed or unknown call answers the model."""

        from provider_runtime.tool_adapter import CanonicalToolCall, RejectedToolArguments

        if isinstance(proposal, CanonicalToolCall):
            result = await self.execute_canonical(
                model_turn_seq=turn,
                transport_call_id=proposal.provider_call_id,
                provider_wire_name=str(proposal.tool_id),
                tool_id=proposal.tool_id,
                arguments=proposal.arguments,
            )
            return result.model_output
        if isinstance(proposal, RejectedToolArguments):
            return await self._refuse_arguments(proposal, turn=turn)
        # An unpublished tool name has no canonical row; the model is told and may retry.
        unavailable: ToolResult = {"type": "Failure", "error": {"type": "ToolUnavailable"}}
        return ToolModelOutput(
            call_id=proposal.provider_call_id,
            output=canonical_json_bytes(unavailable).decode("utf-8"),
            is_error=True,
        )

    async def execute_canonical(
        self,
        *,
        model_turn_seq: int,
        transport_call_id: str,
        provider_wire_name: str,
        tool_id: ToolId,
        arguments: Mapping[str, object],
    ) -> ModelToolExecutionResult:
        arguments = json.loads(canonical_json_bytes(dict(arguments)))
        raw = ParsedJson(arguments)
        record = await self.authority.prepare_position(
            model_turn_seq=model_turn_seq,
            transport_call_id=transport_call_id,
            tool_id=tool_id,
            input_digest=raw_input_digest(raw),
            provider_wire_name=provider_wire_name,
            arguments=arguments,
        )
        async with open_async_session(self.authority.session_factory) as db:
            recorder = ToolPositionRecorder(db=db, authority=self.authority, position=record)
            cancellation = _AuthorityCancellation(self.authority)
            await cancellation.refresh(db)
            plan = self.authority.operation.plan
            identity = record.effect_identity
            projection = self.authority.projection
            context = ExecutionContext(
                plan=plan,
                grant=plan.grant(tool_id),
                catalog_view=plan.catalog_view,
                position=recorder.position,
                recorder=recorder,
                effect_id=None if identity is None else EffectId(str(identity["effect_id"])),
                budgets=self.authority.budgets,
                principal=Principal(str(self.authority.user_id)),
                scope=Scope(projection.scope_label if projection else "generation_scope"),
                cancellation=cancellation,
                telemetry=_ToolTelemetry(),
            )
            try:
                result = await ToolExecutor.execute(
                    plan.catalog_view.binding(tool_id), raw, context
                )
            except RecoveryRequired as error:
                if isinstance(error.__cause__, ToolAuthorityRefused):
                    # The fence refused a BilledOnce call: the generation is ending, not broken.
                    raise error.__cause__ from None
                if not isinstance(error.__cause__, TimeoutError):
                    raise
                # A timed-out paid search or write: its effects rolled back with the
                # handler's transaction, so the model is told the call did not finish.
                await db.run_sync(lambda session: session.rollback())
                recorder.audit = ToolAuditProjection(scope=recorder.audit.scope)
                result = await recorder.terminalize_and_settle(
                    position=recorder.position,
                    budgets=self.authority.budgets,
                    result={"type": "Failure", "error": {"type": "DeadlineExceeded"}},
                    settlement=Settlement(actual_attempts=1, actual_output_bytes=0),
                )
            return ModelToolExecutionResult(
                model_output=ToolModelOutput(
                    call_id=transport_call_id,
                    output=await recorder.render_output(result),
                    is_error=result["type"] == "Failure",
                ),
                position=recorder.position_record,
            )

    async def _refuse_arguments(
        self, proposal: RejectedToolArguments, *, turn: int
    ) -> ToolModelOutput:
        reason = proposal.reason
        record = await self.authority.prepare_position(
            model_turn_seq=turn,
            transport_call_id=proposal.provider_call_id,
            tool_id=proposal.tool_id,
            input_digest=hashlib.sha256(
                canonical_json_bytes({"kind": "RejectedToolArguments", "reason": reason})
            ).hexdigest(),
            provider_wire_name=str(proposal.tool_id),
            arguments={"refusal": reason},
        )
        async with open_async_session(self.authority.session_factory) as db:
            recorder = ToolPositionRecorder(db=db, authority=self.authority, position=record)
            result: ToolResult = {
                "type": "Failure",
                "error": {"type": "InvalidInput" if reason == "InvalidJson" else "BudgetExceeded"},
            }
            await recorder.terminalize_and_settle(
                position=recorder.position,
                budgets=self.authority.budgets,
                result=result,
                settlement=Settlement(actual_attempts=0, actual_output_bytes=0),
            )
            return ToolModelOutput(
                call_id=proposal.provider_call_id,
                output=await recorder.render_output(result),
                is_error=True,
            )


def _position_record(row: LLMToolPosition, *, generation_seq: int) -> ToolPositionRecord:
    return ToolPositionRecord(
        id=row.id,
        generation_id=row.generation_id,
        generation_seq=generation_seq,
        position=row.position,
        transport_kind=cast(ToolTransportKind, row.transport_kind),
        model_turn_seq=row.model_turn_seq,
        transport_call_id=row.transport_call_id,
        canonical_tool_id=row.canonical_tool_id,
        canonical_input_digest=row.canonical_input_digest,
        tool_contract_revision=row.tool_contract_revision,
        plan_revision=row.plan_revision,
        binding_revision=row.binding_revision,
        result_evidence=cast(dict[str, object] | None, row.result_evidence),
        effect_identity=cast(dict[str, object] | None, row.effect_identity),
        replay_status=cast(ToolReplayStatus, row.replay_status),
        created_at=row.created_at,
        completed_at=row.completed_at,
        reverted_at=row.reverted_at,
    )
