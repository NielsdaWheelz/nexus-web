"""Pinned Codex MCP adapter for a leased ChatTools attempt.

The SDK owns JSON-RPC and Streamable HTTP.  This module owns only the bearer
gate, grant-to-run authorization, declaration projection, and the handoff to
the existing durable Chat executor.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final, Literal, cast
from uuid import UUID

from fastapi import Request
from llm_tools import (
    EffectId,
    ParsedJson,
    ToolEffect,
    ToolExecutor,
    ToolId,
    ToolResult,
    canonical_json_bytes,
    raw_input_digest,
)
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.tools import Tool
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.exceptions import MCPError
from mcp_types import INVALID_REQUEST, CallToolResult, TextContent
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from nexus.db.models import ChatRun
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResourceClass,
    get_job,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.services.agent_tool_grants import AgentToolGrantClaims, verify_agent_tool_grant
from nexus.services.chat_run_event_store import lock_chat_run_for_update
from nexus.services.llm_ledger import (
    GenerationRecord,
    LlmCallOwner,
    current_tool_plan_fingerprint,
    lock_active_generation_for_authority_in_current_transaction,
)

if TYPE_CHECKING:
    from nexus.config import Settings
    from nexus.services.chat_run_tools import ToolStepResult
    from nexus.services.tool_runtime.composition import FrozenToolOperation
    from nexus.services.tool_runtime.declarations import PresentedToolDeclaration

MCP_PATH: Final[str] = "/internal/agent-tools/mcp"
MCP_PROTOCOL_VERSION: Final[str] = "2025-06-18"
_MCP_SERVER_NAME: Final[str] = "nexus"
_MCP_JSON_CONTENT_TYPE: Final[bytes] = b"application/json"
_MCP_STREAMABLE_HTTP_ACCEPT: Final[bytes] = b"application/json, text/event-stream"
MAX_MCP_REQUEST_BODY_BYTES: Final[int] = 512 * 1024
MCP_RATE_WINDOW_SECONDS: Final[float] = 60.0
MCP_RATE_BURST: Final[int] = 120
MCP_TOOL_DRAIN_TIMEOUT_SECONDS: Final[float] = 35.0
_MAX_JSON_RPC_INTEGER: Final[int] = 2**63 - 1
_MAX_JSON_RPC_STRING: Final[int] = 256

type AgentToolRequestAuthorizer = Callable[[AgentToolGrantClaims], Awaitable[bool]]


@dataclass(frozen=True, slots=True)
class JsonRpcId:
    """Typed JSON-RPC identity preserving integer ``1`` versus string ``"1"``."""

    kind: Literal["integer", "string"]
    value: int | str

    def __post_init__(self) -> None:
        if self.kind == "integer" and (
            not isinstance(self.value, int) or isinstance(self.value, bool)
        ):
            raise ValueError("integer JSON-RPC id has the wrong value type")
        if self.kind == "integer" and abs(cast(int, self.value)) > _MAX_JSON_RPC_INTEGER:
            raise ValueError("integer JSON-RPC id is too large")
        if self.kind == "string" and (
            not isinstance(self.value, str)
            or not self.value
            or len(self.value) > _MAX_JSON_RPC_STRING
        ):
            raise ValueError("string JSON-RPC id is empty or too long")

    @classmethod
    def from_raw(cls, value: object) -> JsonRpcId:
        if isinstance(value, bool) or value is None:
            raise ValueError("JSON-RPC id must be an integer or string")
        if isinstance(value, int):
            return cls("integer", value)
        if isinstance(value, str):
            return cls("string", value)
        raise ValueError("JSON-RPC id must be an integer or string")

    @classmethod
    def integer(cls, value: int) -> JsonRpcId:
        return cls("integer", value)

    @classmethod
    def string(cls, value: str) -> JsonRpcId:
        return cls("string", value)

    def key(self) -> str:
        return f"{self.kind}:{self.value}"

    def position(self, generation_seq: int, tool_index: int) -> str:
        if generation_seq < 1 or tool_index < 1:
            raise ValueError("generation and tool positions are positive")
        return f"generation/{generation_seq}/tool/{tool_index}"


class _PolicyViolation(Exception):
    def __init__(self, generation_id: UUID) -> None:
        super().__init__("MCP call is outside the active generation policy")
        self.generation_id = generation_id


class _CancellationRequested(Exception):
    pass


@dataclass(slots=True)
class ActiveAgentToolRegistry:
    """Process-local index of leased authorities owned by the interactive worker.

    The registry contains no ORM objects or sessions.  DB lease and generation
    checks remain authoritative on every routed call; this index only selects
    the currently live authority for a signed grant.
    """

    session_factory: sessionmaker[Session]
    _authorities: dict[tuple[str, str, str, str, int, str], AgentToolAuthority] = field(
        default_factory=dict
    )
    _notified: set[UUID] = field(default_factory=set)
    _registry_lock: Any = field(default_factory=threading.RLock, repr=False)
    _operation: FrozenToolOperation | None = None

    def bind_operation(self, operation: FrozenToolOperation) -> None:
        """Install the listener-loop-owned Chat operation before serving."""

        with self._registry_lock:
            if self._operation is not None or self._authorities:
                raise RuntimeError("agent-tool listener operation is already bound")
            self._operation = operation

    def unbind_operation(self, operation: FrozenToolOperation) -> None:
        """Remove the listener operation only after all authorities have closed."""

        with self._registry_lock:
            if self._authorities:
                raise RuntimeError("agent-tool listener stopped with active authorities")
            if self._operation is not operation:
                raise RuntimeError("agent-tool listener operation identity changed")
            self._operation = None

    def operation_for(self, admitted: FrozenToolOperation) -> FrozenToolOperation:
        """Return the listener-owned handlers under the admitted frozen plan."""

        with self._registry_lock:
            operation = self._operation
        if operation is None:
            raise RuntimeError("agent-tool listener operation is not ready")
        if (
            operation.profile != admitted.profile
            or operation.plan.plan_revision != admitted.plan.plan_revision
        ):
            raise RuntimeError("agent-tool listener operation differs from Chat admission")
        return operation

    def register(self, authority: AgentToolAuthority) -> None:
        key = (
            str(authority.run_id),
            str(authority.job_id),
            str(authority.generation_id),
            authority.worker_id,
            authority.attempt_no,
            authority.grant_jti,
        )
        with self._registry_lock:
            existing = self._authorities.get(key)
            if existing is not None and existing is not authority:
                raise RuntimeError("agent-tool authority identity is already active")
            self._authorities[key] = authority

    def unregister(self, authority: AgentToolAuthority) -> None:
        key = (
            str(authority.run_id),
            str(authority.job_id),
            str(authority.generation_id),
            authority.worker_id,
            authority.attempt_no,
            authority.grant_jti,
        )
        with self._registry_lock:
            if self._authorities.get(key) is authority:
                self._authorities.pop(key, None)
                self._notified.discard(authority.generation_id)

    def resolve(self, claims: AgentToolGrantClaims) -> AgentToolAuthority | None:
        with self._registry_lock:
            return self._authorities.get(
                (
                    claims.run_id,
                    claims.job_id,
                    claims.generation_id,
                    claims.worker_id,
                    claims.attempt_no,
                    claims.jti,
                )
            )

    async def notify_policy_once(
        self, generation_id: UUID, callback: Callable[[UUID], Awaitable[None]]
    ) -> None:
        with self._registry_lock:
            if generation_id in self._notified:
                return
            self._notified.add(generation_id)
        try:
            await callback(generation_id)
        except BaseException:
            with self._registry_lock:
                self._notified.discard(generation_id)
            raise

    def database_now(self) -> datetime:
        with self.session_factory() as db:
            value = db.scalar(text("SELECT clock_timestamp()"))
        if not isinstance(value, datetime):
            raise RuntimeError("database clock did not return a timestamp")
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


_ACTIVE_REGISTRY: ActiveAgentToolRegistry | None = None


def set_active_agent_tool_registry(registry: ActiveAgentToolRegistry | None) -> None:
    """Install the interactive-worker registry for generation lifecycle hooks."""
    global _ACTIVE_REGISTRY
    _ACTIVE_REGISTRY = registry


def active_agent_tool_registry() -> ActiveAgentToolRegistry | None:
    return _ACTIVE_REGISTRY


class _AuthorityRouter:
    def __init__(self, registry: ActiveAgentToolRegistry) -> None:
        self.registry = registry

    def has_tool(self, tool_id: str) -> bool:
        # Declaration projection is process-constant; this does not authorize
        # a call, which still resolves a signed grant and rechecks the ledger.
        from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

        return any(str(entry.spec.id) == tool_id for entry in CHAT_TOOL_DECLARATIONS)

    async def authorize_request(
        self,
        *,
        claims: AgentToolGrantClaims,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> bool:
        authority = self.registry.resolve(claims)
        if authority is None:
            await self.registry.notify_policy_once(
                UUID(claims.generation_id),
                on_policy_violation,
            )
            return False
        return await authority.authorize_request(
            claims=claims,
            on_policy_violation=on_policy_violation,
        )

    async def invoke(self, **kwargs: Any) -> Any:
        claims = cast(AgentToolGrantClaims, kwargs["claims"])
        authority = self.registry.resolve(claims)
        if authority is None:
            callback = cast(Callable[[UUID], Awaitable[None]], kwargs["on_policy_violation"])
            await self.registry.notify_policy_once(UUID(claims.generation_id), callback)
            raise MCPError(
                code=INVALID_REQUEST,
                message="MCP call is outside the active generation policy",
            )
        return await authority.invoke(**kwargs)

    async def reject_unknown(self, **kwargs: Any) -> Any:
        claims = cast(AgentToolGrantClaims, kwargs["claims"])
        authority = self.registry.resolve(claims)
        if authority is None:
            callback = cast(Callable[[UUID], Awaitable[None]], kwargs["on_policy_violation"])
            await self.registry.notify_policy_once(UUID(claims.generation_id), callback)
            raise MCPError(
                code=INVALID_REQUEST,
                message="MCP call is outside the active generation policy",
            )
        return await authority.reject_unknown(**kwargs)


class _AgentToolsMCPServer(MCPServer[Any]):
    """MCP handler with durable unknown-tool rejection below the SDK gate."""

    def __init__(
        self,
        *,
        authority: Any,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
        tools: list[Tool],
        lifespan: Callable[[Any], AbstractAsyncContextManager[Any]] | None = None,
    ) -> None:
        super().__init__(
            name=_MCP_SERVER_NAME,
            version="nexus-agent-tools-2025-06-18",
            tools=tools,
            lifespan=lifespan,
        )
        self._agent_tool_authority = authority
        self._on_policy_violation = on_policy_violation

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: Context[Any, Any] | None = None,
    ) -> Any:
        if context is None:
            raise MCPError(code=INVALID_REQUEST, message="MCP request context is required")
        request = cast(Request, context.request_context.request)
        claims = cast(AgentToolGrantClaims, request.state.agent_tool_grant)
        request_id = JsonRpcId.from_raw(context.request_context.request_id)
        if self._agent_tool_authority.has_tool(name):
            receipt = await self._agent_tool_authority.invoke(
                tool_id=name,
                arguments=arguments,
                request_id=request_id,
                claims=claims,
                on_policy_violation=self._on_policy_violation,
            )
            return _wire_tool_result(receipt)
        if not 1 <= len(name) <= 128:
            raise MCPError(
                code=INVALID_REQUEST,
                message="MCP tool name must contain 1-128 characters",
            )
        receipt = await self._agent_tool_authority.reject_unknown(
            provider_wire_name=name,
            arguments=arguments,
            request_id=request_id,
            claims=claims,
            on_policy_violation=self._on_policy_violation,
        )
        return _wire_tool_result(receipt)


@dataclass(slots=True)
class AgentToolAuthority:
    """Lease-scoped authority that delegates execution to Nexus' real runtime."""

    session_factory: sessionmaker[Session]
    run_id: UUID
    job_id: UUID
    attempt_no: int
    resource_class: JobResourceClass
    operation: FrozenToolOperation
    worker_id: str
    generation_id: UUID
    grant_jti: str
    admitted_resource_uris: frozenset[str]
    _notified_policy_violations: set[UUID] = field(default_factory=set)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _activity_lock: Any = field(default_factory=threading.Lock, repr=False)
    _idle: Any = field(default_factory=threading.Event, repr=False)
    _active_calls: int = 0
    _accepting_calls: bool = True

    def __post_init__(self) -> None:
        try:
            if str(UUID(self.grant_jti)) != self.grant_jti:
                raise ValueError
        except ValueError as exc:
            raise ValueError("agent-tool authority grant jti must be a canonical UUID") from exc
        self._idle.set()

    def has_tool(self, tool_id: str) -> bool:
        try:
            self.operation.plan.catalog_view.binding(ToolId(tool_id))
        except (KeyError, ValueError):
            return False
        return True

    def close(self) -> None:
        """Remove this authority after the generation reaches a terminal state."""
        registry = active_agent_tool_registry()
        if registry is not None:
            registry.unregister(self)

    async def wait_until_idle(self) -> None:
        """Close admission and drain accepted work before folding a host terminal."""

        with self._activity_lock:
            self._accepting_calls = False
        idle = await asyncio.to_thread(self._idle.wait, MCP_TOOL_DRAIN_TIMEOUT_SECONDS)
        if not idle:
            raise RuntimeError("active MCP tool call did not drain before its bounded deadline")

    def _call_started(self) -> None:
        with self._activity_lock:
            if not self._accepting_calls:
                raise _PolicyViolation(self.generation_id)
            self._active_calls += 1
            self._idle.clear()

    def _call_finished(self) -> None:
        with self._activity_lock:
            self._active_calls -= 1
            if self._active_calls < 0:
                raise AssertionError("MCP active-call count became negative")
            if self._active_calls == 0:
                self._idle.set()

    @classmethod
    def from_claimed_chat_attempt(
        cls,
        *,
        session_factory: sessionmaker[Session],
        run_id: UUID,
        job_id: UUID,
        attempt_no: int,
        resource_class: JobResourceClass,
        operation: FrozenToolOperation,
        worker_id: str,
        generation_id: UUID,
        grant_jti: str,
        admitted_resource_uris: tuple[str, ...],
    ) -> AgentToolAuthority:
        with session_factory() as db:
            run = db.get(ChatRun, run_id)
            job = get_job(db, job_id)
            if run is None or job is None:
                raise ValueError("claimed Chat attempt does not exist")
            if job.claimed_by != worker_id or job.attempts != attempt_no:
                raise ValueError("claimed Chat job identity does not match worker attempt")
        from nexus.services.generation_policy import TOOL_PLAN_REVISION

        if str(operation.plan.plan_revision) != TOOL_PLAN_REVISION:
            raise ValueError("Chat tool plan is not the pinned generation policy plan")
        registry = active_agent_tool_registry()
        execution_operation = (
            registry.operation_for(operation) if registry is not None else operation
        )
        authority = cls(
            session_factory=session_factory,
            run_id=run_id,
            job_id=job_id,
            attempt_no=attempt_no,
            resource_class=resource_class,
            operation=execution_operation,
            worker_id=worker_id,
            generation_id=generation_id,
            grant_jti=grant_jti,
            admitted_resource_uris=frozenset(admitted_resource_uris),
        )
        if registry is not None:
            registry.register(authority)
        return authority

    async def invoke(
        self,
        *,
        tool_id: str,
        arguments: dict[str, Any],
        request_id: JsonRpcId,
        claims: AgentToolGrantClaims,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> Any:
        started = False
        try:
            self._call_started()
            started = True
            async with self._lock:
                binding = self.operation.plan.catalog_view.binding(ToolId(tool_id))
                digest = raw_input_digest(ParsedJson(arguments))
                try:
                    from nexus.services.chat_run_tools import ToolStepResult
                    from nexus.services.tool_runtime.execution import (
                        chat_tool_execution_receipt,
                    )

                    receipt: ToolStepResult
                    citation_ordinal: int
                    provider_call_id: str
                    journal_key: str
                    result: ToolResult
                    context: Any
                    prior_receipt: ToolStepResult | None = None
                    with self.session_factory() as db:
                        with db.begin():
                            (
                                run,
                                job,
                                generation_seq,
                                journal,
                                journal_key,
                                tool_index,
                                citation_ordinal,
                                provider_call_id,
                            ) = self._admit(
                                db,
                                claims,
                                arguments,
                                digest,
                                request_id,
                                tool_id,
                                tool_id,
                            )
                            prior_result = journal[journal_key].get("result")
                            if prior_result is not None:
                                prior_receipt = ToolStepResult.model_validate(prior_result)
                        if prior_receipt is not None:
                            return prior_receipt
                        position = request_id.position(generation_seq, tool_index)
                        effect_id = (
                            EffectId(str(_stable_generation_id(run.id, position)))
                            if binding.spec.effect is ToolEffect.Write
                            else None
                        )
                        context = self._make_context(
                            db,
                            run=run,
                            job=job,
                            position=position,
                            tool_index=tool_index,
                            tool_id=binding.spec.id,
                            effect_id=effect_id,
                            arguments=arguments,
                        )
                        result = await ToolExecutor.execute(
                            binding,
                            ParsedJson(arguments),
                            context,
                        )
                        receipt = chat_tool_execution_receipt(
                            context,
                            result=result,
                            provider_call_id=provider_call_id,
                            starting_citation_ordinal=citation_ordinal,
                        )
                    with self.session_factory() as receipt_db:
                        with receipt_db.begin():
                            self._receipt(
                                receipt_db,
                                claims=claims,
                                digest=digest,
                                journal_key=journal_key,
                                receipt=receipt,
                            )
                except _PolicyViolation:
                    raise
                return receipt
        except _CancellationRequested as exc:
            await self._notify_once(self.generation_id, on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(exc)) from exc
        except _PolicyViolation as exc:
            await self._notify_once(exc.generation_id, on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(exc)) from exc
        finally:
            if started:
                self._call_finished()

    def _load_journal(self, db: Session) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
        payload = db.execute(
            text("SELECT payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": self.job_id},
        ).scalar_one()
        journal = payload.get("_agent_tool_calls", {}) if isinstance(payload, dict) else {}
        if not isinstance(journal, dict):
            raise RuntimeError("agent-tool journal has an invalid shape")
        return dict(payload), cast(dict[str, dict[str, Any]], journal)

    def _persist_journal(
        self, db: Session, payload: dict[str, Any], journal: dict[str, dict[str, Any]]
    ) -> None:
        payload["_agent_tool_calls"] = journal
        if not update_running_job_payload(
            db,
            job_id=self.job_id,
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
            payload=payload,
        ):
            raise RuntimeError("Chat job lease was lost while writing the MCP journal")

    def database_now(self) -> datetime:
        with self.session_factory() as db:
            value = db.scalar(text("SELECT clock_timestamp()"))
        if not isinstance(value, datetime):
            raise RuntimeError("database clock did not return a timestamp")
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

    async def authorize_request(
        self,
        *,
        claims: AgentToolGrantClaims,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> bool:
        """Revalidate live owner authority before any MCP request body is read."""

        try:
            with self.session_factory() as db:
                with db.begin():
                    self._authorize_in_current_transaction(db, claims)
        except _CancellationRequested:
            await self._notify_once(self.generation_id, on_policy_violation)
            return False
        except _PolicyViolation as exc:
            await self._notify_once(exc.generation_id, on_policy_violation)
            return False
        return True

    def _authorize_in_current_transaction(
        self,
        db: Session,
        claims: AgentToolGrantClaims | None,
        *,
        allow_missing_claim: bool = False,
    ) -> tuple[GenerationRecord, ChatRun, Any]:
        """Lock and validate generation, run, then job in the canonical order."""

        generation = lock_active_generation_for_authority_in_current_transaction(
            db,
            owner=LlmCallOwner(kind="chat_run", id=self.run_id),
            generation_id=self.generation_id,
        )
        if generation is None:
            raise _PolicyViolation(self.generation_id)
        run = lock_chat_run_for_update(db, self.run_id)
        if run is None:
            raise _PolicyViolation(self.generation_id)
        context = JobExecutionContext(
            job_id=self.job_id,
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
            resource_class=self.resource_class,
        )
        if not lock_running_job_claim(db, context=context):
            raise _PolicyViolation(self.generation_id)
        job = get_job(db, self.job_id)
        if job is None or job.status != "running":
            raise _PolicyViolation(self.generation_id)
        if run.cancel_requested_at is not None:
            raise _CancellationRequested("Chat run cancellation was requested")
        if (
            run.status != "running"
            or job.claimed_by != self.worker_id
            or job.attempts != self.attempt_no
        ):
            raise _PolicyViolation(self.generation_id)
        if claims is not None:
            valid = (
                claims.sub == str(run.owner_user_id)
                and claims.run_id == str(run.id)
                and claims.job_id == str(job.id)
                and claims.worker_id == self.worker_id
                and claims.attempt_no == self.attempt_no
                and claims.generation_id == str(self.generation_id)
                and claims.jti == self.grant_jti
                and _grant_matches_generation(claims, generation)
            )
        else:
            valid = allow_missing_claim
        if not valid:
            raise _PolicyViolation(self.generation_id)
        return generation, run, job

    def _admit(
        self,
        db: Session,
        claims: AgentToolGrantClaims | None,
        arguments: Mapping[str, Any],
        digest: str | None,
        request_id: JsonRpcId,
        canonical_tool_id: str | None,
        provider_wire_name: str | None,
        *,
        allow_missing_claim: bool = False,
    ) -> tuple[ChatRun, Any, int, dict[str, dict[str, Any]], str, int, int, str]:
        generation, run, job = self._authorize_in_current_transaction(
            db,
            claims,
            allow_missing_claim=allow_missing_claim,
        )
        payload, journal = self._load_journal(db)
        journal_key = (
            f"{claims.jti}:{request_id.key()}" if claims is not None else f"undo:{request_id.key()}"
        )
        provider_call_id = f"mcp:{request_id.kind}:{request_id.value}"
        citation_ordinal, next_tool_index = self._journal_tail(
            payload=payload,
            journal=journal,
            replay_key=journal_key,
        )
        previous = journal.get(journal_key)
        if previous is not None:
            expected = {
                "digest": digest,
                "generation_seq": generation.generation_seq,
                "request_id": {"kind": request_id.kind, "value": request_id.value},
                "provider_call_id": provider_call_id,
                "provider_wire_name": provider_wire_name,
                "canonical_tool_id": canonical_tool_id,
            }
            if any(previous.get(field) != value for field, value in expected.items()):
                raise RuntimeError("MCP replay identity was reused with a different input digest")
            return (
                run,
                job,
                generation.generation_seq,
                journal,
                journal_key,
                int(previous["tool_index"]),
                int(previous["citation_ordinal"]),
                provider_call_id,
            )
        if canonical_tool_id is not None:
            from nexus.services.tool_runtime.resource_scope import (
                tool_arguments_within_admitted_scope,
            )

            if not tool_arguments_within_admitted_scope(
                db,
                tool_id=canonical_tool_id,
                arguments=arguments,
                admitted_resource_uris=self.admitted_resource_uris,
            ):
                raise _PolicyViolation(self.generation_id)
        if digest is None:
            return (
                run,
                job,
                generation.generation_seq,
                journal,
                journal_key,
                0,
                citation_ordinal,
                provider_call_id,
            )
        if provider_wire_name is None:
            raise RuntimeError("MCP tool admission omitted its provider wire name")
        tool_index = next_tool_index
        entry = {
            "digest": digest,
            "generation_seq": generation.generation_seq,
            "tool_index": tool_index,
            "citation_ordinal": citation_ordinal,
            "request_id": {"kind": request_id.kind, "value": request_id.value},
            "provider_call_id": provider_call_id,
            "provider_wire_name": provider_wire_name,
            "canonical_tool_id": canonical_tool_id,
        }
        journal[journal_key] = entry
        self._stage_tool_admission_events(
            db,
            run=run,
            canonical_tool_id=canonical_tool_id,
            provider_wire_name=provider_wire_name,
            arguments=arguments,
            digest=digest,
            provider_call_id=provider_call_id,
            tool_index=tool_index,
        )
        if canonical_tool_id is not None:
            from nexus.services.tool_runtime.execution import (
                stage_chat_tool_pre_dispatch_admission,
            )

            payload = stage_chat_tool_pre_dispatch_admission(
                db=db,
                operation=self.operation,
                run=run,
                payload=payload,
                durable_step_path=request_id.position(generation.generation_seq, tool_index),
                tool_call_index=tool_index,
                tool_id=ToolId(canonical_tool_id),
                input_digest=digest,
                arguments=arguments,
                provider_wire_name=provider_wire_name,
            )
        self._persist_journal(db, payload, journal)
        return (
            run,
            job,
            generation.generation_seq,
            journal,
            journal_key,
            tool_index,
            citation_ordinal,
            provider_call_id,
        )

    def _journal_tail(
        self,
        *,
        payload: dict[str, Any],
        journal: dict[str, dict[str, Any]],
        replay_key: str,
    ) -> tuple[int, int]:
        from nexus.services.chat_run_steps import (
            ToolJournalResultEnvelope,
            decode_prepared,
        )
        from nexus.services.durable_step_journal import decode_step_states

        prepare_state = decode_step_states(payload).get("prepare")
        if prepare_state is None:
            raise RuntimeError("MCP admission requires a completed Chat prepare step")
        prepared = decode_prepared(prepare_state)
        cursor = prepared.initial_citation_ordinal
        expected_index = prepared.initial_tool_call_index + 1
        ordered: list[tuple[str, dict[str, Any]]] = []
        for key, entry in journal.items():
            if (
                not isinstance(entry, dict)
                or type(entry.get("generation_seq")) is not int
                or int(entry["generation_seq"]) < 1
                or type(entry.get("tool_index")) is not int
            ):
                raise RuntimeError("agent-tool journal has an invalid entry shape")
            ordered.append((key, entry))
        ordered.sort(key=lambda item: int(item[1]["tool_index"]))
        for key, entry in ordered:
            if int(entry["tool_index"]) != expected_index:
                raise RuntimeError("agent-tool journal indices are not contiguous")
            if entry.get("citation_ordinal") != cursor:
                raise RuntimeError("agent-tool journal citation cursor is not contiguous")
            result_json = entry.get("result")
            if result_json is None:
                if key != replay_key or key != ordered[-1][0]:
                    raise RuntimeError("a prior MCP call lacks its durable receipt")
                return cursor, expected_index + 1
            receipt = ToolJournalResultEnvelope.model_validate(result_json).root
            if (
                receipt.tool_call_index != expected_index
                or receipt.next_citation_ordinal < cursor
                or entry.get("next_citation_ordinal") != receipt.next_citation_ordinal
            ):
                raise RuntimeError("agent-tool journal receipt disagrees with its position")
            cursor = receipt.next_citation_ordinal
            expected_index += 1
        return cursor, expected_index

    def _stage_tool_admission_events(
        self,
        db: Session,
        *,
        run: ChatRun,
        canonical_tool_id: str | None,
        provider_wire_name: str,
        arguments: Mapping[str, Any],
        digest: str,
        provider_call_id: str,
        tool_index: int,
    ) -> None:
        from nexus.schemas.conversation import StoredToolProjection
        from nexus.services.chat_run_event_store import append_run_event
        from nexus.services.chat_run_tools import RecordKind
        from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

        if canonical_tool_id is None:
            projection = StoredToolProjection(
                record_kind=RecordKind.rejected_provider_call.value,
                canonical_tool_id=None,
                provider_wire_name=provider_wire_name,
                effect=None,
                result_kind="rejected_provider_call",
                activity_label="Skipped an unavailable tool",
                error_type=None,
                canonical_input_sha256=None,
                tool_contract_revision=None,
                binding_policy_revision=None,
            )
        else:
            binding = self.operation.plan.catalog_view.binding(ToolId(canonical_tool_id))
            presented = next(
                (
                    entry
                    for entry in CHAT_TOOL_DECLARATIONS
                    if str(entry.spec.id) == canonical_tool_id
                ),
                None,
            )
            if presented is None:
                raise RuntimeError("MCP call has no canonical presentation declaration")
            projection = StoredToolProjection(
                record_kind=RecordKind.current_execution.value,
                canonical_tool_id=canonical_tool_id,
                provider_wire_name=provider_wire_name,
                effect=binding.spec.effect,
                result_kind=presented.result_kind,
                activity_label=presented.activity_label,
                error_type=None,
                canonical_input_sha256=digest,
                tool_contract_revision=binding.spec.tool_contract_revision,
                binding_policy_revision=binding.policy_revision,
            )
        common = {
            **projection.model_dump(mode="json"),
            "tool_call_id": None,
            "assistant_message_id": str(run.assistant_message_id),
            "tool_call_index": tool_index,
            "provider_tool_call_id": provider_call_id,
            # MCP requests arrive whole. The admission ordinal is the durable
            # provider sequence for this transport; host tool frames are only
            # activity telemetry and never authority or correlation identity.
            "provider_event_seq_start": tool_index,
            "provider_event_seq_end": tool_index,
        }
        append_run_event(db, run, "tool_call_start", common)
        append_run_event(
            db,
            run,
            "tool_call_done",
            {**common, "input": dict(arguments)},
        )

    def _make_context(
        self,
        db: Session,
        *,
        run: ChatRun,
        job: Any,
        position: str,
        tool_index: int,
        tool_id: ToolId,
        effect_id: EffectId | None,
        arguments: Mapping[str, Any],
    ) -> Any:
        from nexus.services.tool_runtime.execution import make_chat_execution_context

        return make_chat_execution_context(
            db=db,
            operation=self.operation,
            run=run,
            claimed_job=job,
            job_context=JobExecutionContext(
                job_id=self.job_id,
                worker_id=self.worker_id,
                attempt_no=self.attempt_no,
                resource_class=self.resource_class,
            ),
            durable_step_path=position,
            tool_call_index=tool_index,
            admitted_resource_uris=tuple(sorted(self.admitted_resource_uris)),
            tool_id=tool_id,
            effect_id=effect_id,
            provider_wire_name=str(tool_id),
            provider_arguments=dict(arguments),
        )

    def _receipt(
        self,
        db: Session,
        *,
        claims: AgentToolGrantClaims,
        digest: str,
        journal_key: str,
        receipt: ToolStepResult,
    ) -> None:
        # Receipt landing is still live bearer authority. A completed inner
        # tool position can be projected later by the explicit Chat repair
        # path, but this request may not write after generation or job-fence
        # ownership has ended.
        generation = lock_active_generation_for_authority_in_current_transaction(
            db,
            owner=LlmCallOwner(kind="chat_run", id=self.run_id),
            generation_id=self.generation_id,
        )
        if generation is None:
            raise _PolicyViolation(self.generation_id)
        run = lock_chat_run_for_update(db, self.run_id)
        if (
            run is None
            or run.status != "running"
            or claims.sub != str(run.owner_user_id)
            or claims.run_id != str(run.id)
            or claims.job_id != str(self.job_id)
            or claims.worker_id != self.worker_id
            or claims.attempt_no != self.attempt_no
            or claims.generation_id != str(self.generation_id)
            or claims.jti != self.grant_jti
            or not _grant_matches_generation(claims, generation)
        ):
            raise _PolicyViolation(self.generation_id)
        job_row = (
            db.execute(
                text(
                    """
                    SELECT kind, payload, status, claimed_by, attempts
                    FROM background_jobs
                    WHERE id = :job_id
                      AND status = 'running'
                      AND claimed_by = :worker_id
                      AND attempts = :attempt_no
                      AND lease_expires_at > clock_timestamp()
                    FOR UPDATE
                    """
                ),
                {
                    "job_id": self.job_id,
                    "worker_id": self.worker_id,
                    "attempt_no": self.attempt_no,
                },
            )
            .mappings()
            .one_or_none()
        )
        if (
            job_row is None
            or job_row["kind"] != "chat_run"
            or job_row["attempts"] != self.attempt_no
            or job_row["status"] != "running"
            or job_row["claimed_by"] != self.worker_id
        ):
            raise _PolicyViolation(self.generation_id)
        payload = job_row["payload"]
        if not isinstance(payload, dict) or payload.get("run_id") != str(self.run_id):
            raise RuntimeError("MCP receipt job payload changed owner identity")
        journal = payload.get("_agent_tool_calls", {})
        if not isinstance(journal, dict):
            raise RuntimeError("agent-tool journal has an invalid shape")
        entry = journal.get(journal_key)
        if (
            not isinstance(entry, dict)
            or not journal_key.startswith(f"{claims.jti}:")
            or entry.get("digest") != digest
            or entry.get("canonical_tool_id") != receipt.canonical_tool_id
            or entry.get("provider_call_id") != receipt.model_output.call_id
            or entry.get("tool_index") != receipt.tool_call_index
            or entry.get("citation_ordinal", 0) > receipt.next_citation_ordinal
        ):
            raise RuntimeError("MCP receipt does not match its admitted journal identity")
        receipt_json = receipt.model_dump(mode="json")
        previous = entry.get("result")
        if previous is not None and previous != receipt_json:
            raise RuntimeError("MCP replay produced a different durable receipt")
        entry["result"] = receipt_json
        entry["next_citation_ordinal"] = receipt.next_citation_ordinal
        payload["_agent_tool_calls"] = journal
        if not update_running_job_payload(
            db,
            job_id=self.job_id,
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
            payload=payload,
        ):
            raise _PolicyViolation(self.generation_id)

    async def reject_unknown(
        self,
        *,
        provider_wire_name: str,
        arguments: dict[str, Any],
        request_id: JsonRpcId,
        claims: AgentToolGrantClaims,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> Any:
        from nexus.schemas.conversation import ChatRunToolResultEventPayload
        from nexus.services.chat_run_event_store import ChatRunEventEmitter
        from nexus.services.chat_run_steps import RejectedToolStepResult
        from nexus.services.chat_run_tools import (
            RecordKind,
            ToolModelOutput,
            bind_provider_tool_call_events,
            persist_rejected_provider_tool_call,
        )

        digest = raw_input_digest(ParsedJson(arguments))
        started = False
        try:
            self._call_started()
            started = True
            async with self._lock:
                with self.session_factory() as db:
                    with db.begin():
                        (
                            run,
                            _,
                            _,
                            journal,
                            journal_key,
                            tool_index,
                            citation_ordinal,
                            provider_call_id,
                        ) = self._admit(
                            db,
                            claims,
                            arguments,
                            digest,
                            request_id,
                            None,
                            provider_wire_name,
                        )
                        previous = journal[journal_key].get("result")
                        if previous is not None:
                            return RejectedToolStepResult.model_validate(previous)
                        tool_call_id = persist_rejected_provider_tool_call(
                            db,
                            run=run,
                            tool_call_index=tool_index,
                            provider_wire_name=provider_wire_name,
                        )
                        bind_provider_tool_call_events(
                            db,
                            run=run,
                            tool_call_index=tool_index,
                            tool_call_id=tool_call_id,
                        )
                        event = ChatRunToolResultEventPayload(
                            record_kind=RecordKind.rejected_provider_call.value,
                            canonical_tool_id=None,
                            provider_wire_name=provider_wire_name,
                            effect=None,
                            result_kind="rejected_provider_call",
                            activity_label="Skipped an unavailable tool",
                            error_type=None,
                            canonical_input_sha256=None,
                            tool_contract_revision=None,
                            binding_policy_revision=None,
                            tool_call_id=tool_call_id,
                            assistant_message_id=run.assistant_message_id,
                            tool_call_index=tool_index,
                            status="error",
                            scope="provider_tool",
                            types=[],
                            filters={},
                            error_code="unknown_tool",
                        )
                        failure: ToolResult = {
                            "type": "Failure",
                            "error": {"type": "UnknownTool"},
                        }
                        receipt = RejectedToolStepResult(
                            tool_call_id=tool_call_id,
                            provider_wire_name=provider_wire_name,
                            tool_call_index=tool_index,
                            model_output=ToolModelOutput(
                                call_id=provider_call_id,
                                output=canonical_json_bytes(failure).decode("utf-8"),
                                is_error=True,
                            ),
                            next_citation_ordinal=citation_ordinal,
                            result_event=event,
                        )
                        ChatRunEventEmitter(db, run).tool_result(event)
                        journal[journal_key]["result"] = receipt.model_dump(mode="json")
                        journal[journal_key]["next_citation_ordinal"] = citation_ordinal
                        payload, _ = self._load_journal(db)
                        self._persist_journal(db, payload, journal)
                        return receipt
        except _CancellationRequested as exc:
            await self._notify_once(self.generation_id, on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(exc)) from exc
        except _PolicyViolation as exc:
            await self._notify_once(exc.generation_id, on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(exc)) from exc
        finally:
            if started:
                self._call_finished()

    async def _notify_once(
        self, generation_id: UUID, callback: Callable[[UUID], Awaitable[None]]
    ) -> None:
        with self._activity_lock:
            if generation_id in self._notified_policy_violations:
                return
            self._notified_policy_violations.add(generation_id)
        try:
            await callback(generation_id)
        except BaseException:
            with self._activity_lock:
                self._notified_policy_violations.discard(generation_id)
            raise


def _grant_matches_generation(
    claims: AgentToolGrantClaims,
    generation: GenerationRecord,
) -> bool:
    from nexus.services.generation_policy import POLICY_REVISION, TOOL_PLAN_REVISION

    return (
        generation.operation == "chat"
        and generation.plan_revision == POLICY_REVISION
        and generation.capability_kind == "ChatTools"
        and generation.tool_plan_fingerprint == current_tool_plan_fingerprint()
        and claims.tool_plan_revision == TOOL_PLAN_REVISION
        and claims.request_fingerprint == generation.request_fingerprint
    )


def create_agent_tools_mcp_app(
    *,
    authority: AgentToolAuthority,
    signing_key: SecretStr,
    on_policy_violation: Callable[[UUID], Awaitable[None]],
    mcp_origin: str,
) -> Any:
    """Build the pinned SDK's stateless Streamable HTTP ASGI application."""
    return _create_mcp_app_for_authority(
        authority=authority,
        signing_key=signing_key,
        on_policy_violation=on_policy_violation,
        clock=authority.database_now,
        mcp_origin=mcp_origin,
    )


def create_active_agent_tools_mcp_app(
    *,
    registry: ActiveAgentToolRegistry,
    signing_key: SecretStr,
    on_policy_violation: Callable[[UUID], Awaitable[None]],
    settings: Settings,
) -> Any:
    """Build the worker listener whose authority is selected per grant."""
    router = _AuthorityRouter(registry)
    app = _create_mcp_app_for_authority(
        authority=router,
        signing_key=signing_key,
        on_policy_violation=on_policy_violation,
        clock=registry.database_now,
        lifespan=_active_listener_lifespan(registry, settings),
        mcp_origin=settings.agent_tools_mcp_origin,
    )
    return app


def _active_listener_lifespan(
    registry: ActiveAgentToolRegistry,
    settings: Settings,
) -> Callable[[Any], AbstractAsyncContextManager[None]]:
    """Own Brave's async client on the same event loop as MCP execution."""

    @asynccontextmanager
    async def lifespan(_server: Any) -> AsyncIterator[None]:
        import httpx

        from nexus.services.tool_runtime.composition import (
            compose_configured_web_search_provider,
            compose_product_tool_runtime,
        )

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            trust_env=False,
        ) as client:
            provider = compose_configured_web_search_provider(client, settings=settings)
            operation = compose_product_tool_runtime(provider).operations["chat"]
            registry.bind_operation(operation)
            try:
                yield None
            finally:
                registry.unbind_operation(operation)

    return lifespan


def _create_mcp_app_for_authority(
    *,
    authority: Any,
    signing_key: SecretStr,
    on_policy_violation: Callable[[UUID], Awaitable[None]],
    clock: Callable[[], datetime],
    lifespan: Callable[[Any], AbstractAsyncContextManager[Any]] | None = None,
    mcp_origin: str,
) -> Any:
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

    tools = [_sdk_tool(authority, entry, on_policy_violation) for entry in CHAT_TOOL_DECLARATIONS]
    server = _AgentToolsMCPServer(
        authority=authority,
        on_policy_violation=on_policy_violation,
        tools=tools,
        lifespan=lifespan,
    )
    app = server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        max_request_body_size=MAX_MCP_REQUEST_BODY_BYTES,
        transport_security=_transport_security(mcp_origin),
    )

    async def authorize_request(claims: AgentToolGrantClaims) -> bool:
        return await authority.authorize_request(
            claims=claims,
            on_policy_violation=on_policy_violation,
        )

    app.add_middleware(
        _GrantGate,
        signing_key=signing_key,
        clock=clock,
        authorize_request=authorize_request,
        max_body_bytes=MAX_MCP_REQUEST_BODY_BYTES,
    )
    app.add_middleware(_McpRequestRateGate)
    return app


def _transport_security(mcp_origin: str) -> TransportSecuritySettings:
    from nexus.config import parse_agent_tools_mcp_origin

    allowed_host, allowed_origin = parse_agent_tools_mcp_origin(mcp_origin)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[allowed_host],
        allowed_origins=[allowed_origin],
    )


class _McpRequestRateGate(BaseHTTPMiddleware):
    """Bound every MCP request before authorization or body inspection.

    The interactive worker is one process-owned listener. A fixed global
    window is deliberately identity-blind across presented credentials. The
    gate is path-wide so missing or invalid credentials cannot evade the
    process bound; below saturation the inner grant gate still owns the
    indistinguishable bodyless 401.
    """

    def __init__(self, app: Any) -> None:
        super().__init__(app)
        self._window_started = time.monotonic()
        self._requests = 0
        self._lock = asyncio.Lock()

    async def dispatch(self, request: Request, call_next: Callable[[Request], Any]) -> Response:
        if request.url.path != MCP_PATH:
            return await call_next(request)
        now = time.monotonic()
        async with self._lock:
            if now - self._window_started >= MCP_RATE_WINDOW_SECONDS:
                self._window_started = now
                self._requests = 0
            if self._requests >= MCP_RATE_BURST:
                return Response(status_code=429)
            self._requests += 1
        return await call_next(request)


def _sdk_tool(
    authority: Any,
    entry: PresentedToolDeclaration,
    on_policy_violation: Callable[[UUID], Awaitable[None]],
) -> Tool:
    async def dispatch(ctx: Context, **kwargs: Any) -> CallToolResult:
        request = cast(Request, ctx.request_context.request)
        claims = cast(AgentToolGrantClaims, request.state.agent_tool_grant)
        request_id = JsonRpcId.from_raw(ctx.request_context.request_id)
        receipt = await authority.invoke(
            tool_id=str(entry.spec.id),
            arguments=kwargs,
            request_id=request_id,
            claims=claims,
            on_policy_violation=on_policy_violation,
        )
        return _wire_tool_result(receipt)

    fields = entry.spec.input_type.model_fields
    parameters = [
        inspect.Parameter(
            field.alias or name,
            inspect.Parameter.KEYWORD_ONLY,
            annotation=field.annotation,
            default=inspect.Parameter.empty if field.is_required() else field.default,
        )
        for name, field in fields.items()
    ]
    dispatch.__signature__ = inspect.Signature(parameters, return_annotation=CallToolResult)  # type: ignore[attr-defined]
    dispatch.__annotations__ = {
        "ctx": Context,
        **{field.alias or name: field.annotation for name, field in fields.items()},
        "return": CallToolResult,
    }
    tool = Tool.from_function(
        dispatch,
        name=str(entry.spec.id),
        description=entry.spec.summary,
        structured_output=False,
    )
    # MCP consumes the model-facing JSON Schema.  The portable kernel keeps a
    # separate semantic projection for identity and a presentation projection
    # with titles/descriptions; crossing the boundary must choose explicitly.
    tool.parameters = entry.spec.input_schema.presentation
    return tool


class _GrantGate(BaseHTTPMiddleware):
    def __init__(
        self,
        app: Any,
        *,
        signing_key: SecretStr,
        clock: Callable[[], datetime],
        authorize_request: AgentToolRequestAuthorizer,
        max_body_bytes: int,
    ) -> None:
        super().__init__(app)
        self._signing_key = signing_key
        self._clock = clock
        self._authorize_request = authorize_request
        self._max_body_bytes = max_body_bytes

    async def dispatch(self, request: Request, call_next: Callable[[Request], Any]) -> Response:
        if request.url.path != MCP_PATH:
            return await call_next(request)
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return Response(status_code=401)
        try:
            claims = verify_agent_tool_grant(
                authorization.removeprefix("Bearer "),
                signing_key=self._signing_key,
                now=self._clock(),
            )
        except ValueError:
            return Response(status_code=401)
        if not await self._authorize_request(claims):
            return Response(status_code=401)
        request.state.agent_tool_grant = claims
        if request.method != "POST":
            return Response(status_code=405, headers={"Allow": "POST"})
        if not _has_exact_single_wire_header(
            request,
            name=b"content-type",
            value=_MCP_JSON_CONTENT_TYPE,
        ) or not _has_exact_single_wire_header(
            request,
            name=b"accept",
            value=_MCP_STREAMABLE_HTTP_ACCEPT,
        ):
            return Response(status_code=400)
        if request.headers.get("content-length") is not None:
            try:
                declared_bytes = int(request.headers["content-length"])
                if declared_bytes < 0:
                    return Response(status_code=400)
                if declared_bytes > self._max_body_bytes:
                    return Response(status_code=413)
            except ValueError:
                return Response(status_code=400)
        body = await _read_bounded_body(request, max_bytes=self._max_body_bytes)
        if body is None:
            return Response(status_code=413)
        try:
            wire = json.loads(body)
        except (TypeError, ValueError):
            wire = None
        if not isinstance(wire, dict) or not isinstance(wire.get("method"), str):
            return Response(status_code=400)
        method = wire["method"]
        version_header = request.headers.get("MCP-Protocol-Version")
        if method == "initialize":
            params = wire.get("params")
            requested_version = params.get("protocolVersion") if isinstance(params, dict) else None
            if requested_version != MCP_PROTOCOL_VERSION or version_header not in {
                None,
                MCP_PROTOCOL_VERSION,
            }:
                return Response(status_code=400)
        elif version_header != MCP_PROTOCOL_VERSION:
            return Response(status_code=400)
        if request.headers.get("Mcp-Session-Id") is not None:
            # The pinned Codex client accepts a server without a transport
            # session. Refusing client-supplied session state keeps authority
            # entirely in the signed grant and durable Nexus journal.
            return Response(status_code=400)
        return await call_next(request)


def _has_exact_single_wire_header(
    request: Request,
    *,
    name: bytes,
    value: bytes,
) -> bool:
    """Match one exact wire value while treating HTTP field names case-insensitively."""

    values = tuple(
        raw_value for raw_name, raw_value in request.headers.raw if raw_name.lower() == name
    )
    return values == (value,)


async def _read_bounded_body(request: Request, *, max_bytes: int) -> bytes | None:
    """Buffer at most the authenticated MCP bound and replay it downstream."""

    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > max_bytes:
            return None
        payload.extend(chunk)
    body = bytes(payload)
    # BaseHTTPMiddleware supplies a cached Request. Setting its body after the
    # bounded stream makes the exact bytes replayable to the pinned MCP app.
    request._body = body  # type: ignore[attr-defined]  # Starlette's replay cache.
    return body


def _wire_tool_result(receipt: Any) -> CallToolResult:
    """Expose only the model-facing receipt; durable audit facts stay private."""

    output = receipt.model_output
    return CallToolResult(
        content=[TextContent(type="text", text=output.output)],
        is_error=output.is_error,
    )


def _stable_generation_id(run_id: UUID, position: str) -> UUID:
    from nexus.services.durable_step_journal import stable_generation_id

    return stable_generation_id(run_id, position)
