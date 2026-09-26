"""Strict private wire contract for Codex generations over the UDS."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Annotated, Literal, Self
from uuid import UUID

from provider_runtime import Absent as RuntimeAbsent
from provider_runtime import Present as RuntimePresent
from pydantic import (
    Field,
    JsonValue,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    CodexPersonalSelection,
    GenerationIntent,
    GenerationSpecWire,
    JsonSchemaOutput,
    StrictJsonOutputSnapshot,
    TextOutput,
    TextOutputSnapshot,
    WireTaggedModel,
    validate_intent_bounds,
)

if TYPE_CHECKING:
    from provider_runtime.agent_runtime import AgentModelCatalog, AgentModelFacts

COMMAND_SCHEMA_VERSION = "nexus-generation-command.v4"
COMMAND_DRAFT_SCHEMA_VERSION = "nexus-generation-command-draft.v2"
ADMISSION_SCHEMA_VERSION = "nexus-generation-admission.v2"
EVENT_SCHEMA_VERSION = "nexus-generation-event.v3"
HEALTH_SCHEMA_VERSION = "nexus-generation-health.v3"
MODEL_CATALOG_SCHEMA_VERSION = "nexus-codex-model-catalog.v2"
MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024
MAX_MODEL_CATALOG_BODY_BYTES = 2 * 1024 * 1024
MAX_ADMISSION_BODY_BYTES = 4 * 1024
COMMAND_ENVELOPE_BYTES = 4 * 1024
MAX_COMMAND_BODY_BYTES = (
    6 * (32 * 1024 + 1024 * 1024 + MAX_OUTPUT_SCHEMA_BYTES) + COMMAND_ENVELOPE_BYTES
)

CatalogKey = Annotated[str, StringConstraints(min_length=1, max_length=256)]
CatalogRevision = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
AcceptedAt = Annotated[
    str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
]


class CodexCatalogReasoning(WireTaggedModel):
    key: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    native_wire_value: CatalogKey


class CodexCatalogModel(WireTaggedModel):
    key: CatalogKey
    dispatch_model: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    input_modalities: tuple[Literal["text", "image"], ...] = Field(min_length=1)
    reasoning: tuple[CodexCatalogReasoning, ...] = Field(min_length=1, max_length=16)
    source_default_reasoning: Presence[CatalogKey]
    row_fingerprint: Sha256Hex

    @model_validator(mode="after")
    def _validate_source_facts(self) -> Self:
        if len(set(self.input_modalities)) != len(self.input_modalities):
            raise ValueError("Codex catalog input modalities must be unique")
        reasoning_keys = tuple(item.key for item in self.reasoning)
        if len(set(reasoning_keys)) != len(reasoning_keys):
            raise ValueError("Codex catalog reasoning keys must be unique")
        for capacity in (self.source_context_window, self.source_max_output_tokens):
            if isinstance(capacity, Present) and capacity.value <= 0:
                raise ValueError("Codex catalog source capacities must be positive")
        if (
            isinstance(self.source_default_reasoning, Present)
            and self.source_default_reasoning.value not in reasoning_keys
        ):
            raise ValueError("Codex catalog default reasoning is not a reasoning row")
        return self


class CodexModelCatalog(WireTaggedModel):
    """Secret-free authenticated AgentRuntime catalog crossing the private UDS."""

    schema_version: Literal["nexus-codex-model-catalog.v2"] = MODEL_CATALOG_SCHEMA_VERSION
    backend_contract_revision: CatalogRevision
    definition_revision: Sha256Hex
    native_revision: Presence[CatalogRevision]
    observed_at: datetime
    models: tuple[CodexCatalogModel, ...] = Field(max_length=512)
    supports_frozen_mcp_tools: bool

    @field_validator("observed_at")
    @classmethod
    def _observed_at_is_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Codex catalog observed_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def _unique_models(self) -> Self:
        keys = tuple(model.key for model in self.models)
        if len(set(keys)) != len(keys):
            raise ValueError("Codex catalog model keys must be unique")
        return self


def codex_model_catalog_to_wire(catalog: AgentModelCatalog) -> CodexModelCatalog:
    """Translate the external AgentRuntime value at the private-host boundary."""

    return CodexModelCatalog(
        backend_contract_revision=catalog.backend_contract_revision,
        definition_revision=catalog.definition_revision,
        native_revision=_to_wire(catalog.native_revision),
        observed_at=catalog.observed_at,
        models=tuple(_codex_model_to_wire(model) for model in catalog.models),
        supports_frozen_mcp_tools=catalog.supports_frozen_mcp_tools,
    )


def _codex_model_to_wire(model: AgentModelFacts) -> CodexCatalogModel:
    return CodexCatalogModel(
        key=model.key,
        dispatch_model=model.dispatch_model,
        label=model.label,
        source_context_window=_to_wire(model.source_context_window),
        source_max_output_tokens=_to_wire(model.source_max_output_tokens),
        input_modalities=model.input_modalities,
        reasoning=tuple(
            CodexCatalogReasoning(
                key=reasoning.key,
                label=reasoning.label,
                native_wire_value=reasoning.native_wire_value,
            )
            for reasoning in model.reasoning
        ),
        source_default_reasoning=_to_wire(model.source_default_reasoning),
        row_fingerprint=model.row_fingerprint,
    )


def _to_wire[T](value: RuntimeAbsent | RuntimePresent[T]) -> Absent | Present[T]:
    if isinstance(value, RuntimeAbsent):
        return Absent()
    return Present[T](value=value.value)


class _GenerationCommandFacts(WireTaggedModel):
    """Grant-free semantic facts shared by admission and dispatch."""

    request_id: UUID
    spec: GenerationSpecWire
    intent: GenerationIntent

    @model_validator(mode="after")
    def _matches_frozen_spec(self, info: ValidationInfo) -> Self:
        if not isinstance(self.spec.selection, CodexPersonalSelection) or not isinstance(
            self.spec.resolved_dispatch_target, CodexDispatchTargetSnapshot
        ):
            raise ValueError("Codex host accepts only CodexPersonal GenerationSpec values")
        validate_intent_bounds(
            self.intent,
            instructions_max_bytes=self.spec.bounds.instructions_max_bytes,
            input_max_bytes=self.spec.bounds.input_max_bytes,
        )
        plan = self.spec.model_tool_plan_snapshot
        if isinstance(plan, Present):
            raise ValueError("Codex model tools are unavailable")
        if isinstance(self.intent.output, JsonSchemaOutput):
            schema_bytes = len(_canonical_json_bytes(self.intent.output.schema_))
            if schema_bytes > MAX_OUTPUT_SCHEMA_BYTES:
                raise ValueError(f"schema bytes exceed {MAX_OUTPUT_SCHEMA_BYTES} bytes")
        # The digests prove bytes this process did not produce; check them once,
        # where JSON crossed the host boundary, not on every in-process rebuild.
        if info.mode == "json":
            if _text_digest(self.intent.instructions) != self.spec.instructions_digest:
                raise ValueError("instructions differ from the frozen GenerationSpec")
            if _text_digest(self.intent.input) != self.spec.input_digest:
                raise ValueError("input differs from the frozen GenerationSpec")
            if _digest(self.intent.model_dump(mode="json", by_alias=True)) != (
                self.spec.prompt_payload_ref.payload_digest
            ):
                raise ValueError("intent differs from the frozen prompt payload identity")
            _validate_output_contract(self)
        return self


class GenerationCommandDraft(_GenerationCommandFacts):
    """Grant-free command admitted before any durable child or native work."""

    schema_version: Literal["nexus-generation-command-draft.v2"] = COMMAND_DRAFT_SCHEMA_VERSION


class GenerationCommand(_GenerationCommandFacts):
    """The sole dispatchable command, created only after host admission."""

    schema_version: Literal["nexus-generation-command.v4"] = COMMAND_SCHEMA_VERSION


class GenerationAdmissionRequest(WireTaggedModel):
    """Grant-free immutable identity used to reserve the sole host slot."""

    schema_version: Literal["nexus-generation-admission-request.v3"] = (
        "nexus-generation-admission-request.v3"
    )
    request_id: UUID
    generation_spec_fingerprint: Sha256Hex
    request_fingerprint: Sha256Hex
    turn_timeout_seconds: int = Field(gt=0)


class GenerationAdmission(WireTaggedModel):
    """One replay-stable pre-provider acceptance of the sole host slot."""

    schema_version: Literal["nexus-generation-admission.v2"] = ADMISSION_SCHEMA_VERSION
    request_id: UUID
    admission_id: UUID
    admitted_at: AcceptedAt
    runtime_deadline_seconds: int = Field(gt=0)

    @field_validator("admitted_at")
    @classmethod
    def _admitted_at_is_utc(cls, value: str) -> str:
        return _utc_instant(value, "admitted_at")


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
    "transport_unavailable",
    "session_unavailable",
    "invalid_request",
    "runtime_defect",
]


class GenerationFailure(WireTaggedModel):
    kind: FailureKind
    stage: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = None
    cause_code: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = None


class GenerationUsage(WireTaggedModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)
    cache_read_input_tokens: int | None = Field(default=None, ge=0)
    cache_write_input_tokens: int | None = Field(default=None, ge=0)


class GenerationSessionRef(WireTaggedModel):
    schema_version: Literal["agent-session-ref.v2"]
    backend: Literal["codex"]
    transport: Literal["app_server"]
    native_session_id: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    profile_key: Literal["codex-personal"]
    state_root_fingerprint: Sha256Hex
    cwd_fingerprint: Sha256Hex


class GenerationText(WireTaggedModel):
    kind: Literal["text"] = "text"
    text: str


class GenerationToolUse(WireTaggedModel):
    kind: Literal["tool_use"] = "tool_use"
    tool_call_id: Annotated[str, StringConstraints(min_length=1)]
    name: Annotated[str, StringConstraints(min_length=1)]
    phase: Literal["started", "updated", "completed"]
    succeeded: bool | None = None

    @model_validator(mode="after")
    def _completion_has_result(self) -> Self:
        if (self.phase == "completed") != (self.succeeded is not None):
            raise ValueError("succeeded is required for, and only for, completed tool use")
        return self


class GenerationUsageEvent(WireTaggedModel):
    kind: Literal["usage"] = "usage"
    usage: GenerationUsage


class GenerationPermissionRequest(WireTaggedModel):
    kind: Literal["permission_request"] = "permission_request"
    operation: Literal["command", "file_change", "tool_use"]
    summary: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    tool_name: Annotated[str, StringConstraints(min_length=1)] | None = None
    decision: Literal["allow", "deny", "abort"]

    @model_validator(mode="after")
    def _tool_name_matches_operation(self) -> Self:
        if (self.operation == "tool_use") != (self.tool_name is not None):
            raise ValueError("tool_name is required for, and only for, tool_use requests")
        return self


class GenerationNative(WireTaggedModel):
    kind: Literal["native"] = "native"
    native_type: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class GenerationTerminal(WireTaggedModel):
    kind: Literal["terminal"] = "terminal"
    status: Literal["succeeded", "failed", "cancelled"]
    failure: GenerationFailure | None
    final_text: str
    structured_output: dict[str, JsonValue] | None
    session_ref: GenerationSessionRef | None
    usage: GenerationUsage | None
    accepted_at: AcceptedAt
    native_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    library_contract_revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]

    @field_validator("accepted_at")
    @classmethod
    def _accepted_at_is_utc(cls, value: str) -> str:
        return _utc_instant(value, "accepted_at")

    @model_validator(mode="after")
    def _terminal_state(self) -> Self:
        if self.status == "succeeded":
            if self.failure is not None:
                raise ValueError("successful terminal cannot carry failure")
            if self.session_ref is None:
                raise ValueError("successful terminal requires session reference")
            return self
        if self.structured_output is not None:
            raise ValueError("non-success terminal cannot carry structured output")
        if (self.status == "failed") != (self.failure is not None):
            raise ValueError("failure is required for, and only for, a failed terminal")
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


class GenerationFrame(WireTaggedModel):
    schema_version: Literal["nexus-generation-event.v3"] = EVENT_SCHEMA_VERSION
    request_id: UUID
    sequence: int = Field(ge=0)
    event: GenerationEvent


class GenerationHealth(WireTaggedModel):
    schema_version: Literal["nexus-generation-health.v3"] = HEALTH_SCHEMA_VERSION
    status: Literal["ready"] = "ready"
    backend: Literal["codex"] = "codex"
    transport: Literal["app_server"] = "app_server"
    auth_profile: Literal["codex-personal"] = "codex-personal"
    command_schema_version: Literal["nexus-generation-command.v4"] = COMMAND_SCHEMA_VERSION
    native_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    library_contract_revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]


def capacity_rejection_bytes() -> bytes:
    """The only body that proves the host accepted nothing."""

    return b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}'


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
]


class GenerationContractDefect(RuntimeError):
    """A host/contract defect that must not become a product terminal."""


FAILURE_KIND_TO_NORMALIZED: MappingProxyType[str, NormalizedFailureCode] = MappingProxyType(
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
        "transport_unavailable": "runtime_unavailable",
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
        return FAILURE_KIND_TO_NORMALIZED[kind]
    except KeyError as error:
        raise GenerationContractDefect(f"unknown host failure kind {kind!r}") from error


def retained_terminal_error_detail(terminal: GenerationTerminal) -> str | None:
    """Derive the durable detail from the terminal's own closed status algebra."""

    if terminal.status == "succeeded":
        return None
    if terminal.status == "cancelled":
        return "codex generation cancelled"
    if terminal.failure is None:
        raise AssertionError("failed generation terminal has no failure kind")
    normalized_failure(terminal.failure.kind)
    detail = f"codex generation failed: {terminal.failure.kind}"
    if terminal.failure.stage is not None:
        detail += f"; stage={terminal.failure.stage}"
    if terminal.failure.cause_code is not None:
        detail += f"; cause={terminal.failure.cause_code}"
    return detail


def generation_draft_fingerprint(draft: GenerationCommandDraft) -> str:
    """Fingerprint the exact grant-free facts journaled before route dispatch."""

    return _digest(
        {
            "generation_spec_fingerprint": draft.spec.fingerprint,
            "intent_digest": _digest(draft.intent.model_dump(mode="json", by_alias=True)),
        }
    )


def generation_command_draft(command: GenerationCommand) -> GenerationCommandDraft:
    """Project a dispatchable command back to its exact admitted facts."""

    return GenerationCommandDraft(
        request_id=command.request_id, spec=command.spec, intent=command.intent
    )


def generation_command_from_draft(draft: GenerationCommandDraft) -> GenerationCommand:
    """Create the only dispatchable command after successful host admission."""

    return GenerationCommand(request_id=draft.request_id, spec=draft.spec, intent=draft.intent)


def generation_admission_request(draft: GenerationCommandDraft) -> GenerationAdmissionRequest:
    """Project a grant-free draft onto its replay-stable admission identity."""

    return GenerationAdmissionRequest(
        request_id=draft.request_id,
        generation_spec_fingerprint=draft.spec.fingerprint,
        request_fingerprint=generation_draft_fingerprint(draft),
        turn_timeout_seconds=draft.spec.bounds.turn_timeout_seconds,
    )


def _validate_output_contract(command: _GenerationCommandFacts) -> None:
    output = command.intent.output
    frozen = command.spec.output_contract
    if isinstance(output, TextOutput) and isinstance(frozen, TextOutputSnapshot):
        return
    if isinstance(output, JsonSchemaOutput) and isinstance(frozen, StrictJsonOutputSnapshot):
        if (output.name, output.schema_) == (frozen.name, frozen.json_schema):
            return
    raise ValueError("generation output differs from the frozen GenerationSpec")


def _utc_instant(value: str, label: str) -> str:
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"{label} must be a real UTC RFC3339 instant") from error
    if parsed.utcoffset() is None:
        raise ValueError(f"{label} must be UTC")
    return value


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json_bytes(value)).hexdigest()


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
