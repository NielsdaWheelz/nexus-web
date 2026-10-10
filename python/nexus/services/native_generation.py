"""Native supervision over Nexus's generation, tool and job journals."""

from __future__ import annotations

import asyncio
import tempfile
from collections.abc import Mapping
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID

from llm_agent_kernel.cancellation import CancellationToken
from llm_agent_kernel.coordination import NoNewInput, Preempt
from llm_agent_kernel.definitions import (
    AgentRole,
    Checkpoint,
    DispatchCompleted,
    HostRef,
    InputId,
    NativeDispatchLineage,
    OwnerPermit,
    OwnerToken,
    ProviderConfiguration,
    ToolDispatchLineage,
)
from llm_agent_kernel.native import run_native
from llm_agent_kernel.native_contract import (
    InvocationRecord,
    NativeDefect,
    NativeDefinition,
    NativeDelivery,
    NativeInvocationProposal,
    NativeRecovery,
    NativeRejected,
    NativeReply,
    NativeRequest,
    NativeUncertain,
)
from llm_agent_kernel.provider import CodexProvider
from llm_tools import (
    BudgetState,
    FrozenToolPlan,
    ParsedJson,
    PromptSection,
    PromptSectionKind,
    PromptSections,
    PromptText,
    RunBudgetState,
    ToolBinding,
    ToolEffect,
    ToolResult,
    raw_input_digest,
)
from provider_runtime.agent_runtime import (
    AgentAccepted,
    AgentAttempt,
    AgentControlReceipt,
    AgentInputRecorded,
    AgentMessage,
    AgentNotSubmitted,
    AgentRuntime,
    AgentRuntimeConfig,
    AgentSubmission,
    AgentTerminal,
    AgentTurnRef,
    AgentUncertain,
    CredentialRef,
    JsonObject,
    JsonSchemaAgentOutput,
    LocalStopEvidence,
    NativeTerminalEvidence,
    TextAgentOutput,
    attempt_from_json,
    attempt_to_json,
    submission_from_json,
    submission_to_json,
    terminal_from_json,
    terminal_to_json,
    thaw_json_value,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.db.models import ChatRun, LLMModelTurn, LLMToolPosition
from nexus.jobs.queue import lock_running_job_claim
from nexus.schemas.presence import Present, absent
from nexus.services.generation_backend import (
    BackendChildCompletion,
    BackendChildDispatch,
    BackendChildLifecycle,
    BackendTerminal,
    BackendTextDelta,
    BackendToolObserved,
    CodexTerminalEvidence,
    ObserveEvent,
)
from nexus.services.generation_spec import CodexDispatchTargetSnapshot, StrictJsonOutputSnapshot
from nexus.services.generation_terminal import GenerationToolUse
from nexus.services.llm_ledger import (
    ModelTurnCompletion,
    complete_model_turn_in_current_transaction,
    generation_evidence_contains_nul,
    lock_generation_owner_in_current_transaction,
)
from nexus.services.tool_authority import (
    DeferredGenerationToolExecutor,
    GenerationToolExecutor,
    ToolAuthority,
    ToolAuthorityRefused,
    require_native_turn_in_current_transaction,
)
from nexus.services.tool_runtime.catalog import (
    ComposedToolRuntime,
    FrozenToolOperation,
    freeze_tool_plan_snapshot,
)

if TYPE_CHECKING:
    from nexus.services.llm_execution import CancellationSignal, GenerationExecutionRequest


class NativeGenerationBackend:
    def __init__(self, socket_path: Path, tools: ComposedToolRuntime) -> None:
        self._socket_path = socket_path
        self._tools = tools

    async def execute(
        self,
        request: GenerationExecutionRequest,
        *,
        session_factory: sessionmaker[Session],
        lifecycle: BackendChildLifecycle,
        observe: ObserveEvent,
        cancellation: CancellationSignal,
    ) -> BackendTerminal | AgentNotSubmitted:
        from nexus.services.llm_execution import generation_has_local_recovery, model_turn_id

        spec = request.spec
        attempt_id = str(model_turn_id(request.generation_id, 1))
        permit = OwnerPermit(
            str(request.journal.context.job_id),
            OwnerToken(str(request.journal.context.execution_id)),
            str(request.generation_id),
            None,
        )
        owner = _NexusOwner(request, session_factory)
        completion = None
        with session_factory() as db:
            previous = db.get(LLMModelTurn, UUID(attempt_id))
            if previous is not None:
                state = request.journal.read(db)
                if (
                    state is None
                    or state.generation_id != request.generation_id
                    or not isinstance(state.request_fingerprint, Present)
                    or state.request_fingerprint.value != spec.fingerprint
                    or not generation_has_local_recovery(db, state)
                ):
                    raise NativeUncertain("an armed native generation cannot be redispatched")
                if previous.terminal is None:
                    assert previous.submission_evidence is not None
                    negative = submission_from_json(previous.submission_evidence)
                    assert isinstance(negative, AgentNotSubmitted)
                    return negative
                completion = _sealed_completion(previous)
        if completion is not None:
            await owner.require_current(permit)
            await lifecycle.record_child_terminal(completion)
            await lifecycle.resolve_child_terminal(completion)
            return completion.terminal

        snapshot = spec.authority.model_tool_plan_snapshot
        plan_id = snapshot.value.plan_id if isinstance(snapshot, Present) else "NoModelTools"
        operation = self._tools.operations[plan_id]
        if isinstance(snapshot, Present) and freeze_tool_plan_snapshot(operation) != snapshot.value:
            raise ToolAuthorityRefused("native plan differs from the admitted generation")
        target = spec.resolved_dispatch_target
        if not isinstance(target, CodexDispatchTargetSnapshot):
            raise TypeError("native generation requires its exact Codex target")
        definition = NativeDefinition(
            provider=ProviderConfiguration(
                auth=CredentialRef(kind="local_account", profile_key="codex-personal"),
                model_key=target.model_key,
                reasoning=spec.selection.reasoning,
                agent_definition_revision=target.agent_definition_revision,
                row_fingerprint=spec.source_row_fingerprint,
            ),
            role=AgentRole(
                spec.operation,
                PromptSections(
                    (
                        PromptSection(
                            PromptSectionKind("instructions"),
                            (),
                            PromptText(request.intent.instructions),
                        ),
                    )
                ),
            ),
            output=JsonSchemaAgentOutput(
                name=spec.output_contract.name, schema=spec.output_contract.json_schema
            )
            if isinstance(spec.output_contract, StrictJsonOutputSnapshot)
            else TextAgentOutput(),
            maximum_profile=operation.profile,
            compatibility_revision=spec.backend_contract_revision,
        )
        deadline = datetime.now(UTC) + timedelta(seconds=spec.bounds.turn_timeout_seconds)
        sections = PromptSections(
            (PromptSection(PromptSectionKind("input"), (), PromptText(request.intent.input)),)
        )
        native_request = NativeRequest(
            attempt_id=attempt_id,
            permit=permit,
            scope="job",
            input_ids=(InputId(str(request.journal.context.job_id)),),
            canonical_sections=sections,
            submitted_sections=sections,
            plan=operation.plan,
            recovery_policy="reconcile_only",
            deadline_at=deadline,
            through_checkpoint=None,
        )
        journal = _NexusNativeJournal(
            request, native_request, definition, operation, session_factory, lifecycle, observe
        )
        await owner.require_current(native_request.permit)
        token = CancellationToken()

        async def watch_cancel() -> None:
            await cancellation.wait()
            token.cancel()

        watcher = asyncio.create_task(watch_cancel())
        try:
            with tempfile.TemporaryDirectory(prefix="nexus-native-runtime-") as state:
                cwd_root = self._socket_path.parent / "cwds"
                cwd_root.mkdir(mode=0o700, exist_ok=True)
                async with AgentRuntime(
                    AgentRuntimeConfig(
                        state_root_base=Path(state),
                        codex_endpoints={"codex-personal": self._socket_path},
                    )
                ) as runtime:
                    provider = CodexProvider(runtime, cwd_parent=cwd_root)
                    lease = await provider.acquire_native(
                        definition, operation.plan, native_request.permit, None
                    )
                    result = await run_native(
                        definition=definition,
                        request=native_request,
                        provider=provider,
                        session=lease,
                        owner=owner,
                        journal=journal,
                        inputs=owner,
                        dispatch=journal,
                        budgets=journal,
                        messages=journal,
                        cancellation=token,
                    )
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        if isinstance(result, AgentNotSubmitted):
            return result
        completion = journal.completion
        if (
            completion is None
            or not isinstance(completion.terminal.evidence, CodexTerminalEvidence)
            or completion.terminal.evidence.terminal != result
        ):
            raise NativeUncertain("native result has no original durable terminal")
        # Provider truth is committed already. Domain acceptance remains atomic with
        # the parent outcome and Completed job memo, and may fail independently.
        await lifecycle.record_child_terminal(completion)
        await observe(completion.terminal)
        await lifecycle.resolve_child_terminal(completion)
        return completion.terminal


class _NexusOwner:
    def __init__(self, request: GenerationExecutionRequest, factory: sessionmaker[Session]) -> None:
        self._request = request
        self._factory = factory

    async def require_current(self, permit: OwnerPermit) -> None:
        context = self._request.journal.context
        if (permit.scope_id, permit.operation_id, str(permit.owner_token)) != (
            str(context.job_id),
            str(self._request.generation_id),
            str(context.execution_id),
        ):
            raise ToolAuthorityRefused("native owner permit differs from the claimed generation")

        def check(db: Session) -> None:
            with db.begin():
                lock_generation_owner_in_current_transaction(db, self._request.owner)
                if not lock_running_job_claim(db, context=context):
                    raise ToolAuthorityRefused("native generation lost its worker claim")
                state = self._request.journal.read(db)
                if state is None or state.generation_id != self._request.generation_id:
                    raise ToolAuthorityRefused("native generation lost its admitted journal step")

        async with open_async_session(self._factory) as database:
            await database.run_sync(check)

    async def poll(
        self, request: NativeRequest, through_checkpoint: Checkpoint | None
    ) -> NoNewInput | Preempt:
        del through_checkpoint
        await self.require_current(request.permit)
        if self._request.owner.kind == "chat_run":
            async with open_async_session(self._factory) as db:
                stopped = await db.scalar(
                    select(ChatRun.cancel_requested_at).where(ChatRun.id == self._request.owner.id)
                )
            if stopped is not None:
                return Preempt("cancelled")
        return NoNewInput()


class _NexusNativeJournal:
    def __init__(
        self,
        request: GenerationExecutionRequest,
        native_request: NativeRequest,
        definition: NativeDefinition,
        operation: FrozenToolOperation,
        factory: sessionmaker[Session],
        lifecycle: BackendChildLifecycle,
        observe: ObserveEvent,
    ) -> None:
        self._request = request
        self._native_request = native_request
        self._definition = definition
        self._operation = operation
        self._factory = factory
        self._lifecycle = lifecycle
        self._observe = observe
        self._authority: ToolAuthority | None = None
        self._sequence = 0
        self.completion: BackendChildCompletion | None = None

    def create(self, plan: FrozenToolPlan) -> RunBudgetState:
        return RunBudgetState(plan.profile.run_limits)

    def _turn(self, db: Session, *, execution: bool = False) -> LLMModelTurn:
        lock_generation_owner_in_current_transaction(db, self._request.owner)
        if self._request.owner.kind == "chat_run":
            from nexus.services.chat_run_event_store import lock_chat_run_for_update

            if lock_chat_run_for_update(db, self._request.owner.id) is None:
                raise NativeUncertain("native chat owner disappeared")
        row = db.scalar(
            select(LLMModelTurn)
            .where(
                LLMModelTurn.id == UUID(self._native_request.attempt_id),
                LLMModelTurn.generation_id == self._request.generation_id,
            )
            .with_for_update()
        )
        if row is None:
            raise NativeUncertain("native generation has no armed model attempt")
        if execution:
            if not lock_running_job_claim(db, context=self._request.journal.context):
                raise ToolAuthorityRefused("native callback lost its worker claim")
            require_native_turn_in_current_transaction(db, row.generation_id, row.turn_seq)
        return row

    async def recover(self, attempt_id: str) -> NativeRecovery | None:
        if attempt_id != self._native_request.attempt_id:
            raise NativeUncertain("recovery selected another native attempt")

        def persist(db: Session) -> NativeRecovery | None:
            with db.begin():
                row = db.get(LLMModelTurn, UUID(attempt_id))
                if row is None or row.terminal is None:
                    return None
                facts = row.route_request_identity
                if facts.get("native_request_fingerprint") != self._native_request.fingerprint:
                    raise NativeUncertain("native recovery changed the frozen original work")
                fingerprint = self._definition.session_fingerprint(self._operation.plan)
                if facts.get("definition_fingerprint") != fingerprint:
                    raise NativeUncertain("native recovery changed the frozen definition")
                terminal = terminal_from_json(cast(Mapping[str, object], row.terminal["evidence"]))
                attempt = attempt_from_json(cast(Mapping[str, object], facts["provider_attempt"]))
                recovery = NativeRecovery(self._native_request, fingerprint, attempt, terminal)
                self.completion = _sealed_completion(row)
                self._sequence = self.completion.terminal.backend_seq
                return recovery

        async with open_async_session(self._factory) as database:
            return await database.run_sync(persist)

    async def arm(
        self,
        request: NativeRequest,
        provider_attempt: AgentAttempt,
        *,
        definition_fingerprint: str,
        submitted_request: JsonObject,
    ) -> None:
        if (
            request.fingerprint != self._native_request.fingerprint
            or provider_attempt.attempt_id != request.attempt_id
        ):
            raise NativeUncertain("native submission changed its frozen work")
        expected = self._definition.session_fingerprint(self._operation.plan)
        if definition_fingerprint != expected:
            raise NativeUncertain("native submission changed its definition")
        child = BackendChildDispatch(
            generation_id=self._request.generation_id,
            child_seq=1,
            route="CodexPersonal",
            request_fingerprint=provider_attempt.request_digest,
            route_request_identity={
                "kind": "NativeAgent",
                "generation_spec_fingerprint": self._request.spec.fingerprint,
                "native_request_fingerprint": request.fingerprint,
                "definition_fingerprint": expected,
                "deadline_at": request.deadline_at.isoformat()
                if request.deadline_at is not None
                else None,
                "provider_attempt": attempt_to_json(provider_attempt),
                "submitted_request": thaw_json_value(submitted_request),
            },
        )
        await self._lifecycle.arm_child(child)

    async def bind(self, attempt_id: str, native_turn: AgentTurnRef) -> None:
        if attempt_id != self._native_request.attempt_id:
            raise NativeUncertain("native binding selected another attempt")

        def persist(db: Session) -> None:
            with db.begin():
                row = self._turn(db)
                attempt = attempt_from_json(
                    cast(Mapping[str, object], row.route_request_identity["provider_attempt"])
                )
                accepted = AgentAccepted(attempt, native_turn)
                document = submission_to_json(accepted)
                binding = document["turn"]
                if row.native_binding is not None and row.native_binding != binding:
                    raise NativeUncertain("native binding changed its original turn")
                row.native_binding = cast(dict[str, object], binding)
                if row.submission_evidence is not None:
                    previous = submission_from_json(row.submission_evidence)
                    if isinstance(previous, AgentNotSubmitted):
                        raise NativeUncertain("native binding contradicts non-submission proof")
                row.submission_evidence = document

        async with open_async_session(self._factory) as database:
            await database.run_sync(persist)

    async def record_invocation(self, proposal: NativeInvocationProposal) -> InvocationRecord:
        raw = thaw_json_value(proposal.arguments)
        if generation_evidence_contains_nul(raw):
            raise NativeDefect("native callback evidence contains nul")
        binding = self._operation.plan.catalog_view.binding(proposal.tool_id)
        if (
            proposal.plan_revision,
            proposal.tool_contract_revision,
            proposal.implementation_revision,
            proposal.policy_revision,
        ) != (
            self._operation.plan.plan_revision,
            binding.spec.tool_contract_revision,
            binding.implementation_revision,
            binding.policy_revision,
        ):
            raise ToolAuthorityRefused("native callback changed its frozen binding contract")
        if (
            proposal.attempt_id != self._native_request.attempt_id
            or proposal.input_ids != self._native_request.input_ids
        ):
            raise ToolAuthorityRefused("native callback changed its work lineage")
        if self._authority is None:
            executor = self._request.tool_executor
            if isinstance(executor, DeferredGenerationToolExecutor):
                projection = executor.projection
            elif isinstance(executor, GenerationToolExecutor):
                projection = executor.authority.projection
            elif executor is None:
                projection = None
            else:
                raise ToolAuthorityRefused(
                    "native executor has no explicit Nexus projection contract"
                )
            self._authority = await ToolAuthority.from_claimed_generation_attempt(
                session_factory=self._factory,
                user_id=self._request.user_id,
                owner=self._request.owner,
                generation_id=self._request.generation_id,
                job_context=self._request.journal.context,
                operation=self._operation,
                projection=projection,
            )
        record = await self._authority.prepare_position(
            transport_kind="NativeCallback",
            model_turn_seq=1,
            transport_call_id=proposal.call_id,
            tool_id=proposal.tool_id,
            input_digest=raw_input_digest(ParsedJson(raw)),
            provider_wire_name=str(proposal.tool_id),
            arguments=raw,
        )
        async with open_async_session(self._factory) as db:
            row = await db.get(LLMToolPosition, record.id)
            if row is None:
                raise AssertionError("accepted callback position disappeared")
            receipt = self._reply(row) if row.callback_reply is not None else None
        self._sequence += 1
        await self._observe(
            BackendToolObserved(
                backend_seq=self._sequence,
                observation=GenerationToolUse(
                    tool_call_id=proposal.call_id,
                    name=str(proposal.tool_id),
                    phase="started",
                ),
            )
        )
        return InvocationRecord(str(record.id), record.position, proposal, receipt)

    async def dispatch(
        self,
        *,
        binding: ToolBinding[Any, Any, Any],
        validated_input: object,
        plan: FrozenToolPlan,
        budgets: BudgetState,
        cancellation: CancellationToken,
        lineage: ToolDispatchLineage,
    ) -> DispatchCompleted:
        del validated_input, cancellation
        if not isinstance(lineage, NativeDispatchLineage) or self._authority is None:
            raise ToolAuthorityRefused("native dispatch has no accepted invocation")
        if plan != self._operation.plan or budgets.limits != plan.profile.run_limits:
            raise ToolAuthorityRefused("native dispatch changed its frozen plan or budget")
        if (
            lineage.attempt_id != self._native_request.attempt_id
            or lineage.permit != self._native_request.permit
            or lineage.input_ids != self._native_request.input_ids
            or lineage.through_checkpoint is not None
            or lineage.definition_fingerprint != self._definition.session_fingerprint(plan)
        ):
            raise ToolAuthorityRefused("native dispatch changed its accepted work lineage")

        def persist(db: Session) -> tuple[dict[str, Any], str]:
            with db.begin():
                self._turn(db, execution=True)
                row = db.get(LLMToolPosition, UUID(lineage.invocation_id))
                if (
                    row is None
                    or row.generation_id != self._request.generation_id
                    or row.canonical_tool_id != str(binding.spec.id)
                    or row.position != lineage.ordinal
                ):
                    raise ToolAuthorityRefused("native dispatch changed its accepted tool position")
                if not isinstance(row.arguments, dict) or not isinstance(
                    row.arguments["value"], dict
                ):
                    raise ToolAuthorityRefused("validated native input is not its original object")
                arguments = row.arguments["value"]
                call_id = row.transport_call_id
                return arguments, call_id

        async with open_async_session(self._factory) as database:
            arguments, call_id = await database.run_sync(persist)
        result = await GenerationToolExecutor(self._authority).execute_canonical(
            transport_kind="NativeCallback",
            model_turn_seq=1,
            transport_call_id=call_id,
            provider_wire_name=str(binding.spec.id),
            tool_id=binding.spec.id,
            arguments=arguments,
        )
        if result.position is None or result.position.result_evidence is None:
            raise AssertionError("native executor returned no durable result")
        original = cast(ToolResult, result.position.result_evidence["tool_result"])
        return DispatchCompleted(
            result=original,
            model_text=result.model_output.output,
            host_ref=HostRef(str(result.position.id))
            if binding.spec.effect is ToolEffect.Write
            else None,
        )

    async def record_reply(self, invocation_id: str, receipt: NativeReply) -> None:
        def persist(db: Session) -> tuple[str, str]:
            with db.begin():
                self._turn(db)
                row = db.scalar(
                    select(LLMToolPosition)
                    .where(LLMToolPosition.id == UUID(invocation_id))
                    .with_for_update()
                )
                if row is None or row.generation_id != self._request.generation_id:
                    raise ToolAuthorityRefused("native reply selected another tool position")
                document: dict[str, object] = {"text": receipt.text, "success": receipt.success}
                result = receipt.result
                if isinstance(result, NativeRejected):
                    document.update(kind="rejected", code=result.code, reason=result.text)
                    row.result_evidence = {
                        "tool_result": {
                            "type": "Failure",
                            "error": {
                                "type": "InvalidInput"
                                if result.code == "invalid_arguments"
                                else "BudgetExceeded"
                            },
                        }
                    }
                    row.replay_status = "Completed"
                    row.completed_at = func.clock_timestamp()
                    row.settlement = {"actual_attempts": 0, "actual_output_bytes": 0}
                elif isinstance(result, DispatchCompleted):
                    if (
                        row.replay_status != "Completed"
                        or row.result_evidence is None
                        or row.result_evidence["tool_result"] != result.result
                    ):
                        raise ToolAuthorityRefused(
                            "native reply precedes its durable executor result"
                        )
                    document.update(
                        kind="completed",
                        result_ref=invocation_id,
                        host_ref=str(result.host_ref) if result.host_ref is not None else None,
                    )
                else:
                    raise ToolAuthorityRefused(
                        "Nexus native callbacks have no approval suspension protocol"
                    )
                if row.callback_reply is not None and row.callback_reply != document:
                    raise ToolAuthorityRefused("native reply changed its original receipt")
                row.callback_reply = document
                call_id, tool_id = row.transport_call_id, row.canonical_tool_id
                return call_id, tool_id

        async with open_async_session(self._factory) as database:
            call_id, tool_id = await database.run_sync(persist)
        self._sequence += 1
        await self._observe(
            BackendToolObserved(
                backend_seq=self._sequence,
                observation=GenerationToolUse(
                    tool_call_id=call_id,
                    name=tool_id,
                    phase="completed",
                    succeeded=receipt.success,
                ),
            )
        )

    def _reply(self, row: LLMToolPosition) -> NativeReply:
        document = row.callback_reply
        if document is None:
            raise AssertionError("native replay lacks immutable reply")
        if document["kind"] == "rejected":
            result = NativeRejected(
                cast(Literal["invalid_arguments", "input_too_large"], document["code"]),
                cast(str, document["reason"]),
            )
        elif document["kind"] == "completed":
            if document["result_ref"] != str(row.id) or row.result_evidence is None:
                raise ToolAuthorityRefused("native replay result reference changed")
            reference = document["host_ref"]
            result = DispatchCompleted(
                result=cast(ToolResult, row.result_evidence["tool_result"]),
                model_text=cast(str, document["text"]),
                host_ref=None if reference is None else HostRef(cast(str, reference)),
            )
        else:
            raise ToolAuthorityRefused("unknown persisted native reply kind")
        return NativeReply(cast(str, document["text"]), cast(bool, document["success"]), result)

    async def record_delivery(self, delivery: NativeDelivery) -> None:
        if delivery.attempt_id != self._native_request.attempt_id:
            raise NativeUncertain("input delivery selected another native attempt")

        def persist(db: Session) -> None:
            with db.begin():
                row = self._turn(db)
                local = dict(row.local_outcome or {})
                deliveries = dict(cast(dict[str, object], local.get("deliveries", {})))
                evidence = delivery.evidence
                if isinstance(evidence, AgentInputRecorded | AgentControlReceipt):
                    encoded = asdict(evidence)
                elif evidence is not None:
                    encoded = submission_to_json(evidence)
                else:
                    encoded = None
                deliveries[delivery.delivery_id] = {
                    "input_ids": list(delivery.input_ids),
                    "mode": delivery.mode,
                    "state": delivery.state,
                    "evidence": encoded,
                }
                local["deliveries"] = deliveries
                row.local_outcome = local

        async with open_async_session(self._factory) as database:
            await database.run_sync(persist)

    async def record_outcome(
        self,
        attempt_id: str,
        evidence: AgentSubmission | AgentTerminal | AgentControlReceipt,
    ) -> None:
        from nexus.services.llm_execution import model_turn_documents

        if attempt_id != self._native_request.attempt_id:
            raise NativeUncertain("native outcome selected another attempt")

        def persist(db: Session) -> None:
            with db.begin():
                row = self._turn(db)
                original = attempt_from_json(
                    cast(Mapping[str, object], row.route_request_identity["provider_attempt"])
                )
                if isinstance(evidence, AgentControlReceipt):
                    local = dict(row.local_outcome or {})
                    controls = dict(cast(dict[str, object], local.get("controls", {})))
                    document = asdict(evidence)
                    if (
                        evidence.request_id in controls
                        and controls[evidence.request_id] != document
                    ):
                        raise NativeUncertain("control receipt changed its original outcome")
                    controls[evidence.request_id] = document
                    local["controls"] = controls
                    row.local_outcome = local
                    return
                if isinstance(evidence, AgentTerminal):
                    if isinstance(evidence.evidence, LocalStopEvidence):
                        if evidence.evidence.submission.attempt != original:
                            raise NativeUncertain("local stop changed its original submission")
                        row.local_outcome = {
                            **(row.local_outcome or {}),
                            "terminal": terminal_to_json(evidence),
                        }
                        return
                    if (
                        not isinstance(evidence.evidence, NativeTerminalEvidence)
                        or evidence.evidence.attempt != original
                    ):
                        raise NativeUncertain("native terminal changed its original submission")
                    native_ref = evidence.evidence.native_ref
                    if not isinstance(native_ref, AgentTurnRef):
                        raise NativeUncertain("Codex terminal lacks its original native turn")
                    binding = submission_to_json(AgentAccepted(original, native_ref))["turn"]
                    if row.native_binding is not None and row.native_binding != binding:
                        raise NativeUncertain("native terminal changed its bound native turn")
                    if row.submission_evidence is not None and isinstance(
                        submission_from_json(row.submission_evidence), AgentNotSubmitted
                    ):
                        raise NativeUncertain("native terminal contradicts non-submission proof")
                    row.native_binding = cast(dict[str, object], binding)
                    if row.terminal is not None:
                        if (
                            terminal_from_json(cast(Mapping[str, object], row.terminal["evidence"]))
                            != evidence
                        ):
                            raise NativeUncertain("native terminal changed its original value")
                        self._sequence = cast(int, row.terminal["backend_seq"])
                    else:
                        self._sequence += 1
                    terminal = BackendTerminal(
                        route="CodexPersonal",
                        child_seq=1,
                        backend_seq=self._sequence,
                        evidence=CodexTerminalEvidence(terminal=evidence),
                    )
                    document, usage, billing, accepted = model_turn_documents(terminal)
                    complete_model_turn_in_current_transaction(
                        db,
                        generation_id=row.generation_id,
                        model_turn_id=row.id,
                        completion=ModelTurnCompletion(
                            document, usage, billing, accepted, absent()
                        ),
                    )
                    self.completion = BackendChildCompletion(
                        _child_dispatch(row), terminal, absent()
                    )
                    return
                if evidence.attempt != original:
                    raise NativeUncertain("submission evidence changed its original attempt")
                if isinstance(evidence, AgentNotSubmitted) and row.native_binding is not None:
                    raise NativeUncertain("non-submission proof contradicts native acceptance")
                if (
                    isinstance(evidence, AgentAccepted | AgentUncertain)
                    and evidence.turn is not None
                ):
                    binding = submission_to_json(AgentAccepted(original, evidence.turn))["turn"]
                    if row.native_binding is not None and row.native_binding != binding:
                        raise NativeUncertain(
                            "submission evidence changed its original native turn"
                        )
                if row.submission_evidence is not None:
                    previous = submission_from_json(row.submission_evidence)
                    if isinstance(previous, AgentNotSubmitted) and previous != evidence:
                        raise NativeUncertain("positive non-submission proof cannot be replaced")
                row.submission_evidence = submission_to_json(evidence)
                if isinstance(evidence, AgentNotSubmitted):
                    row.local_outcome = {
                        **(row.local_outcome or {}),
                        "kind": "NotSubmitted",
                        "reason": evidence.reason,
                    }
                    row.completed_at = func.clock_timestamp()

        async with open_async_session(self._factory) as database:
            await database.run_sync(persist)

    async def fence(self, attempt_id: str, reason: str) -> None:
        if attempt_id != self._native_request.attempt_id:
            raise NativeUncertain("native fence selected another attempt")

        def persist(db: Session) -> None:
            with db.begin():
                row = self._turn(db)
                if row.fenced_at is None:
                    row.fenced_at = func.clock_timestamp()
                    row.local_outcome = {**(row.local_outcome or {}), "fenced_reason": reason}

        async with open_async_session(self._factory) as database:
            await database.run_sync(persist)

    async def record(self, attempt_id: str, message: AgentMessage) -> None:
        if attempt_id != self._native_request.attempt_id or message.phase != "commentary":
            raise ToolAuthorityRefused("native progress changed its public message lineage")

        def persist(db: Session) -> bool:
            with db.begin():
                row = self._turn(db, execution=True)
                attempt = attempt_from_json(
                    cast(Mapping[str, object], row.route_request_identity["provider_attempt"])
                )
                binding = submission_to_json(AgentAccepted(attempt, message.turn))["turn"]
                if row.native_binding != binding:
                    raise NativeUncertain("native progress changed its bound turn")
                local = dict(row.local_outcome or {})
                messages = dict(cast(dict[str, object], local.get("messages", {})))
                document = {"phase": message.phase, "text": message.text}
                if message.message_id in messages:
                    if messages[message.message_id] != document:
                        raise NativeUncertain("native public message changed its original content")
                    return True
                messages[message.message_id] = document
                local["messages"] = messages
                row.local_outcome = local
                if self._request.owner.kind == "chat_run":
                    from nexus.services.chat_run_event_store import (
                        append_run_event,
                        bounded_text_prefix,
                    )

                    run = db.get(ChatRun, self._request.owner.id)
                    if run is None:
                        raise AssertionError("locked native chat owner disappeared")
                    remaining = message.text
                    while remaining:
                        chunk = bounded_text_prefix(remaining, max_chars=512, max_bytes=2048)
                        self._sequence += 1
                        append_run_event(
                            db,
                            run,
                            "assistant_text_delta",
                            {
                                "assistant_message_id": str(run.assistant_message_id),
                                "text": chunk,
                                "provider_event_seq_start": self._sequence,
                                "provider_event_seq_end": self._sequence,
                            },
                        )
                        remaining = remaining[len(chunk) :]
                    return True
            return False

        async with open_async_session(self._factory) as database:
            if await database.run_sync(persist):
                return
        self._sequence += 1
        await self._observe(
            BackendTextDelta(
                route="CodexPersonal", child_seq=1, backend_seq=self._sequence, text=message.text
            )
        )


def _child_dispatch(row: LLMModelTurn) -> BackendChildDispatch:
    return BackendChildDispatch(
        row.generation_id,
        row.turn_seq,
        "CodexPersonal",
        row.request_fingerprint,
        row.route_request_identity,
    )


def _sealed_completion(row: LLMModelTurn) -> BackendChildCompletion:
    assert row.terminal is not None
    terminal = terminal_from_json(cast(Mapping[str, object], row.terminal["evidence"]))
    return BackendChildCompletion(
        _child_dispatch(row),
        BackendTerminal(
            route="CodexPersonal",
            child_seq=1,
            backend_seq=cast(int, row.terminal["backend_seq"]),
            evidence=CodexTerminalEvidence(terminal=terminal),
        ),
        absent(),
    )
