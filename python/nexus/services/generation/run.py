"""``generate``: the one entry point. Resolve, open, watch, dispatch, decode, close.

Every expected outcome comes back as a terminal value with one failure code, except
a background generation that never reached its model while its job has attempts
left: that raises ``RouteUnavailable`` so the queue retries the job. Anything else
is a defect: the row closes ``defect`` and the exception goes on to the queue's
retry. No transaction is held across model or tool I/O, and the kernel, provider
runtime and tool runtime load only when a generation runs.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal

from nexus.jobs.queue import get_job, running_job_claim_is_current
from nexus.logging import get_logger
from nexus.schemas.llm import GenerationSelection, Ready
from nexus.services.generation.contract import (
    Cancelled,
    Decode,
    Event,
    Failed,
    FailureCode,
    GenerationIntent,
    GenerationSpec,
    InvalidOutput,
    OnEvent,
    Operation,
    Owner,
    RouteResult,
    RouteUnavailable,
    Stop,
    Succeeded,
    Terminal,
    TextDelta,
    Tools,
)
from nexus.services.generation.ledger import GenerationRef, close_generation, open_generation
from nexus.services.generation.policy import MEMORY_PLANS, OperationPolicy, chat_tool_plan, policy

if TYPE_CHECKING:
    from nexus.services.generation.catalog import Row
    from nexus.services.generation.runtime import Runtime
    from nexus.services.tool_runtime.catalog import FrozenToolOperation

logger = get_logger(__name__)

# How often a running generation checks its stop, its job claim and its deadline.
STOP_POLL_SECONDS = 0.25


async def generate[T](
    runtime: Runtime,
    *,
    owner: Owner,
    operation: Operation,
    intent: GenerationIntent,
    decode: Decode[T],
    selection: GenerationSelection | None = None,
    tools: Tools | None = None,
    on_event: OnEvent | None = None,
    stop: Stop | None = None,
) -> Terminal[T]:
    """Run one generation for ``owner`` and record it as one ``llm_calls`` row.

    The caller holds no open transaction. Chat passes its selection; a background
    operation runs its policy's selection.
    """

    from nexus.services.generation.catalog import chat_budgets

    rules = policy(operation)
    chosen = selection or rules.selection
    if (
        rules.owner_kind != owner.kind
        or (intent.output.kind == "Text") != (rules.output == "Text")
        or (selection is None) == (operation == "chat")
        or (tools is not None and tools.plan_id not in rules.tool_plans)
        or (chosen.route == "ProviderApi" and rules.output != "Text")
    ):
        raise AssertionError(f"generate was called outside the {operation} policy")
    refusal, row = await _resolve(runtime, owner, chosen, intent, rules, tools)
    plan = runtime.tools.operations[tools.plan_id if tools else "NoModelTools"]
    budgets = chat_budgets(row) if row is not None and operation == "chat" else None
    effect_mode = "AdditiveWrites" if plan.definition.max_live_writes else "ReadOnly"
    spec = GenerationSpec(
        operation=operation,
        selection=chosen,
        display_at_dispatch=None if row is None else row.presentation,
        tool_plan=None if tools is None else tools.plan_id,
        tool_scope=() if tools is None else tuple(sorted(tools.scope_refs)),
        effect_mode=None if tools is None else effect_mode,
        context_budget_tokens=None if budgets is None else budgets[0],
        output_budget_tokens=None if budgets is None else budgets[1],
    )
    with runtime.session_factory() as db:
        ref = open_generation(db, owner, spec)
        db.commit()
    streamed: list[str] = []

    async def emit(event: Event) -> None:
        if isinstance(event, TextDelta):
            streamed.append(event.text)
        if on_event is not None:
            await on_event(event)

    try:
        if refusal is not None or row is None:
            code, detail = refusal or ("runtime_unavailable", "no catalog row")
            result = RouteResult("failed", None, None, code, detail, {}, sent=False)
        else:
            result = await _dispatch(
                runtime,
                ref,
                owner,
                operation,
                chosen,
                row,
                plan,
                budgets,
                intent,
                rules,
                tools,
                stop,
                emit,
            )
        text = "".join(streamed)
        terminal: Terminal[T]
        if result.status == "succeeded":
            try:
                terminal = Succeeded(ref.id, decode(result.output), result.usage)
            except InvalidOutput as rejection:
                reason = str(rejection)
                terminal = Failed(ref.id, "invalid_output", reason, text, result.usage, rejection)
        elif result.status == "cancelled":
            terminal = Cancelled(ref.id, text, result.usage)
        else:
            assert result.code is not None
            terminal = Failed(ref.id, result.code, result.detail, text, result.usage)
        with runtime.session_factory() as db:
            close_generation(db, terminal, route=chosen.route, evidence=result.evidence)
            db.commit()
    except BaseException as error:
        try:
            with runtime.session_factory() as db:
                defect = Failed(ref.id, "defect", type(error).__name__, "", None)
                close_generation(db, defect, route=chosen.route, evidence={})
                db.commit()
        except Exception as close_error:  # justify-ignore-error: the original defect wins.
            error.add_note(f"closing generation {ref.id} as a defect failed: {close_error!r}")
        raise
    if (
        isinstance(terminal, Failed)
        and terminal.code == "runtime_unavailable"
        and not result.sent
        and operation != "chat"
    ):
        # Nothing was billed: retry within the job's budget; the last attempt settles.
        with runtime.session_factory() as db:
            job = get_job(db, owner.job.job_id)
        if job is not None and owner.job.attempt_no < job.max_attempts:
            raise RouteUnavailable(terminal.detail)
    return terminal


async def _resolve(
    runtime: Runtime,
    owner: Owner,
    chosen: GenerationSelection,
    intent: GenerationIntent,
    rules: OperationPolicy,
    tools: Tools | None,
) -> tuple[tuple[FailureCode, str] | None, Row | None]:
    """Everything that can refuse before dispatch, as a value: (code, detail) or None."""

    from nexus.services.generation.catalog import CatalogUnavailable, ProviderTarget
    from nexus.services.tool_runtime.catalog import unavailable_tool_ids

    try:
        snapshot = await runtime.catalog.read()
    except CatalogUnavailable as error:
        return ("runtime_unavailable", str(error)), None
    row = snapshot.rows.get(chosen)
    if row is None:
        return ("runtime_unavailable", "the selection is not in the current catalog"), None
    if not isinstance(row.readiness, Ready):
        return ("runtime_unavailable", row.readiness.explanation), row
    if tools is not None:
        if isinstance(row.target, ProviderTarget) and not row.target.supports_tools:
            return ("runtime_unavailable", "the selected model cannot call tools"), row
        missing = unavailable_tool_ids(runtime.tools.operations[tools.plan_id])
        if missing:
            return ("runtime_unavailable", f"tools unavailable: {', '.join(missing)}"), row
        if tools.plan_id in MEMORY_PLANS and tools.plan_id != chat_tool_plan(
            runtime.tools.memory_config,
            user_id=owner.user_id,
            processors=row.presentation.processor_chain.processors,
        ):
            return ("runtime_unavailable", "the shared memory grant changed"), row
    if len(intent.input.encode()) > rules.input_max_bytes:
        return ("context_too_large", f"input exceeds {rules.input_max_bytes} bytes"), row
    return None, row


async def _dispatch(
    runtime: Runtime,
    ref: GenerationRef,
    owner: Owner,
    operation: Operation,
    chosen: GenerationSelection,
    row: Row,
    plan: FrozenToolOperation,
    budgets: tuple[int, int] | None,
    intent: GenerationIntent,
    rules: OperationPolicy,
    tools: Tools | None,
    stop: Stop | None,
    emit: OnEvent,
) -> RouteResult:
    from llm_tools import RunBudgetState

    from nexus.services.generation.catalog import CodexTarget
    from nexus.services.tool_authority import (
        GenerationToolExecutor,
        ToolAuthority,
        ToolAuthorityRefused,
    )

    executor = (
        None
        if tools is None
        else GenerationToolExecutor(
            ToolAuthority(
                session_factory=runtime.session_factory,
                owner=owner,
                generation_id=ref.id,
                generation_seq=ref.seq,
                operation=plan,
                transport_kind="NativeCallback"
                if isinstance(row.target, CodexTarget)
                else "ProviderApi",
                admitted_resource_uris=tools.scope_refs,
                projection=tools.projection,
                budgets=RunBudgetState(plan.profile.run_limits),
            )
        )
    )
    stopped = asyncio.Event()
    reasons: list[Literal["cancelled", "deadline", "claim_lost"]] = []
    watcher = asyncio.create_task(
        _watch(runtime, owner, stop, time.monotonic() + rules.timeout_seconds, stopped, reasons)
    )
    try:
        if isinstance(row.target, CodexTarget):
            from nexus.services.generation.codex import run_codex

            result = await run_codex(
                socket=runtime.codex_socket,
                sessions=runtime.session_factory,
                owner=owner,
                generation_id=ref.id,
                target=row.target,
                reasoning=chosen.reasoning,
                role=operation,
                intent=intent,
                operation=plan,
                executor=executor,
                deadline_at=datetime.now(UTC) + timedelta(seconds=rules.timeout_seconds),
                stopped=stopped,
                on_event=emit,
            )
        else:
            from nexus.services.generation.provider import run_provider

            if runtime.providers is None or executor is None or budgets is None:
                raise AssertionError("a provider generation needs its runtime and chat tools")
            result = await run_provider(
                runtime.providers,
                target=row.target,
                reasoning=chosen.reasoning,
                intent=intent,
                max_output_tokens=budgets[1],
                operation=plan,
                executor=executor,
                stopped=stopped,
                on_event=emit,
            )
    except Exception as error:
        if isinstance(error, ToolAuthorityRefused) and not reasons and stop is not None:
            # The tool fence refuses once a stop commits, possibly before the next poll.
            with runtime.session_factory() as db:
                if stop(db):
                    reasons.append("cancelled")
        failure = _expected_failure(error)
        if failure is None and not reasons:
            raise
        if failure is None:
            # A stop or a lost claim tore down state the route was using: the stop wins.
            logger.warning("generation_error_after_stop", error=repr(error)[:500])
        code, detail = failure or ("defect", type(error).__name__)
        result = RouteResult("failed", None, None, code, detail, {})
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
    if result.status == "succeeded" or not reasons:
        return result
    if reasons[0] == "cancelled":
        return RouteResult("cancelled", None, result.usage, None, "", result.evidence)
    code: FailureCode = "timeout" if reasons[0] == "deadline" else "interrupted"
    detail = (
        f"the generation exceeded its {rules.timeout_seconds} s limit"
        if reasons[0] == "deadline"
        else "the job attempt lost its claim"
    )
    return RouteResult("failed", None, result.usage, code, detail, result.evidence)


async def _watch(
    runtime: Runtime,
    owner: Owner,
    stop: Stop | None,
    deadline: float,
    stopped: asyncio.Event,
    reasons: list[Literal["cancelled", "deadline", "claim_lost"]],
) -> None:
    """Set ``stopped`` once the owner asks, the claim is lost, or the deadline passes.

    justify-polling: a stop request and the job lease are rows another process
    writes; one fresh indexed read pair per poll, for the life of one generation.
    """

    while True:
        if time.monotonic() >= deadline:
            reasons.append("deadline")
        else:
            with runtime.session_factory() as db:
                if stop is not None and stop(db):
                    reasons.append("cancelled")
                elif not running_job_claim_is_current(db, context=owner.job):
                    reasons.append("claim_lost")
        if reasons:
            stopped.set()
            return
        await asyncio.sleep(STOP_POLL_SECONDS)


def _expected_failure(error: Exception) -> tuple[FailureCode, str] | None:
    """The one map from route exceptions to failure codes; None is a defect."""

    from llm_agent_kernel import NativeDefect, NativeUncertain, ProviderContainmentViolation
    from llm_agent_kernel.generation import GenerationDefect
    from provider_runtime.agent_runtime import (
        AgentRuntimeDefect,
        AgentRuntimeError,
        CredentialRejected,
        CredentialUnavailable,
        InvalidAgentRequest,
    )
    from provider_runtime.errors import CredentialMissing, RuntimeDefect
    from provider_runtime.errors import CredentialRejected as ApiCredentialRejected

    from nexus.services.tool_authority import ToolAuthorityRefused

    detail = f"{type(error).__name__}: {error}"[:500]
    if isinstance(error, ToolAuthorityRefused | NativeUncertain):
        return "interrupted", detail
    if isinstance(
        error,
        CredentialUnavailable | CredentialRejected | CredentialMissing | ApiCredentialRejected,
    ):
        return "auth", detail
    if isinstance(error, ProviderContainmentViolation):
        return "policy_violation", detail
    if isinstance(
        error,
        InvalidAgentRequest | AgentRuntimeDefect | NativeDefect | RuntimeDefect | GenerationDefect,
    ):
        return "defect", detail
    if isinstance(error, AgentRuntimeError):
        return "runtime_unavailable", detail
    return None
