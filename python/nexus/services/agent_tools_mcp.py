"""Pinned Codex MCP adapter for a leased model-tool attempt.

The SDK owns JSON-RPC and Streamable HTTP. This module owns only the bearer
gate, the process-local index of live authorities, declaration projection, and
the handoff to the shared generation tool executor. The mount is publicly
reachable, so the bearer, its expiry, the transport-security settings, and the
per-source rate window are all load-bearing.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Final, Literal, cast
from uuid import UUID

from fastapi import Request
from llm_tools import Native, ToolId
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

from nexus.db.async_session import open_async_session
from nexus.services import generation_policy
from nexus.services.tool_authority import (
    GenerationToolExecutor,
    ModelToolExecutionResult,
    ToolAuthority,
    ToolAuthorityRefused,
)
from nexus.services.tool_runtime.catalog import (
    compose_tool_runtime,
    freeze_tool_plan_snapshot,
    operation_presented_declarations,
    project_provider_model_tools,
)
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

if TYPE_CHECKING:
    from nexus.config import Settings
    from nexus.jobs.queue import JobExecutionContext
    from nexus.services.codex_generation_contract import (
        GenerationAdmission,
        GenerationCommand,
    )
    from nexus.services.generation_intent import GenerationIntent
    from nexus.services.generation_spec import GenerationSpec
    from nexus.services.llm_ledger import LlmCallOwner
    from nexus.services.tool_authority import ToolExecutionProjection
    from nexus.services.tool_runtime.catalog import FrozenToolOperation
    from nexus.services.tool_runtime.declarations import PresentedToolDeclaration

MCP_PATH: Final[str] = "/internal/agent-tools/mcp"
MCP_PROTOCOL_VERSION: Final[str] = "2025-06-18"
MAX_MCP_REQUEST_BODY_BYTES: Final[int] = 512 * 1024
MCP_RATE_WINDOW_SECONDS: Final[float] = 60.0
MCP_SOURCE_RATE_BURST: Final[int] = 120
MCP_TOOL_DRAIN_TIMEOUT_SECONDS: Final[float] = 35.0
MAX_AGENT_TOOL_GRANT_TTL_SECONDS: Final[int] = (
    generation_policy.MODEL_TOOL_ADMISSION_RUNTIME_SECONDS
)
_MCP_SERVER_NAME: Final[str] = "nexus"
_MCP_JSON_CONTENT_TYPE: Final[bytes] = b"application/json"
_MCP_STREAMABLE_HTTP_ACCEPT: Final[bytes] = b"application/json, text/event-stream"
_MAX_MCP_SOURCE_WINDOWS: Final[int] = 4_096
_MAX_JSON_RPC_INTEGER: Final[int] = 2**63 - 1
_MAX_JSON_RPC_STRING: Final[int] = 256


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

    def key(self) -> str:
        return f"{self.kind}:{self.value}"


@dataclass(slots=True)
class ActiveAgentToolRegistry:
    """Process-local index of leased authorities owned by the interactive worker.

    The registry contains no ORM objects or sessions. DB lease and generation
    checks remain authoritative on every routed call; this index only selects
    the live authority a presented bearer belongs to.
    """

    session_factory: sessionmaker[Session]
    _authorities: list[AgentToolAuthority] = field(default_factory=list)
    _registry_lock: Any = field(default_factory=threading.RLock, repr=False)
    _operations_by_revision: dict[str, FrozenToolOperation] = field(default_factory=dict)

    def bind_operations(self, operations: tuple[FrozenToolOperation, ...]) -> None:
        """Install every listener-loop-owned native operation before serving."""

        with self._registry_lock:
            if self._operations_by_revision or self._authorities:
                raise RuntimeError("agent-tool listener operations are already bound")
            indexed = {operation.plan.plan_revision: operation for operation in operations}
            if len(indexed) != len(operations):
                raise ValueError("agent-tool listener plan revisions must be unique")
            if not indexed:
                raise ValueError("agent-tool listener requires at least one native operation")
            if any(not isinstance(operation.plan.exposure, Native) for operation in operations):
                raise ValueError("agent-tool listener accepts only native model-tool plans")
            self._operations_by_revision.update(indexed)

    def unbind_operations(self, operations: tuple[FrozenToolOperation, ...]) -> None:
        """Remove listener operations only after every authority has closed."""

        with self._registry_lock:
            if self._authorities:
                raise RuntimeError("agent-tool listener stopped with active authorities")
            expected = {operation.plan.plan_revision: operation for operation in operations}
            if self._operations_by_revision != expected:
                raise RuntimeError("agent-tool listener operation identities changed")
            self._operations_by_revision.clear()

    def operation_for(self, admitted: FrozenToolPlanSnapshot) -> FrozenToolOperation:
        """Return the listener-owned handlers under the admitted frozen plan."""

        with self._registry_lock:
            operation = self._operations_by_revision.get(admitted.plan_revision)
        if operation is None:
            raise RuntimeError("agent-tool listener has no operation for the admitted plan")
        if freeze_tool_plan_snapshot(operation) != admitted:
            raise RuntimeError("agent-tool listener operation differs from frozen admission")
        return operation

    def register(self, authority: AgentToolAuthority) -> None:
        with self._registry_lock:
            self._authorities.append(authority)

    def unregister(self, authority: AgentToolAuthority) -> None:
        with self._registry_lock:
            self._authorities = [item for item in self._authorities if item is not authority]

    def resolve(self, bearer: str) -> AgentToolAuthority | None:
        # Bytes, not str: compare_digest rejects non-ASCII text a caller controls.
        presented = bearer.encode("utf-8")
        with self._registry_lock:
            live = tuple(self._authorities)
        for authority in live:
            if secrets.compare_digest(authority.bearer.encode("utf-8"), presented):
                return authority
        return None

    async def database_now(self) -> datetime:
        async with open_async_session(self.session_factory) as db:
            value = await db.scalar(text("SELECT clock_timestamp()"))
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


@dataclass(slots=True)
class AgentToolAuthority:
    """Codex MCP mount over the shared route-neutral generation executor."""

    registry: ActiveAgentToolRegistry
    executor: GenerationToolExecutor
    bearer: str
    expires_at: datetime
    _notified_policy_violation: bool = False
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _activity_lock: Any = field(default_factory=threading.Lock, repr=False)
    _idle: Any = field(default_factory=threading.Event, repr=False)
    _active_calls: int = 0
    _accepting_calls: bool = True

    def __post_init__(self) -> None:
        listener_operation = self.registry.operation_for(
            freeze_tool_plan_snapshot(self.executor.authority.operation)
        )
        if listener_operation is not self.executor.authority.operation:
            self.executor = GenerationToolExecutor(
                authority=replace(self.executor.authority, operation=listener_operation)
            )
        self._idle.set()

    @property
    def generation_id(self) -> UUID:
        return self.executor.authority.generation_id

    @property
    def operation(self) -> FrozenToolOperation:
        return self.executor.authority.operation

    def close(self) -> None:
        self.registry.unregister(self)

    async def wait_until_idle(self) -> None:
        """Close admission and drain accepted work before folding a host terminal."""

        with self._activity_lock:
            self._accepting_calls = False
        idle = await asyncio.to_thread(self._idle.wait, MCP_TOOL_DRAIN_TIMEOUT_SECONDS)
        if not idle:
            raise RuntimeError("active MCP tool call did not drain before its bounded deadline")

    def canonical_tool_id(self, wire_name: str) -> str | None:
        """Reverse the admitted plan's library-owned wire alias."""

        publication = project_provider_model_tools(self.operation)
        if publication is None:
            return None
        canonical_ids = tuple(str(grant.id) for grant in self.operation.profile.ordered_grants)
        aliases = tuple(tool.name for tool in publication.tools)
        return dict(zip(aliases, canonical_ids, strict=True)).get(wire_name)

    async def authorize_request(
        self,
        *,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> bool:
        """Revalidate live durable authority behind the authenticated bearer."""

        try:
            await self._reauthorize()
        except ToolAuthorityRefused:
            await self._notify_once(on_policy_violation)
            return False
        return True

    async def invoke(
        self,
        *,
        tool_id: str,
        provider_wire_name: str,
        arguments: dict[str, Any],
        request_id: JsonRpcId,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> ModelToolExecutionResult:
        started = False
        try:
            self._call_started()
            started = True
            async with self._lock:
                await self._reauthorize()
                return await self.executor.execute_canonical(
                    transport_kind="CodexMcp",
                    model_turn_seq=1,
                    transport_call_id=f"mcp:{request_id.key()}",
                    provider_wire_name=provider_wire_name,
                    tool_id=ToolId(tool_id),
                    arguments=arguments,
                )
        except ToolAuthorityRefused as error:
            await self._notify_once(on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(error)) from error
        finally:
            if started:
                self._call_finished()

    async def reject_unknown(
        self,
        *,
        request_id: JsonRpcId,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
    ) -> ModelToolExecutionResult:
        started = False
        try:
            self._call_started()
            started = True
            async with self._lock:
                await self._reauthorize()
                return self.executor.refuse_unknown_call(
                    transport_call_id=f"mcp:{request_id.key()}"
                )
        except ToolAuthorityRefused as error:
            await self._notify_once(on_policy_violation)
            raise MCPError(code=INVALID_REQUEST, message=str(error)) from error
        finally:
            if started:
                self._call_finished()

    async def _reauthorize(self) -> None:
        authority = self.executor.authority

        def authorize(db: Session) -> None:
            with db.begin():
                authority.lock_in_current_transaction(db)

        async with open_async_session(authority.session_factory) as database:
            await database.run_sync(authorize)

    def _call_started(self) -> None:
        with self._activity_lock:
            if not self._accepting_calls:
                raise ToolAuthorityRefused("generation tool authority is draining")
            self._active_calls += 1
            self._idle.clear()

    def _call_finished(self) -> None:
        with self._activity_lock:
            self._active_calls -= 1
            if self._active_calls < 0:
                raise AssertionError("MCP active-call count became negative")
            if self._active_calls == 0:
                self._idle.set()

    async def _notify_once(self, callback: Callable[[UUID], Awaitable[None]]) -> None:
        with self._activity_lock:
            if self._notified_policy_violation:
                return
            self._notified_policy_violation = True
        try:
            await callback(self.generation_id)
        except BaseException:
            with self._activity_lock:
                self._notified_policy_violation = False
            raise


@dataclass(slots=True)
class CodexGenerationToolBinding:
    """Post-admission owner for one Codex bearer and MCP authority mount.

    Construction is grant-free and safe before host admission. ``bind_admission``
    is the sole transition that reads the live database lease, mints a bounded
    bearer, and makes the authority routable by the process-local MCP listener.
    """

    session_factory: sessionmaker[Session] = field(repr=False)
    user_id: UUID
    owner: LlmCallOwner
    generation_id: UUID
    job_context: JobExecutionContext
    operation: FrozenToolOperation = field(repr=False)
    spec: GenerationSpec = field(repr=False)
    intent: GenerationIntent = field(repr=False)
    projection: ToolExecutionProjection | None = field(default=None, repr=False)
    _bind_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _admission: GenerationAdmission | None = field(default=None, init=False, repr=False)
    _command: GenerationCommand | None = field(default=None, init=False, repr=False)
    _authority: AgentToolAuthority | None = field(default=None, init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

    async def bind_admission(self, admission: GenerationAdmission) -> GenerationCommand:
        """Bind the exact accepted host slot once; exact repeats replay in memory."""

        from nexus.jobs.queue import get_job, lock_running_job_claim
        from nexus.services.codex_generation_contract import (
            GenerationCommandDraft,
            generation_command_from_draft,
        )
        from nexus.services.generation_intent import BearerToolGrant

        async with self._bind_lock:
            if self._closed:
                raise RuntimeError("Codex generation tool binding is closed")
            if self._admission is not None:
                if admission != self._admission or self._command is None:
                    raise RuntimeError("Codex generation tool binding received a second admission")
                return self._command
            if admission.request_id != self.generation_id:
                raise ValueError("Codex admission names a different generation")
            if admission.runtime_deadline_seconds != self.spec.bounds.turn_timeout_seconds:
                raise ValueError("Codex admission runtime deadline differs from frozen bounds")

            executor = GenerationToolExecutor(
                authority=await ToolAuthority.from_claimed_generation_attempt(
                    session_factory=self.session_factory,
                    user_id=self.user_id,
                    owner=self.owner,
                    generation_id=self.generation_id,
                    job_context=self.job_context,
                    operation=self.operation,
                    projection=self.projection,
                )
            )
            if executor.authority.spec != self.spec:
                raise ToolAuthorityRefused(
                    "Codex tool binding spec differs from the durable generation"
                )

            def read_lease(db: Session) -> tuple[datetime, datetime]:
                with db.begin():
                    if not lock_running_job_claim(db, context=self.job_context):
                        raise ToolAuthorityRefused(
                            "generation tool grant lost its claimed worker lease"
                        )
                    job = get_job(db, self.job_context.job_id)
                    database_now = db.execute(text("SELECT clock_timestamp()")).scalar_one()
                    if job is None or job.lease_expires_at is None:
                        raise ToolAuthorityRefused("generation tool grant has no live lease")
                    if not isinstance(database_now, datetime):
                        raise AssertionError("database clock did not return a timestamp")
                    return database_now, job.lease_expires_at

            async with open_async_session(self.session_factory) as database:
                database_now, lease_expires_at = await database.run_sync(read_lease)

            # Authority dies at the earliest of the lease, the host's runtime
            # deadline, and the fixed grant ceiling.
            now = _aware_utc(database_now)
            admitted_at = datetime.fromisoformat(admission.admitted_at.removesuffix("Z") + "+00:00")
            expires_at = min(
                _aware_utc(lease_expires_at),
                admitted_at + timedelta(seconds=admission.runtime_deadline_seconds),
                now + timedelta(seconds=MAX_AGENT_TOOL_GRANT_TTL_SECONDS),
            )
            if expires_at <= now:
                raise ValueError("generation tool authority has no remaining validity interval")
            registry = active_agent_tool_registry()
            if registry is None:
                raise RuntimeError("active agent-tool registry is not installed")
            bearer = secrets.token_urlsafe(32)
            authority = AgentToolAuthority(
                registry=registry,
                executor=executor,
                bearer=bearer,
                expires_at=expires_at,
            )
            registry.register(authority)
            try:
                command = generation_command_from_draft(
                    GenerationCommandDraft(
                        request_id=self.generation_id,
                        spec=self.spec,
                        intent=self.intent,
                    ),
                    tool_grant=BearerToolGrant(token=SecretStr(bearer)),
                )
            except BaseException:
                authority.close()
                raise
            self._admission = admission
            self._command = command
            self._authority = authority
            return command

    async def wait_until_idle(self) -> None:
        """Fence terminal folding behind every MCP request already accepted."""

        authority = self._authority
        if authority is None:
            raise RuntimeError("accepted Codex generation has no bound tool authority")
        await authority.wait_until_idle()

    async def drain_and_close(self) -> None:
        """Idempotently revoke new calls, drain accepted calls, and unmount."""

        async with self._bind_lock:
            if self._closed:
                return
            self._closed = True
            authority = self._authority
        if authority is None:
            return
        try:
            await authority.wait_until_idle()
        finally:
            authority.close()


def _aware_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def create_agent_tools_mcp_app(
    *,
    registry: ActiveAgentToolRegistry,
    on_policy_violation: Callable[[UUID], Awaitable[None]],
    settings: Settings,
) -> Any:
    """Build the worker listener whose authority is selected per bearer."""

    server = _AgentToolsMCPServer(
        on_policy_violation=on_policy_violation,
        tools=[_sdk_tool(wire_name, entry) for wire_name, entry in _model_tool_wire_declarations()],
        lifespan=_active_listener_lifespan(registry, settings),
    )
    app = server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        max_request_body_size=MAX_MCP_REQUEST_BODY_BYTES,
        transport_security=_transport_security(settings.agent_tools_mcp_origin),
    )
    app.add_middleware(
        _GrantGate,
        registry=registry,
        on_policy_violation=on_policy_violation,
        max_body_bytes=MAX_MCP_REQUEST_BODY_BYTES,
    )
    app.add_middleware(_McpSourceRateGate)
    return app


def _active_listener_lifespan(
    registry: ActiveAgentToolRegistry,
    settings: Settings,
) -> Callable[[Any], AbstractAsyncContextManager[None]]:
    """Own Brave's async client on the same event loop as MCP execution."""

    @asynccontextmanager
    async def lifespan(_server: Any) -> AsyncIterator[None]:
        import httpx

        from nexus.services.tool_runtime.catalog import compose_configured_web_search_provider

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            trust_env=False,
        ) as client:
            runtime = compose_tool_runtime(
                compose_configured_web_search_provider(client, settings=settings)
            )
            operations = tuple(
                operation
                for operation in runtime.operations.values()
                if isinstance(operation.plan.exposure, Native)
            )
            registry.bind_operations(operations)
            try:
                yield None
            finally:
                registry.unbind_operations(operations)

    return lifespan


def _transport_security(mcp_origin: str) -> TransportSecuritySettings:
    from nexus.config import parse_agent_tools_mcp_origin

    allowed_host, allowed_origin = parse_agent_tools_mcp_origin(mcp_origin)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[allowed_host],
        allowed_origins=[allowed_origin],
    )


class _AgentToolsMCPServer(MCPServer[Any]):
    """MCP handler with durable unknown-tool rejection below the SDK gate."""

    def __init__(
        self,
        *,
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
        authority = cast(AgentToolAuthority, request.state.agent_tool_authority)
        request_id = JsonRpcId.from_raw(context.request_context.request_id)
        canonical_tool_id = authority.canonical_tool_id(name)
        if canonical_tool_id is not None:
            return _wire_tool_result(
                await authority.invoke(
                    tool_id=canonical_tool_id,
                    provider_wire_name=name,
                    arguments=arguments,
                    request_id=request_id,
                    on_policy_violation=self._on_policy_violation,
                )
            )
        if not 1 <= len(name) <= 128:
            raise MCPError(
                code=INVALID_REQUEST,
                message="MCP tool name must contain 1-128 characters",
            )
        return _wire_tool_result(
            await authority.reject_unknown(
                request_id=request_id,
                on_policy_violation=self._on_policy_violation,
            )
        )


async def _unreachable(ctx: Context) -> CallToolResult:
    """Placeholder handler: ``_AgentToolsMCPServer.call_tool`` fully overrides dispatch."""

    del ctx
    raise AssertionError("MCP tool dispatch bypasses the SDK handler")


def _sdk_tool(wire_name: str, entry: PresentedToolDeclaration) -> Tool:
    tool = Tool.from_function(
        _unreachable,
        name=wire_name,
        description=entry.spec.summary,
        structured_output=False,
    )
    # MCP consumes the model-facing JSON Schema. The portable kernel keeps a
    # separate semantic projection for identity and a presentation projection
    # with titles/descriptions; crossing the boundary must choose explicitly.
    tool.parameters = entry.spec.input_schema.presentation
    return tool


def _model_tool_wire_declarations() -> tuple[tuple[str, PresentedToolDeclaration], ...]:
    """Project the union server table only from exact operation-owned plans."""

    runtime = compose_tool_runtime(None)
    declarations_by_alias: dict[str, PresentedToolDeclaration] = {}
    for operation in runtime.operations.values():
        if not isinstance(operation.plan.exposure, Native):
            continue
        publication = project_provider_model_tools(operation)
        if publication is None:
            raise AssertionError("native model-tool plan lowered to no publication")
        presented = operation_presented_declarations(operation)
        for tool, entry in zip(publication.tools, presented, strict=True):
            existing = declarations_by_alias.setdefault(tool.name, entry)
            if existing.spec is not entry.spec:
                raise ValueError(f"model-tool wire alias collision: {tool.name}")
    return tuple(declarations_by_alias.items())


@dataclass(slots=True)
class _RateWindow:
    started: float
    requests: int = 0


class _McpSourceRateGate(BaseHTTPMiddleware):
    """Apply a bounded source window before bearer parsing or body inspection."""

    def __init__(self, app: Any) -> None:
        super().__init__(app)
        self._windows: OrderedDict[str, _RateWindow] = OrderedDict()
        self._lock = asyncio.Lock()

    async def dispatch(self, request: Request, call_next: Callable[[Request], Any]) -> Response:
        if request.url.path != MCP_PATH:
            return await call_next(request)
        source = _trusted_mcp_source(request)
        if source is None:
            return Response(status_code=400)
        now = time.monotonic()
        async with self._lock:
            window = self._windows.get(source)
            if window is None or now - window.started >= MCP_RATE_WINDOW_SECONDS:
                window = _RateWindow(started=now)
                self._windows[source] = window
            self._windows.move_to_end(source)
            if window.requests >= MCP_SOURCE_RATE_BURST:
                return Response(status_code=429)
            window.requests += 1
            while len(self._windows) > _MAX_MCP_SOURCE_WINDOWS:
                self._windows.popitem(last=False)
        return await call_next(request)


def _trusted_mcp_source(request: Request) -> str | None:
    """Resolve Caddy's single-hop source without trusting a public-supplied chain."""

    client = request.client
    if client is None:
        return None
    try:
        peer = ipaddress.ip_address(client.host)
    except ValueError:
        return None
    forwarded_values = request.headers.getlist("x-forwarded-for")
    if peer.is_private and not peer.is_loopback:
        if len(forwarded_values) != 1 or "," in forwarded_values[0]:
            return None
        try:
            return ipaddress.ip_address(forwarded_values[0].strip()).compressed
        except ValueError:
            return None
    # Direct public and loopback callers cannot select another rate identity.
    return peer.compressed


class _GrantGate(BaseHTTPMiddleware):
    def __init__(
        self,
        app: Any,
        *,
        registry: ActiveAgentToolRegistry,
        on_policy_violation: Callable[[UUID], Awaitable[None]],
        max_body_bytes: int,
    ) -> None:
        super().__init__(app)
        self._registry = registry
        self._on_policy_violation = on_policy_violation
        self._max_body_bytes = max_body_bytes

    async def dispatch(self, request: Request, call_next: Callable[[Request], Any]) -> Response:
        if request.url.path != MCP_PATH:
            return await call_next(request)
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return Response(status_code=401)
        authority = self._registry.resolve(authorization.removeprefix("Bearer "))
        if authority is None or authority.expires_at <= await self._registry.database_now():
            return Response(status_code=401)
        if not await authority.authorize_request(on_policy_violation=self._on_policy_violation):
            return Response(status_code=401)
        request.state.agent_tool_authority = authority
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
            except ValueError:
                return Response(status_code=400)
            if declared_bytes < 0:
                return Response(status_code=400)
            if declared_bytes > self._max_body_bytes:
                return Response(status_code=413)
        body = await _read_bounded_body(request, max_bytes=self._max_body_bytes)
        if body is None:
            return Response(status_code=413)
        try:
            wire = json.loads(body)
        except (TypeError, ValueError):
            wire = None
        if not isinstance(wire, dict) or not isinstance(wire.get("method"), str):
            return Response(status_code=400)
        version_header = request.headers.get("MCP-Protocol-Version")
        if wire["method"] == "initialize":
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
            # entirely in the bearer and the durable Nexus journal.
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
    cast(Any, request)._body = body
    return body


def _wire_tool_result(receipt: ModelToolExecutionResult) -> CallToolResult:
    """Expose only the model-facing receipt; durable audit facts stay private."""

    return CallToolResult(
        content=[TextContent(type="text", text=receipt.model_output.output)],
        is_error=receipt.model_output.is_error,
    )


__all__ = [
    "MCP_PATH",
    "ActiveAgentToolRegistry",
    "AgentToolAuthority",
    "CodexGenerationToolBinding",
    "active_agent_tool_registry",
    "create_agent_tools_mcp_app",
    "set_active_agent_tool_registry",
]
