"""Strict private v2 wire contract for Codex generations."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from types import MappingProxyType
from typing import Annotated, Literal, Self, get_origin
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticUndefined

from nexus.services import generation_policy
from nexus.services.generation_intent import (
    BearerToolGrant,
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
    utf8_size,
    validate_intent_bounds,
)

COMMAND_SCHEMA_VERSION = "nexus-generation-command.v2"
EVENT_SCHEMA_VERSION = "nexus-generation-event.v2"
HEALTH_SCHEMA_VERSION = "nexus-generation-health.v2"
REJECTION_SCHEMA_VERSION = "nexus-generation-rejection.v2"
MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024
MAX_TOOL_GRANT_BYTES = 16 * 1024
COMMAND_ENVELOPE_BYTES = 4 * 1024
MAX_COMMAND_BODY_BYTES = (
    6 * (32 * 1024 + 1024 * 1024 + MAX_OUTPUT_SCHEMA_BYTES + MAX_TOOL_GRANT_BYTES)
    + COMMAND_ENVELOPE_BYTES
)


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _require_wire_tags(cls, data: object, info: ValidationInfo) -> object:
        if info.mode == "json" and isinstance(data, dict):
            missing = [
                name
                for name, field in cls.model_fields.items()
                if field.default is not PydanticUndefined
                and get_origin(field.annotation) is Literal
                and name not in data
            ]
            if missing:
                raise ValueError(f"wire tags are required: {', '.join(missing)}")
        return data


class _Operation(_WireModel):
    revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class MetadataEnrichmentOperation(_Operation):
    kind: Literal["metadata_enrichment"] = "metadata_enrichment"


class MediaSummaryOperation(_Operation):
    kind: Literal["media_summary"] = "media_summary"


class SynapseOperation(_Operation):
    kind: Literal["synapse"] = "synapse"


class DawnWriteOperation(_Operation):
    kind: Literal["dawn_write"] = "dawn_write"


class OracleOperation(_Operation):
    kind: Literal["oracle"] = "oracle"


class DossierPageOperation(_Operation):
    kind: Literal["dossier_page"] = "dossier_page"


class DossierNoteOperation(_Operation):
    kind: Literal["dossier_note"] = "dossier_note"


class DossierMediaOperation(_Operation):
    kind: Literal["dossier_media"] = "dossier_media"


class DossierConversationOperation(_Operation):
    kind: Literal["dossier_conversation"] = "dossier_conversation"


class DossierLibraryOperation(_Operation):
    kind: Literal["dossier_library"] = "dossier_library"


class DossierPodcastOperation(_Operation):
    kind: Literal["dossier_podcast"] = "dossier_podcast"


class DossierContributorOperation(_Operation):
    kind: Literal["dossier_contributor"] = "dossier_contributor"


class DossierIdeaOperation(_Operation):
    kind: Literal["dossier_idea"] = "dossier_idea"


class DossierIdeaResolveOperation(_Operation):
    kind: Literal["dossier_idea_resolve"] = "dossier_idea_resolve"


class ChatOperation(_Operation):
    kind: Literal["chat"] = "chat"
    profile: Literal["fast", "balanced", "deep"]


GenerationOperation = Annotated[
    MetadataEnrichmentOperation
    | MediaSummaryOperation
    | SynapseOperation
    | DawnWriteOperation
    | OracleOperation
    | DossierPageOperation
    | DossierNoteOperation
    | DossierMediaOperation
    | DossierConversationOperation
    | DossierLibraryOperation
    | DossierPodcastOperation
    | DossierContributorOperation
    | DossierIdeaOperation
    | DossierIdeaResolveOperation
    | ChatOperation,
    Field(discriminator="kind"),
]


class GenerationCommand(_WireModel):
    schema_version: Literal["nexus-generation-command.v2"] = COMMAND_SCHEMA_VERSION
    request_id: UUID
    operation: GenerationOperation
    policy_revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    policy_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    intent: GenerationIntent
    tool_grant: BearerToolGrant | None = None

    @model_validator(mode="after")
    def _matches_policy(self) -> Self:
        if isinstance(self.operation, ChatOperation):
            policy = generation_policy.chat_policy(self.operation.profile)
            expected_revision = generation_policy.operation_revision(
                "chat", profile=self.operation.profile
            )
            if self.tool_grant is None:
                raise ValueError("ChatTools generation requires a bearer grant")
            if not isinstance(self.intent.output, TextOutput):
                raise ValueError("ChatTools requires Text output")
        else:
            policy = generation_policy.operation_policy(self.operation.kind)
            expected_revision = generation_policy.operation_revision(self.operation.kind)
            if self.tool_grant is not None:
                raise ValueError("Synthesis generation forbids a bearer grant")
        if self.operation.revision != expected_revision:
            raise ValueError("operation revision does not match the policy catalog")
        if self.policy_revision != generation_policy.POLICY_REVISION:
            raise ValueError("policy revision does not match the host policy")
        if self.policy_fingerprint != generation_policy.POLICY_FINGERPRINT:
            raise ValueError("policy fingerprint does not match the host policy")
        validate_intent_bounds(
            self.intent,
            instructions_max_bytes=policy.instructions_max_bytes,
            input_max_bytes=policy.input_max_bytes,
        )
        if isinstance(self.intent.output, JsonSchemaOutput):
            schema_bytes = _canonical_json_bytes(self.intent.output.schema_)
            if len(schema_bytes) > MAX_OUTPUT_SCHEMA_BYTES:
                raise ValueError(f"schema bytes exceed {MAX_OUTPUT_SCHEMA_BYTES} bytes")
        if self.tool_grant is not None:
            grant_bytes = utf8_size(self.tool_grant.token.get_secret_value())
            if grant_bytes > MAX_TOOL_GRANT_BYTES:
                raise ValueError(f"grant bytes exceed {MAX_TOOL_GRANT_BYTES} bytes")
        return self


FailureKind = Literal[
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


class GenerationFailure(_WireModel):
    kind: FailureKind


class GenerationUsage(_WireModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)
    cache_read_input_tokens: int | None = Field(default=None, ge=0)
    cache_write_input_tokens: int | None = Field(default=None, ge=0)


class GenerationSessionRef(_WireModel):
    schema_version: Literal["agent-session-ref.v1"]
    backend: Literal["codex"]
    transport: Literal["sdk"]
    native_session_id: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    profile_key: Literal["codex-personal"]
    state_root_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    cwd_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class GenerationText(_WireModel):
    kind: Literal["text"] = "text"
    text: str


class GenerationToolUse(_WireModel):
    kind: Literal["tool_use"] = "tool_use"
    tool_call_id: Annotated[str, StringConstraints(min_length=1)]
    name: Annotated[str, StringConstraints(min_length=1)]
    phase: Literal["started", "updated", "completed"]
    succeeded: bool | None = None

    @model_validator(mode="after")
    def _completion_has_result(self) -> Self:
        if self.phase == "completed" and self.succeeded is None:
            raise ValueError("completed tool use requires succeeded")
        if self.phase != "completed" and self.succeeded is not None:
            raise ValueError("succeeded is valid only for completed tool use")
        return self


class GenerationUsageEvent(_WireModel):
    kind: Literal["usage"] = "usage"
    usage: GenerationUsage


class GenerationPermissionRequest(_WireModel):
    kind: Literal["permission_request"] = "permission_request"
    operation: Literal["command", "file_change", "tool_use"]
    summary: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    tool_name: Annotated[str, StringConstraints(min_length=1)] | None = None
    decision: Literal["allow", "deny", "abort"]

    @model_validator(mode="after")
    def _tool_name_matches_operation(self) -> Self:
        if self.operation == "tool_use" and self.tool_name is None:
            raise ValueError("tool_use permission request requires tool_name")
        if self.operation != "tool_use" and self.tool_name is not None:
            raise ValueError("tool_name is valid only for tool_use permission requests")
        return self


class GenerationNative(_WireModel):
    kind: Literal["native"] = "native"
    native_type: Annotated[str, StringConstraints(min_length=1, max_length=128)]


AcceptedAt = Annotated[
    str,
    StringConstraints(
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$",
    ),
]
Diagnostic = Annotated[str, StringConstraints(min_length=1, max_length=1_000)]


class GenerationTerminal(_WireModel):
    kind: Literal["terminal"] = "terminal"
    status: Literal["succeeded", "failed", "cancelled"]
    failure: GenerationFailure | None
    final_text: str
    structured_output: dict[str, JsonValue] | None
    session_ref: GenerationSessionRef | None
    usage: GenerationUsage | None
    diagnostics: tuple[Diagnostic, ...] = Field(max_length=8)
    accepted_at: AcceptedAt
    sdk_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    runtime_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]

    @field_validator("accepted_at")
    @classmethod
    def _accepted_at_is_utc(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as error:
            raise ValueError("accepted_at must be a real UTC RFC3339 instant") from error
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("accepted_at must be UTC")
        return value

    @model_validator(mode="after")
    def _terminal_state(self) -> Self:
        if self.status == "succeeded" and self.failure is not None:
            raise ValueError("successful terminal cannot carry failure")
        if self.status == "succeeded" and self.diagnostics:
            raise ValueError("successful terminal cannot carry diagnostics")
        if self.status == "succeeded" and self.session_ref is None:
            raise ValueError("successful terminal requires session reference")
        if self.status == "failed" and self.failure is None:
            raise ValueError("failed terminal requires failure")
        if self.status != "succeeded" and self.structured_output is not None:
            raise ValueError("non-success terminal cannot carry structured output")
        if self.status != "succeeded" and not self.diagnostics:
            raise ValueError("non-success terminal requires diagnostics")
        if self.status == "cancelled" and self.failure is not None:
            raise ValueError("cancelled terminal cannot carry failure")
        return self


GenerationEvent = Annotated[
    GenerationText
    | GenerationToolUse
    | GenerationUsageEvent
    | GenerationPermissionRequest
    | GenerationNative
    | GenerationTerminal,
    Field(discriminator="kind"),
]


class GenerationFrame(_WireModel):
    schema_version: Literal["nexus-generation-event.v2"] = EVENT_SCHEMA_VERSION
    request_id: UUID
    sequence: int = Field(ge=0)
    event: GenerationEvent


class GenerationHealth(_WireModel):
    schema_version: Literal["nexus-generation-health.v2"] = HEALTH_SCHEMA_VERSION
    status: Literal["ready"] = "ready"
    backend: Literal["codex"] = "codex"
    transport: Literal["sdk"] = "sdk"
    auth_profile: Literal["codex-personal"] = "codex-personal"
    command_schema_version: Literal["nexus-generation-command.v2"] = COMMAND_SCHEMA_VERSION
    policy_revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    sdk_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    runtime_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class GenerationCapacityRejection(_WireModel):
    schema_version: Literal["nexus-generation-rejection.v2"] = REJECTION_SCHEMA_VERSION
    kind: Literal["capacity_unavailable"] = "capacity_unavailable"


NormalizedOutcome = Literal["Succeeded", "Cancelled", "Failed"]
NormalizedFailureCode = Literal[
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
    "defect",
]


class GenerationContractDefect(RuntimeError):
    """A host/contract defect that must not become a product terminal."""


FAILURE_KIND_TO_NORMALIZED: MappingProxyType[str, str] = MappingProxyType(
    {
        "credential_unavailable": "auth",
        "credential_rejected": "auth",
        "quota_exhausted": "quota",
        "turn_timeout": "timeout",
        "output_limit_exceeded": "output_limit",
        "output_schema_violation": "invalid_output",
        "policy_violation": "policy_violation",
        "approval_unanswered": "policy_violation",
        "executable_unavailable": "runtime_unavailable",
        "sdk_unavailable": "runtime_unavailable",
        "session_unavailable": "runtime_unavailable",
        "backend_failed": "runtime_unavailable",
        "capacity_unavailable": "capacity_unavailable",
        "context_admission": "context_too_large",
    }
)


def normalized_failure(kind: str) -> NormalizedFailureCode:
    if kind in {"invalid_request", "runtime_defect"}:
        raise GenerationContractDefect(f"{kind} is a host defect")
    try:
        return FAILURE_KIND_TO_NORMALIZED[kind]  # type: ignore[return-value]
    except KeyError as error:
        raise GenerationContractDefect(f"unknown host failure kind {kind!r}") from error


def normalized_outcome(terminal: GenerationTerminal) -> NormalizedOutcome:
    if terminal.status == "succeeded":
        return "Succeeded"
    if terminal.status == "cancelled":
        return "Cancelled"
    return "Failed"


def retained_terminal_error_detail(terminal: GenerationTerminal) -> str | None:
    """Return the closed diagnostic detail safe for durable domain state.

    Host diagnostics are bounded and redacted for transport observation, but an
    operator-attached terminal is not itself proof that submitted diagnostic text
    came from the host. Durable state therefore retains only facts derived from
    the terminal's closed status/failure algebra.
    """

    if terminal.status == "succeeded":
        return None
    if terminal.status == "cancelled":
        return "codex generation cancelled"
    if terminal.failure is None:
        raise AssertionError("failed generation terminal has no failure kind")
    normalized_failure(terminal.failure.kind)
    return f"codex generation failed: {terminal.failure.kind}"


def capacity_rejection_bytes() -> bytes:
    return b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}'


def command_policy(command: GenerationCommand) -> generation_policy.OperationPolicy:
    if isinstance(command.operation, ChatOperation):
        return generation_policy.chat_policy(command.operation.profile)
    return generation_policy.operation_policy(command.operation.kind)


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json_bytes(value)).hexdigest()


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def request_fingerprint(command: GenerationCommand) -> str:
    """Fingerprint replay-relevant request facts, deliberately excluding the grant."""

    if isinstance(command.operation, ChatOperation):
        tool_plan_revision = generation_policy.TOOL_PLAN_REVISION
    else:
        tool_plan_revision = None
    return _digest(
        {
            "operation": command.operation.model_dump(mode="json"),
            "policy_revision": command.policy_revision,
            "prompt_revision": command.operation.revision,
            "tool_plan_revision": tool_plan_revision,
            "intent_digest": _digest(command.intent.model_dump(mode="json")),
        }
    )


__all__ = [
    "COMMAND_SCHEMA_VERSION",
    "COMMAND_ENVELOPE_BYTES",
    "EVENT_SCHEMA_VERSION",
    "MAX_COMMAND_BODY_BYTES",
    "MAX_OUTPUT_SCHEMA_BYTES",
    "MAX_TOOL_GRANT_BYTES",
    "FAILURE_KIND_TO_NORMALIZED",
    "NormalizedOutcome",
    "NormalizedFailureCode",
    "GenerationCapacityRejection",
    "GenerationCommand",
    "GenerationContractDefect",
    "GenerationEvent",
    "GenerationFailure",
    "GenerationFrame",
    "GenerationHealth",
    "GenerationNative",
    "GenerationPermissionRequest",
    "GenerationSessionRef",
    "GenerationTerminal",
    "GenerationText",
    "GenerationToolUse",
    "GenerationUsage",
    "GenerationUsageEvent",
    "capacity_rejection_bytes",
    "command_policy",
    "normalized_outcome",
    "normalized_failure",
    "retained_terminal_error_detail",
    "request_fingerprint",
]
