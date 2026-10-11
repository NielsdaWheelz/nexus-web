"""One generation's tools: composition, the dispatcher and the one ``tool_calls`` row.

``run_tool`` is the only callback generation core holds. A granted call writes its row
(and, in a chat, its start frames) before it runs, then completes the row in the
transaction that commits its effects, under the fence: generation open, job claim
live, chat run running. Nothing is replayed; a repeated call runs again.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from llm_tools import (
    Available,
    BoundaryFailure,
    BraveSearchProvider,
    CapabilityProfile,
    DeclaredToolFailure,
    EffectiveToolGrant,
    FrozenToolPlan,
    HandlerSuccess,
    Native,
    PolicyEpoch,
    ProfileId,
    PromptAttribute,
    PromptAttributeName,
    PromptJson,
    PromptSection,
    PromptSectionKind,
    PromptSections,
    ReplayPolicy,
    RunLimits,
    SafeWebReader,
    SchemaDecodeError,
    ToolBinding,
    ToolCatalog,
    ToolFamily,
    ToolGrant,
    ToolId,
    ToolPlan,
    ToolResult,
    Unavailable,
    WebSearchProvider,
    bind_brave_web_search,
    bind_web_read,
    canonical_json_bytes,
    render_prompt,
    validate_tool_input,
    web_family,
)
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Settings
from nexus.db.async_session import open_async_session
from nexus.db.models import ChatRun
from nexus.jobs.queue import lock_running_job_claim
from nexus.schemas.conversation import (
    ChatRunToolCallDoneEventOut,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
)
from nexus.schemas.presence import Presence
from nexus.services.chat import events
from nexus.services.chat.citations import number_candidates
from nexus.services.chat.retrievals import RetrievalCitation, insert_retrieval
from nexus.services.generation.contract import Owner
from nexus.services.generation.ledger import lock_open_generation
from nexus.services.tools import contract, memory, reads, writes

type ArgumentRefusal = Literal["InvalidJson", "InputTooLarge"]

_ONE_AT_A_TIME = RunLimits(None, None, None, None, max_in_flight=1, max_elapsed_seconds=None)
_EMBEDDED = ("nexus.search", "nexus.document.search")


class ToolRefused(RuntimeError):
    """The generation closed, or its job claim or chat run is no longer live."""


@dataclass(frozen=True, slots=True)
class Plan:
    """One frozen plan: what a transport publishes and what ``run_tool`` admits."""

    id: str
    tools: FrozenToolPlan
    writes: bool  # grants a Nexus write: the generation's effect mode

    def unavailable(self) -> tuple[str, ...]:
        """Granted tools whose binding cannot run; admission refuses such a plan."""

        return tuple(
            str(grant.id)
            for grant in self.tools.profile.ordered_grants
            if not isinstance(self.tools.catalog_view.binding(grant.id).execute, Available)
        )


@dataclass(frozen=True, slots=True)
class Toolbox:
    plans: dict[str, Plan]
    memory_config: Presence[memory.MemoryClientConfig]


def compose_tools(
    search: WebSearchProvider | None,
    *,
    embedding_available: bool,
    memory_config: Presence[memory.MemoryClientConfig],
) -> Toolbox:
    """The one process-owned catalogue and its frozen plans."""

    def nexus(spec: Any) -> ToolBinding[Any, Any, Any]:
        tool_id = str(spec.id)
        handler = reads.HANDLERS.get(tool_id) or writes.HANDLERS[tool_id]
        return ToolBinding(
            spec=spec,
            execute=Unavailable("embedding credential is not configured")
            if tool_id in _EMBEDDED and not embedding_available
            else Available(handler if inspect.iscoroutinefunction(handler) else _synced(handler)),
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision="nexus-tools.v8",
            policy_epoch=PolicyEpoch("nexus-v1"),
            policy_inputs={},
        )

    catalog = ToolCatalog.compose(
        (
            web_family(
                search=None if search is None else bind_brave_web_search(search, max_results=6),
                read=bind_web_read(SafeWebReader()),
            ),
            ToolFamily("nexus", contract.NEXUS_SPECS, tuple(map(nexus, contract.NEXUS_SPECS))),
            memory.family(memory_config),
        )
    )
    plans = {}
    for plan_id, tool_ids in contract.PLANS.items():
        profile = CapabilityProfile(
            id=ProfileId(re.sub(r"(?<!^)(?=[A-Z])", "_", plan_id).lower()),
            grants=tuple(ToolGrant(id=ToolId(tool_id), limits=None) for tool_id in tool_ids),
            run_limits=_ONE_AT_A_TIME,
        ).freeze(catalog)
        frozen = ToolPlan(profile=profile.id, exposure=Native()).freeze(catalog, profile)
        plans[plan_id] = Plan(plan_id, frozen, any(t in contract.WRITES for t in tool_ids))
    return Toolbox(plans, memory_config)


def _synced(handler: Callable[[Any, Call], Any]) -> Callable[[Any, Call], Awaitable[Any]]:
    """A sync handler runs on the call's session through the greenlet bridge, off no thread."""

    async def run(value: Any, call: Call) -> Any:
        return await call.database.run_sync(lambda _: handler(value, call))

    return run


def configured_web_search(
    client: httpx.AsyncClient, settings: Settings
) -> WebSearchProvider | None:
    """The one Brave dependency every process shares; None without a key."""

    if settings.brave_search_api_key is None:
        return None
    return BraveSearchProvider(
        client,
        api_key=settings.brave_search_api_key,
        base_url=settings.brave_search_base_url,
        timeout_seconds=settings.brave_search_timeout_seconds,
    )


@dataclass(frozen=True, slots=True)
class ToolRun:
    """One open generation's authority; generation core builds it once per generation."""

    sessions: sessionmaker[Session]
    owner: Owner
    generation_id: UUID
    generation_seq: int
    plan: Plan
    scope: frozenset[str]  # admitted resource URIs; arguments and outputs never widen it

    @property
    def chat_run_id(self) -> UUID | None:
        return self.owner.id if self.owner.kind == "chat_run" else None


@dataclass(slots=True)
class Call:
    """One dispatched call as its handler sees it. Sync work goes through ``database``."""

    run: ToolRun
    id: UUID  # the row id and the effect id sub-effects derive from
    tool_id: str
    database: AsyncSession
    grant: EffectiveToolGrant  # llm_tools' web handlers read ``grant.limits``
    created_refs: list[dict[str, Any]] = field(default_factory=list)
    retrieved: list[RetrievalCitation] = field(default_factory=list)
    selected: list[RetrievalCitation] = field(default_factory=list)

    @property
    def db(self) -> Session:
        return self.database.sync_session

    @property
    def principal(self) -> UUID:
        return self.run.owner.user_id

    def fence(self) -> ChatRun | None:
        """Lock the open generation, the live chat run and the job claim until commit."""

        if not lock_open_generation(self.db, generation_id=self.run.generation_id):
            raise ToolRefused("generation is closed")
        chat_run = None
        if self.run.chat_run_id is not None:
            chat_run = events.lock_run(self.db, self.run.chat_run_id)
            if chat_run is None or chat_run.status != "running" or chat_run.cancel_requested_at:
                raise ToolRefused("chat run is not live")
        if not lock_running_job_claim(self.db, context=self.run.owner.job):
            raise ToolRefused("worker lease is absent or expired")
        return chat_run


@dataclass(frozen=True, slots=True)
class ToolOutput:
    call_id: UUID | None  # None: the name is outside the plan and left no row
    result: ToolResult
    text: str  # what the model reads: the result, with numbered citations in a chat

    @property
    def is_error(self) -> bool:
        return self.result["type"] == "Failure"


def _failure(error_type: str) -> ToolResult:
    return {"type": "Failure", "error": {"type": error_type}}


async def run_tool(
    run: ToolRun, tool_id: str, arguments: dict[str, Any] | ArgumentRefusal
) -> ToolOutput:
    """Run one model call. ``arguments`` is its JSON object, or why the transport refused it."""

    if tool_id not in contract.PLANS[run.plan.id]:
        unavailable = _failure("ToolUnavailable")
        return ToolOutput(None, unavailable, canonical_json_bytes(unavailable).decode())
    binding = run.plan.tools.catalog_view.binding(ToolId(tool_id))
    async with open_async_session(run.sessions) as database:
        call = Call(run, uuid4(), tool_id, database, run.plan.tools.grant(binding.spec.id))
        position = await database.run_sync(lambda _: _start(call, arguments))
        result = await _dispatch(call, binding, arguments)
        model_text = await database.run_sync(lambda _: _complete(call, position, result))
    return ToolOutput(call.id, result, model_text)


def _start(call: Call, arguments: dict[str, Any] | ArgumentRefusal) -> int:
    """The running row at the next dense position, and the chat's start frames."""

    db = call.db
    chat_run = call.fence()
    position = db.execute(
        text("SELECT coalesce(max(position), 0) + 1 FROM tool_calls WHERE generation_id = :id"),
        {"id": call.run.generation_id},
    ).scalar_one()
    db.execute(
        text(
            "INSERT INTO tool_calls (id, generation_id, generation_seq, position,"
            " principal_user_id, assistant_message_id, tool_id, arguments, status)"
            " VALUES (:id, :generation, :seq, :position, :principal, :answer, :tool,"
            " :arguments, 'running')"
        ).bindparams(bindparam("arguments", type_=JSONB(none_as_null=True))),
        {
            "id": call.id,
            "generation": call.run.generation_id,
            "seq": call.run.generation_seq,
            "position": position,
            "principal": call.principal,
            "answer": chat_run.assistant_message_id if chat_run else None,
            "tool": call.tool_id,
            "arguments": arguments if isinstance(arguments, dict) else None,
        },
    )
    if chat_run is not None:
        started = ChatRunToolCallStartEventOut(
            **contract.projection(call.tool_id),
            error_type=None,
            tool_call_id=call.id,
            tool_call_index=position,
        )
        events.append(db, chat_run, started)
        shown = arguments if isinstance(arguments, dict) else {"invalid_arguments": True}
        events.append(
            db, chat_run, ChatRunToolCallDoneEventOut(**started.model_dump(), input=shown)
        )
    db.commit()
    return position


async def _dispatch(
    call: Call, binding: ToolBinding[Any, Any, Any], arguments: dict[str, Any] | ArgumentRefusal
) -> ToolResult:
    """Validate, bound and run the handler; every expected refusal is a Failure result."""

    limits = call.grant.limits
    if isinstance(arguments, str):
        return _failure("InvalidInput" if arguments == "InvalidJson" else "BudgetExceeded")
    if (
        len(canonical_json_bytes({"type": "ParsedJson", "value": arguments}))
        > limits.max_input_bytes
    ):
        return _failure("BudgetExceeded")
    if not isinstance(binding.execute, Available):
        return _failure("ToolUnavailable")
    try:
        value = validate_tool_input(binding, arguments)
    except SchemaDecodeError:
        return _failure("InvalidInput")
    try:
        async with asyncio.timeout(limits.deadline_seconds):
            success = await binding.execute.handler(value, call)
    except DeclaredToolFailure as failure:
        error = failure.error
        encoded = error.model_dump(mode="json") if isinstance(error, BaseModel) else error
        return {"type": "Failure", "error": encoded}
    except BoundaryFailure as failure:
        return _failure(failure.error_type)
    except TimeoutError:
        return _failure("DeadlineExceeded")
    if isinstance(success, HandlerSuccess):  # llm_tools' own web handlers
        success = success.value
    return {"type": "Success", "value": success.model_dump(mode="json")}


def _complete(call: Call, position: int, result: ToolResult) -> str:
    """Complete the row with the call's effects (none on Failure), then the chat's view."""

    db = call.db
    if result["type"] == "Failure":
        db.rollback()  # a refused or timed-out call leaves no effect
        call.created_refs, call.retrieved, call.selected = [], [], []
    encoded = canonical_json_bytes(result)
    if len(encoded) > call.grant.limits.max_output_bytes:
        raise AssertionError(f"{call.tool_id} result exceeds its declared output limit")
    # the run before the row, as every chat writer locks them.
    chat_run = events.lock_run(db, call.run.chat_run_id) if call.run.chat_run_id else None
    db.execute(
        text(
            "UPDATE tool_calls SET result = :result, created_refs = :refs, status = :status"
            " WHERE id = :id"
        ).bindparams(bindparam("result", type_=JSONB), bindparam("refs", type_=JSONB)),
        {
            "id": call.id,
            "result": result,
            "refs": call.created_refs,
            "status": "complete" if result["type"] == "Success" else "error",
        },
    )
    model_text = encoded.decode()
    if chat_run is not None:
        model_text = _project(call, chat_run, position, result) or model_text
    db.commit()
    return model_text


def _project(call: Call, chat_run: ChatRun, position: int, result: ToolResult) -> str | None:
    """The chat's view of a finished call: retrievals, the result frame, numbered citations."""

    db = call.db
    if call.tool_id == "web.search" and result["type"] == "Success":
        reads.web_citations(call, result["value"])
    scope = "public_web" if call.tool_id.startswith("web.") else "conversation_context"
    for ordinal, citation in enumerate(call.retrieved):
        insert_retrieval(
            db,
            assistant_message_id=chat_run.assistant_message_id,
            tool_call_id=call.id,
            ordinal=ordinal,
            citation=citation,
            selected=citation in call.selected,
            scope=scope,
            retrieval_status="retrieved",
        )
    error = str(result["error"]["type"]) if result["type"] == "Failure" else None
    finished = ChatRunToolResultEventOut(
        **contract.projection(call.tool_id),
        error_type=error,
        tool_call_id=call.id,
        tool_call_index=position,
        status="error" if error else "complete",
    )
    events.append(db, chat_run, finished)
    numbered = number_candidates(
        db, assistant_message_id=chat_run.assistant_message_id, tool_call_id=call.id
    )
    citations = [
        PromptSection(
            PromptSectionKind("tool_citation"),
            (
                PromptAttribute(PromptAttributeName("n"), row.candidate_ordinal),
                PromptAttribute(PromptAttributeName("retrieval_ordinal"), row.retrieval_ordinal),
            ),
            PromptJson(row.result_ref),
        )
        for row in numbered
        if row.candidate_ordinal is not None
    ]
    if not citations:
        return None
    sections = [PromptSection(PromptSectionKind("payload"), (), PromptJson(result)), *citations]
    return render_prompt(
        PromptSection(PromptSectionKind("tool_result"), (), PromptSections(tuple(sections)))
    )
