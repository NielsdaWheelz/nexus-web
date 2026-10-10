"""One Codex Personal generation on the kernel's transient native mode (kernel ADR 0012).

The kernel keeps every in-process ordering guarantee and nothing durable: no
recovery, no replay. Nexus supplies the job claim, a stop poll, commentary as
streamed text, and tool dispatch through the generation's tool executor.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4

from llm_agent_kernel import (
    AgentRole,
    CancellationToken,
    CodexProvider,
    DispatchCompleted,
    HostRef,
    InputId,
    NativeDefinition,
    NativeRequest,
    NoNewInput,
    OwnerPermit,
    OwnerToken,
    PollResult,
    Preempt,
    ProviderConfiguration,
    TransientNative,
    run_native,
)
from llm_tools import (
    BudgetState,
    FrozenToolPlan,
    PromptSection,
    PromptSectionKind,
    PromptSections,
    PromptText,
    RunBudgetState,
    ToolBinding,
    ToolEffect,
)
from llm_tools.schema import strict_encode
from provider_runtime.agent_runtime import (
    AgentFailure,
    AgentMessage,
    AgentNotSubmitted,
    AgentQuotaExhausted,
    AgentRuntime,
    AgentRuntimeConfig,
    AgentRuntimeError,
    CredentialRef,
    CredentialRejected,
    CredentialUnavailable,
    InvalidAgentRequest,
    JsonSchemaAgentOutput,
    TextAgentOutput,
    terminal_to_json,
    thaw_json_value,
)
from provider_runtime.types import Present as RuntimePresent
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.jobs.queue import running_job_claim_is_current
from nexus.services.generation.contract import (
    FailureCode,
    GenerationIntent,
    JsonSchemaOutput,
    JsonValue,
    OnEvent,
    Owner,
    RouteResult,
    TextDelta,
    ToolCalling,
    usage_of,
)

if TYPE_CHECKING:
    from nexus.services.generation.catalog import CodexTarget
    from nexus.services.tool_authority import GenerationToolExecutor
    from nexus.services.tool_runtime.catalog import FrozenToolOperation

_CAUSES: dict[str, FailureCode] = {
    "backend_failed": "runtime_unavailable",
    "turn_timeout": "timeout",
    "output_limit_exceeded": "output_limit",
    "approval_unanswered": "policy_violation",
    "output_schema_violation": "invalid_output",
}


async def run_codex(
    *,
    socket: Path,
    sessions: sessionmaker[Session],
    owner: Owner,
    generation_id: UUID,
    target: CodexTarget,
    reasoning: str,
    role: str,
    intent: GenerationIntent,
    operation: FrozenToolOperation,
    executor: GenerationToolExecutor | None,
    deadline_at: datetime,
    stopped: asyncio.Event,
    on_event: OnEvent,
) -> RouteResult:
    def sections(kind: str, text: str) -> PromptSections:
        return PromptSections((PromptSection(PromptSectionKind(kind), (), PromptText(text)),))

    output = intent.output
    definition = NativeDefinition(
        provider=ProviderConfiguration(
            CredentialRef("local_account", "codex-personal"),
            target.model_key,
            reasoning,
            target.definition_revision,
            target.row_fingerprint,
        ),
        role=AgentRole(role, sections("instructions", intent.instructions)),
        output=JsonSchemaAgentOutput(name=output.name, schema=output.schema_)
        if isinstance(output, JsonSchemaOutput)
        else TextAgentOutput(),
        maximum_profile=operation.profile,
        compatibility_revision=target.backend_contract_revision,
    )
    request = NativeRequest(
        attempt_id=str(uuid4()),
        permit=OwnerPermit(
            str(owner.job.job_id), OwnerToken(str(owner.job.execution_id)), str(generation_id), None
        ),
        scope="job",
        input_ids=(InputId(str(owner.job.job_id)),),
        canonical_sections=sections("input", intent.input),
        submitted_sections=sections("input", intent.input),
        plan=operation.plan,
        # inert under TransientNative; "reconcile_only" would claim the opposite of G1.
        recovery_policy="restart_reasoning",
        deadline_at=deadline_at,
        through_checkpoint=None,
    )
    ports = _Ports(sessions, owner, stopped, on_event, executor)
    cwd_root = socket.parent / "cwds"
    cwd_root.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nexus-native-runtime-") as state:
        async with AgentRuntime(
            AgentRuntimeConfig(
                state_root_base=Path(state), codex_endpoints={"codex-personal": socket}
            )
        ) as runtime:
            provider = CodexProvider(runtime, cwd_parent=cwd_root)
            try:
                try:
                    lease = await provider.acquire_native(
                        definition, operation.plan, request.permit, None
                    )
                except (CredentialUnavailable, CredentialRejected, InvalidAgentRequest):
                    raise
                except AgentRuntimeError as error:
                    # No session opened, so no turn was submitted.
                    detail = f"codex session did not open: {type(error).__name__}"
                    return RouteResult(
                        "failed", None, None, "runtime_unavailable", detail, {}, sent=False
                    )
                result = await run_native(
                    definition=definition,
                    request=request,
                    provider=provider,
                    session=lease,
                    owner=ports,
                    journal=TransientNative(),
                    inputs=ports,
                    dispatch=ports,
                    budgets=ports,
                    messages=ports,
                    cancellation=CancellationToken(),
                )
            finally:
                await provider.shutdown()
    if isinstance(result, AgentNotSubmitted):
        detail = f"codex did not submit: {result.reason}"
        return RouteResult("failed", None, None, "runtime_unavailable", detail, {}, sent=False)
    evidence = terminal_to_json(result)
    del evidence["final_text"], evidence["raw_structured_output"]
    usage = usage_of(result.usage.value) if isinstance(result.usage, RuntimePresent) else None
    audit = cast(dict[str, JsonValue], evidence)
    if result.status == "cancelled":
        return RouteResult("cancelled", None, usage, None, "", audit)
    if result.status == "failed":
        failure = result.failure
        cause = failure.cause if isinstance(failure, AgentFailure) else "quota_exhausted"
        code = "quota" if isinstance(failure, AgentQuotaExhausted) else _CAUSES[cause]
        return RouteResult("failed", None, usage, code, f"codex failed: {cause}", audit)
    if not isinstance(output, JsonSchemaOutput):
        return RouteResult("succeeded", result.final_text, usage, None, "", audit)
    if result.raw_structured_output is not None:
        parsed = cast(JsonValue, thaw_json_value(result.raw_structured_output.value))
    else:
        try:
            parsed = cast(JsonValue, json.loads(result.final_text))
        except ValueError:
            return RouteResult(
                "failed", None, usage, "invalid_output", "codex output is not JSON", audit
            )
    return RouteResult("succeeded", parsed, usage, None, "", audit)


class _Ports:
    """The host side of one native call: claim, stop, commentary, budget and dispatch."""

    def __init__(
        self,
        sessions: sessionmaker[Session],
        owner: Owner,
        stopped: asyncio.Event,
        on_event: OnEvent,
        executor: GenerationToolExecutor | None,
    ) -> None:
        self._sessions = sessions
        self._owner = owner
        self._stopped = stopped
        self._on_event = on_event
        self._executor = executor
        self._messages: set[str] = set()

    async def require_current(self, permit: OwnerPermit) -> None:
        from nexus.services.tool_authority import ToolAuthorityRefused

        del permit
        async with open_async_session(self._sessions) as database:
            live = await database.run_sync(
                lambda db: running_job_claim_is_current(db, context=self._owner.job)
            )
        if not live:
            raise ToolAuthorityRefused("codex generation lost its job claim")

    async def poll(self, request: NativeRequest, through_checkpoint: object) -> PollResult:
        del request, through_checkpoint
        return Preempt("cancelled") if self._stopped.is_set() else NoNewInput()

    def create(self, plan: FrozenToolPlan) -> RunBudgetState:
        return RunBudgetState(plan.profile.run_limits)

    async def record(self, attempt_id: str, message: AgentMessage) -> None:
        del attempt_id
        if message.message_id not in self._messages:
            self._messages.add(message.message_id)
            await self._on_event(TextDelta(message.text))

    async def dispatch(
        self,
        *,
        binding: ToolBinding[Any, Any, Any],
        validated_input: object,
        plan: FrozenToolPlan,
        budgets: BudgetState,
        cancellation: CancellationToken,
        lineage: object,
    ) -> DispatchCompleted:
        from llm_agent_kernel import NativeDispatchLineage

        del plan, budgets, cancellation
        if self._executor is None or not isinstance(lineage, NativeDispatchLineage):
            raise AssertionError("a tool-free codex generation dispatched a tool")
        spec = binding.spec
        await self._on_event(ToolCalling(str(spec.id)))
        result = await self._executor.execute_canonical(
            model_turn_seq=1,
            transport_call_id=lineage.invocation_id,
            provider_wire_name=str(spec.id),
            tool_id=spec.id,
            # The transient lineage carries no raw arguments; re-encode the validated input.
            arguments=cast(
                dict[str, object],
                strict_encode(spec.input_type, spec.input_schema, validated_input),
            ),
        )
        position = result.position
        if position.result_evidence is None:
            raise AssertionError("a completed codex tool call has no recorded result")
        return DispatchCompleted(
            result=cast(Any, position.result_evidence["tool_result"]),
            model_text=result.model_output.output,
            host_ref=HostRef(str(position.id)) if spec.effect is ToolEffect.Write else None,
        )
