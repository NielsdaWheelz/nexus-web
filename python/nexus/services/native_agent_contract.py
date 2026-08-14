"""Strict private wire contract for Nexus native-agent turns.

The v1 algebra is intentionally metadata-only. It is API-shaped for a private
Unix socket, but it is not an OpenAI API compatibility surface.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    model_validator,
)

NATIVE_AGENT_COMMAND_SCHEMA_VERSION = "nexus-agent-command.v1"
NATIVE_AGENT_EVENT_SCHEMA_VERSION = "nexus-agent-event.v1"
NATIVE_AGENT_HEALTH_SCHEMA_VERSION = "nexus-agent-health.v1"
NATIVE_AGENT_REJECTION_SCHEMA_VERSION = "nexus-agent-rejection.v1"
METADATA_ENRICHMENT_OPERATION_REVISION: Final = "metadata-enrichment.2026-08-12.3"

type _NonEmptyString = Annotated[str, StringConstraints(min_length=1)]
type _NativeType = Annotated[str, StringConstraints(min_length=1, max_length=128)]
type _Diagnostic = Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
type _Version = Annotated[str, StringConstraints(min_length=1, max_length=128)]
type NativeAgentFailureKind = Literal[
    "quota_exhausted",
    "backend_failed",
    "turn_timeout",
    "output_limit_exceeded",
    "approval_unanswered",
    "output_schema_violation",
    "policy_violation",
    "credential_unavailable",
    "credential_rejected",
    "executable_unavailable",
    "sdk_unavailable",
    "session_unavailable",
    "invalid_request",
    "runtime_defect",
]


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MetadataEnrichmentOperation(_WireModel):
    kind: Literal["metadata_enrichment"] = "metadata_enrichment"
    revision: Literal["metadata-enrichment.2026-08-12.3"]
    input: str

    @model_validator(mode="after")
    def _bounded_input(self) -> Self:
        if not self.input.strip():
            raise ValueError("metadata input must not be blank")
        if len(self.input.encode("utf-8")) > 32_768:
            raise ValueError("metadata input exceeds 32768 UTF-8 bytes")
        return self


type NativeAgentOperation = Annotated[
    MetadataEnrichmentOperation,
    Field(discriminator="kind"),
]


class NativeAgentCommand(_WireModel):
    schema_version: Literal["nexus-agent-command.v1"] = NATIVE_AGENT_COMMAND_SCHEMA_VERSION
    request_id: UUID
    operation: NativeAgentOperation


class NativeAgentSessionRef(_WireModel):
    schema_version: Literal["agent-session-ref.v1"]
    backend: Literal["codex"]
    transport: Literal["sdk"]
    native_session_id: _NonEmptyString
    profile_key: Literal["codex-personal"]
    state_root_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    cwd_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class NativeAgentUsage(_WireModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)
    cache_read_input_tokens: int | None = Field(default=None, ge=0)
    cache_write_input_tokens: int | None = Field(default=None, ge=0)


class NativeAgentText(_WireModel):
    kind: Literal["text"] = "text"
    text: str


class NativeAgentToolUse(_WireModel):
    kind: Literal["tool_use"] = "tool_use"
    tool_call_id: _NonEmptyString
    name: _NonEmptyString
    phase: Literal["started", "updated", "completed"]
    payload: JsonValue = None
    succeeded: bool | None = None

    @model_validator(mode="after")
    def _completion_has_an_outcome(self) -> Self:
        if self.phase == "completed" and self.succeeded is None:
            raise ValueError("completed tool use requires succeeded")
        if self.phase != "completed" and self.succeeded is not None:
            raise ValueError("succeeded is valid only for completed tool use")
        return self


class NativeAgentUsageEvent(_WireModel):
    kind: Literal["usage"] = "usage"
    usage: NativeAgentUsage


class NativeAgentPermissionRequest(_WireModel):
    kind: Literal["permission_request"] = "permission_request"
    operation: Literal["command", "file_change", "tool_use"]
    summary: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    tool_name: _NonEmptyString | None = None
    decision: Literal["allow", "deny", "abort"]

    @model_validator(mode="after")
    def _tool_name_matches_operation(self) -> Self:
        if self.operation == "tool_use" and self.tool_name is None:
            raise ValueError("tool_use permission request requires tool_name")
        if self.operation != "tool_use" and self.tool_name is not None:
            raise ValueError("tool_name is valid only for tool_use permission requests")
        return self


class NativeAgentNative(_WireModel):
    kind: Literal["native"] = "native"
    native_type: _NativeType
    payload: dict[str, JsonValue]


class NativeAgentFailure(_WireModel):
    kind: NativeAgentFailureKind


class NativeAgentTerminal(_WireModel):
    kind: Literal["terminal"] = "terminal"
    status: Literal["succeeded", "failed", "cancelled"]
    failure: NativeAgentFailure | None
    final_text: str
    structured_output: dict[str, JsonValue] | None
    session_ref: NativeAgentSessionRef | None
    usage: NativeAgentUsage | None
    diagnostics: Annotated[tuple[_Diagnostic, ...], Field(max_length=8)] = ()
    sdk_version: _Version
    runtime_version: _Version

    @model_validator(mode="after")
    def _valid_terminal(self) -> Self:
        if self.status == "succeeded":
            if self.failure is not None:
                raise ValueError("successful terminal cannot carry failure")
            if self.structured_output is None:
                raise ValueError("successful metadata terminal requires structured_output")
            if self.session_ref is None:
                raise ValueError("successful terminal requires session_ref")
            return self
        if self.status == "failed":
            if self.failure is None:
                raise ValueError("failed terminal requires failure")
        elif self.failure is not None:
            raise ValueError("cancelled terminal cannot carry failure")
        if self.structured_output is not None:
            raise ValueError("non-success terminal cannot carry structured_output")
        return self


type NativeAgentEvent = Annotated[
    NativeAgentText
    | NativeAgentToolUse
    | NativeAgentUsageEvent
    | NativeAgentPermissionRequest
    | NativeAgentNative
    | NativeAgentTerminal,
    Field(discriminator="kind"),
]


class NativeAgentFrame(_WireModel):
    schema_version: Literal["nexus-agent-event.v1"] = NATIVE_AGENT_EVENT_SCHEMA_VERSION
    request_id: UUID
    sequence: int = Field(ge=0)
    event: NativeAgentEvent


class NativeAgentHealth(_WireModel):
    schema_version: Literal["nexus-agent-health.v1"] = NATIVE_AGENT_HEALTH_SCHEMA_VERSION
    status: Literal["ready"] = "ready"
    backend: Literal["codex"] = "codex"
    transport: Literal["sdk"] = "sdk"
    auth_profile: Literal["codex-personal"] = "codex-personal"


class NativeAgentCapacityRejection(_WireModel):
    schema_version: Literal["nexus-agent-rejection.v1"] = NATIVE_AGENT_REJECTION_SCHEMA_VERSION
    kind: Literal["capacity_unavailable"] = "capacity_unavailable"


__all__ = [
    "MetadataEnrichmentOperation",
    "METADATA_ENRICHMENT_OPERATION_REVISION",
    "NATIVE_AGENT_COMMAND_SCHEMA_VERSION",
    "NATIVE_AGENT_EVENT_SCHEMA_VERSION",
    "NATIVE_AGENT_HEALTH_SCHEMA_VERSION",
    "NATIVE_AGENT_REJECTION_SCHEMA_VERSION",
    "NativeAgentCapacityRejection",
    "NativeAgentCommand",
    "NativeAgentEvent",
    "NativeAgentFailure",
    "NativeAgentFailureKind",
    "NativeAgentFrame",
    "NativeAgentHealth",
    "NativeAgentNative",
    "NativeAgentPermissionRequest",
    "NativeAgentSessionRef",
    "NativeAgentTerminal",
    "NativeAgentText",
    "NativeAgentToolUse",
    "NativeAgentUsage",
    "NativeAgentUsageEvent",
]
