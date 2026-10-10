"""Private owner-chat configuration and the bounded shared-memory MCP client."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self
from uuid import UUID

import httpx2
from llm_tools.schema import SchemaDecodeError, strict_decode
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
    model_validator,
)
from universal_memory import MemoryError
from universal_memory.policy import RESULT_BYTES, canonical_json
from universal_memory.tools import MEMORY_SEARCH_SPEC, MemoryToolFailure

from nexus.schemas.presence import Absent, Presence

type MemoryToolName = Literal[
    "memory_view",
    "memory_zoom",
    "memory_date",
    "memory_search",
    "memory_open",
    "memory_save_note",
]


class MemoryClientConfig(BaseModel):
    """The backend handoff from the central stopped sharing declaration."""

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
            and set(processors).issubset(self.processors)
        )


def load_memory_client_config(path: Path | None) -> Presence[MemoryClientConfig]:
    if path is None:
        return Absent()
    try:
        config = TypeAdapter(Presence[MemoryClientConfig]).validate_json(
            path.read_bytes(), strict=True
        )
    except (OSError, ValueError):
        # justify-defect: an explicitly configured private declaration must be valid.
        raise RuntimeError("invalid private memory client configuration") from None
    return config


@dataclass(frozen=True, slots=True)
class MemoryToolCall:
    config: MemoryClientConfig
    name: MemoryToolName
    arguments: dict[str, JsonValue]


async def call_memory_tool(call: MemoryToolCall) -> dict[str, JsonValue]:
    """Acquire and use one public protocol scope; never resend a tool call."""
    async with httpx2.AsyncClient(
        headers={"authorization": "Bearer " + call.config.bearer.get_secret_value()},
        timeout=httpx2.Timeout(20.0, connect=10.0),
        follow_redirects=False,
        trust_env=False,
    ) as http:
        async with streamable_http_client(str(call.config.mcp_url), http_client=http) as (
            read,
            write,
        ):
            async with ClientSession(
                read,
                write,
                client_info=Implementation(name="nexus-owner", version="1"),
                read_timeout_seconds=20.0,
            ) as client:
                await client.initialize()
                await client.list_tools()
                result = await client.call_tool(call.name, call.arguments)
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
        # justify-defect: the owned memory server promises one bounded text result.
        raise RuntimeError("memory server violated its result contract")
    if result.is_error:
        try:
            failure = strict_decode(
                MemoryToolFailure,
                MEMORY_SEARCH_SPEC.error_schema,
                TypeAdapter(JsonValue).validate_json(result.content[0].text, strict=True),
            )
        except (ValueError, SchemaDecodeError):
            # justify-defect: the server publishes the shared closed failure schema.
            raise RuntimeError("memory server returned an invalid failure") from None
        raise MemoryError(failure.code)
    try:
        return TypeAdapter(dict[str, JsonValue]).validate_json(result.content[0].text, strict=True)
    except ValueError:
        # justify-defect: successful shared memory results are JSON objects.
        raise RuntimeError("memory server returned invalid result JSON") from None
