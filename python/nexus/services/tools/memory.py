"""Owner-only shared memory: the private client config, the MCP call and the tool bindings.

Production runs without a config (``Absent``): every memory tool is unavailable and no
plan grants one. Generation core grants a memory plan only to the config's owner, in a
chat, on a processor chain the config allows; the handler re-checks the owner.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Self
from uuid import UUID

import anyio
import httpx2
from llm_tools import (
    Available,
    DeclaredToolFailure,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolFamily,
    ToolSpec,
    Unavailable,
)
from mcp import ClientSession
from mcp.client.streamable_http import StreamableHTTPError, streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.types import (
    CONNECTION_CLOSED,
    INTERNAL_ERROR,
    REQUEST_TIMEOUT,
    CallToolResult,
    Implementation,
    JSONRPCError,
    JSONRPCRequest,
    JSONRPCResponse,
    TextContent,
    jsonrpc_message_adapter,
)
from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    SecretStr,
    TypeAdapter,
    ValidationError,
    model_validator,
)
from universal_memory import MemoryError
from universal_memory.policy import RESULT_BYTES, canonical_json
from universal_memory.tools import (
    MEMORY_READ_SPECS,
    MEMORY_SAVE_NOTE_SPEC,
    MemoryToolFailure,
)

from nexus.schemas.presence import Absent, Presence

if TYPE_CHECKING:
    from nexus.services.tools.run import Call


class MemoryClientConfig(BaseModel):
    """The private deployment file: one owner, one endpoint, one bearer, its processors."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, hide_input_in_errors=True)

    client: Literal["nexus-owner"]
    owner_user_id: UUID
    mcp_url: AnyHttpUrl
    bearer: SecretStr = Field(repr=False)
    connect: bool
    admit: bool
    processors: tuple[str, ...] = Field(max_length=16)

    @model_validator(mode="after")
    def valid_client(self) -> Self:
        url = self.mcp_url
        if (
            url.path != "/v1/mcp"
            or url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
            or (url.scheme == "http" and url.host not in ("localhost", "127.0.0.1", "[::1]"))
            or len(str(url).encode()) > 4096
        ):
            raise ValueError("memory endpoint must be private HTTPS or local HTTP /v1/mcp")
        if re.fullmatch(r"jmem_[0-9a-f]{64}", self.bearer.get_secret_value()) is None:
            raise ValueError("invalid memory bearer")
        if (
            len(self.processors) != len(set(self.processors))
            or any(
                not value.strip() or value != value.strip() or len(value.encode()) > 256
                for value in self.processors
            )
            or (self.connect and "Nexus" not in self.processors)
        ):
            raise ValueError("invalid memory processor declaration")
        return self

    def allows(self, owner_user_id: UUID, processors: tuple[str, ...]) -> bool:
        return (
            self.connect
            and owner_user_id == self.owner_user_id
            and set(processors) <= set(self.processors)
        )


def load_memory_client_config(path: Path | None) -> Presence[MemoryClientConfig]:
    if path is None:
        return Absent()
    try:
        return TypeAdapter(Presence[MemoryClientConfig]).validate_json(
            path.read_bytes(), strict=True
        )
    except (OSError, ValueError):
        # an explicitly configured private declaration must be valid.
        raise RuntimeError("invalid private memory client configuration") from None


def _http_failure(status: int) -> MemoryToolFailure:
    if status == 401:
        return MemoryToolFailure(code="unauthorized")
    if status == 403:
        return MemoryToolFailure(code="forbidden")
    if status == 429:
        return MemoryToolFailure(code="rate_limited")
    return MemoryToolFailure(code="unavailable" if 500 <= status < 600 else "unsupported")


def _boundary_failure(error: BaseException) -> MemoryToolFailure | None:
    """Classify known remote failures; a group containing a defect/cancel stays intact."""

    if isinstance(error, BaseExceptionGroup):
        failures = tuple(_boundary_failure(child) for child in error.exceptions)
        first = failures[0]
        if first is None or any(failure is None for failure in failures):
            return None
        if any(failure is not None and failure.code != first.code for failure in failures):
            return MemoryToolFailure(code="unavailable")
        return first
    if isinstance(error, MemoryError):
        return MemoryToolFailure.model_validate({"code": error.code})
    if isinstance(error, httpx2.HTTPStatusError):
        return _http_failure(error.response.status_code)
    if isinstance(error, MCPError):
        return MemoryToolFailure(
            code="unavailable"
            if error.code in (CONNECTION_CLOSED, REQUEST_TIMEOUT, INTERNAL_ERROR)
            else "unsupported"
        )
    if isinstance(
        error,
        (
            httpx2.NetworkError,
            httpx2.TimeoutException,
            httpx2.RemoteProtocolError,
            StreamableHTTPError,
            anyio.EndOfStream,
            anyio.BrokenResourceError,
            anyio.ClosedResourceError,
        ),
    ):
        return MemoryToolFailure(code="unavailable")
    if isinstance(error, (ValidationError, httpx2.DecodingError, httpx2.SSEError)):
        return MemoryToolFailure(code="unsupported")
    return None


async def _call_memory(
    config: MemoryClientConfig, spec: ToolSpec[Any, Any, Any], arguments: dict[str, JsonValue]
) -> Any:
    """One protocol session per call; a call is never resent."""

    async def check_response(response: httpx2.Response) -> None:
        if response.request.method != "POST":
            return
        # The SDK discards these statuses and can log private malformed bodies.
        if response.status_code >= 400:
            raise MemoryError(_http_failure(response.status_code).code)
        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            if response.status_code not in (307, 308) or location is None:
                raise MemoryError("unsupported")
            url = response.request.url
            try:
                target = url.join(location)
            except httpx2.InvalidURL:
                raise MemoryError("unsupported") from None
            same_origin = (url.scheme, url.host, url.port) == (
                target.scheme,
                target.host,
                target.port,
            )
            https_upgrade = (
                url.host == target.host
                and url.scheme == "http"
                and url.port is None
                and target.scheme == "https"
                and target.port is None
            )
            if target.userinfo or not (same_origin or https_upgrade):
                raise MemoryError("unsupported")
            return  # let the SDK follow its supported method-preserving redirect
        if response.status_code == 202:
            return  # the SDK distinguishes notification acknowledgement from a lost reply
        sent = jsonrpc_message_adapter.validate_json(response.request.content, by_name=False)
        if not isinstance(sent, JSONRPCRequest):
            return  # notification replies carry no result, including 200/204
        if (
            response.status_code != 200
            or "mcp-session-id" in response.headers
            or response.headers.get("content-type", "").partition(";")[0].strip().lower()
            != "application/json"
        ):
            raise MemoryError("unsupported")  # this server is stateless JSON, never SSE
        try:
            received = jsonrpc_message_adapter.validate_json(await response.aread(), by_name=False)
        except ValidationError:
            raise MemoryError("unsupported") from None
        if not isinstance(received, (JSONRPCResponse, JSONRPCError)) or received.id != sent.id:
            raise MemoryError("unsupported")

    submitted = False
    try:
        async with httpx2.AsyncClient(
            headers={"authorization": "Bearer " + config.bearer.get_secret_value()},
            timeout=httpx2.Timeout(20.0, connect=10.0),
            follow_redirects=False,
            trust_env=False,
            event_hooks={"response": [check_response]},
        ) as http:
            async with streamable_http_client(str(config.mcp_url), http_client=http) as (
                read,
                write,
            ):
                async with ClientSession(
                    read,
                    write,
                    client_info=Implementation(name="nexus-owner", version="1"),
                    read_timeout_seconds=20.0,
                ) as client:
                    try:
                        await client.initialize()
                    except RuntimeError as error:
                        # This one pinned-SDK handshake failure has no concrete type.
                        if not str(error).startswith(
                            "Unsupported protocol version from the server:"
                        ):
                            raise
                        raise MemoryError("unsupported") from None
                    name = str(spec.id).replace(".", "_")
                    tools = await client.list_tools()
                    if not any(
                        tool.name == name and tool.output_schema is None for tool in tools.tools
                    ):
                        raise MemoryError("unsupported")
                    submitted = True
                    result = await client.call_tool(
                        name, arguments, allow_input_required=True, allow_claimed=True
                    )
        if (
            not isinstance(result, CallToolResult)
            or result.structured_content is not None
            or len(result.content) != 1
            or not isinstance(result.content[0], TextContent)
        ):
            raise MemoryError("unsupported")
        try:
            size = len(
                canonical_json(
                    result.model_dump(mode="json", exclude_none=True, by_alias=True)
                ).encode()
            )
        except UnicodeEncodeError:
            raise MemoryError("unsupported") from None
        if size > RESULT_BYTES:
            raise MemoryError("unsupported")
        body = result.content[0].text
        if result.is_error:
            failure = MemoryToolFailure.model_validate_json(body, strict=True)
            raise MemoryError(failure.code)
        return TypeAdapter(spec.success_type).validate_json(body, strict=True)
    except (
        MemoryError,
        httpx2.HTTPStatusError,
        httpx2.NetworkError,
        httpx2.TimeoutException,
        httpx2.RemoteProtocolError,
        httpx2.DecodingError,
        httpx2.SSEError,
        MCPError,
        StreamableHTTPError,
        anyio.EndOfStream,
        anyio.BrokenResourceError,
        anyio.ClosedResourceError,
        ValidationError,
        BaseExceptionGroup,
    ) as error:
        failure = _boundary_failure(error)
        if failure is None:
            raise
        if submitted and spec is MEMORY_SAVE_NOTE_SPEC:
            failure = failure.model_copy(
                update={
                    "notice": failure.notice
                    + " no success receipt; this save may already have committed."
                }
            )
        raise DeclaredToolFailure(failure, actual_attempts=0) from None


def _handler(spec: ToolSpec[Any, Any, Any], config: MemoryClientConfig) -> Any:
    async def handler(value: BaseModel, call: Call) -> Any:
        chat = await call.database.run_sync(lambda _: call.fence())
        await call.database.commit()  # a live chat; its locks release before the call
        if chat is None or call.principal != config.owner_user_id:
            raise DeclaredToolFailure(MemoryToolFailure(code="forbidden"), actual_attempts=0)
        arguments: dict[str, JsonValue] = value.model_dump(mode="json")
        if spec is MEMORY_SAVE_NOTE_SPEC:
            arguments |= {
                "submission_id": str(call.id),
                "native_conversation_id": str(chat.conversation_id),
            }
        return await _call_memory(config, spec, arguments)

    return handler


def family(config: Presence[MemoryClientConfig]) -> ToolFamily:
    """The memory bindings: available when configured and connected; saves when admitted."""

    specs = (*MEMORY_READ_SPECS, MEMORY_SAVE_NOTE_SPEC)
    bindings = []
    for spec in specs:
        if isinstance(config, Absent):
            execute: Any = Unavailable("shared memory is not configured")
        elif not config.value.connect or (spec is MEMORY_SAVE_NOTE_SPEC and not config.value.admit):
            execute = Unavailable("shared memory is not connected or admitted")
        else:
            execute = Available(_handler(spec, config.value))
        bindings.append(
            ToolBinding(
                spec=spec,
                execute=execute,
                replay_policy=ReplayPolicy.ReDispatchable,
                implementation_revision="nexus-shared-memory-v2",
                policy_epoch=PolicyEpoch("nexus-shared-memory-v1"),
                policy_inputs={},
            )
        )
    return ToolFamily("memory", specs, tuple(bindings))
