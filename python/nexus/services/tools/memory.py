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
    canonical_json_bytes,
)
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, Implementation, TextContent
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


async def _call_memory(
    config: MemoryClientConfig, name: str, arguments: dict[str, JsonValue]
) -> dict[str, JsonValue]:
    """One protocol session per call; a call is never resent."""

    async with httpx2.AsyncClient(
        headers={"authorization": "Bearer " + config.bearer.get_secret_value()},
        timeout=httpx2.Timeout(20.0, connect=10.0),
        follow_redirects=False,
        trust_env=False,
    ) as http:
        async with streamable_http_client(str(config.mcp_url), http_client=http) as (read, write):
            async with ClientSession(
                read,
                write,
                client_info=Implementation(name="nexus-owner", version="1"),
                read_timeout_seconds=20.0,
            ) as client:
                await client.initialize()
                await client.list_tools()
                result = await client.call_tool(name, arguments)
    if (
        not isinstance(result, CallToolResult)
        or result.structured_content is not None
        or len(result.content) != 1
        or not isinstance(result.content[0], TextContent)
        or len(
            canonical_json(
                result.model_dump(mode="json", exclude_none=True, by_alias=True)
            ).encode()
        )
        > RESULT_BYTES
    ):
        raise RuntimeError("memory server violated its result contract")
    body = result.content[0].text
    if result.is_error:
        try:
            failure = MemoryToolFailure.model_validate_json(body, strict=True)
        except ValidationError:
            raise RuntimeError("memory server returned an invalid failure") from None
        raise MemoryError(failure.code)
    try:
        return TypeAdapter(dict[str, JsonValue]).validate_json(body, strict=True)
    except ValidationError:
        raise RuntimeError("memory server returned a non-object result") from None


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
        try:
            result = await _call_memory(config, str(spec.id).replace(".", "_"), arguments)
        except MemoryError as error:
            raise DeclaredToolFailure(
                MemoryToolFailure.model_validate({"code": error.code}), actual_attempts=0
            ) from None
        return TypeAdapter(spec.success_type).validate_json(
            canonical_json_bytes(result), strict=True
        )

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
                implementation_revision="nexus-shared-memory-v1",
                policy_epoch=PolicyEpoch("nexus-shared-memory-v1"),
                policy_inputs={},
            )
        )
    return ToolFamily("memory", specs, tuple(bindings))
