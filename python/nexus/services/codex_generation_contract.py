"""Strict private v2 wire contract for Codex generations."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Annotated, Literal, Self, assert_never
from uuid import UUID

from provider_runtime import Absent as RuntimeAbsent
from provider_runtime import Present as RuntimePresent
from pydantic import (
    Field,
    JsonValue,
    StringConstraints,
    field_validator,
    model_validator,
)

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_intent import (
    BearerToolGrant,
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
    WireTaggedModel,
    utf8_size,
    validate_intent_bounds,
)
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    GenerationSpecWire,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
)

if TYPE_CHECKING:
    from provider_runtime.agent_runtime import (
        AgentModelCatalog,
        AgentModelFacts,
        AgentUpgradeFacts,
    )

COMMAND_SCHEMA_VERSION = "nexus-generation-command.v3"
COMMAND_DRAFT_SCHEMA_VERSION = "nexus-generation-command-draft.v1"
ADMISSION_SCHEMA_VERSION = "nexus-generation-admission.v2"
EVENT_SCHEMA_VERSION = "nexus-generation-event.v2"
HEALTH_SCHEMA_VERSION = "nexus-generation-health.v2"
REJECTION_SCHEMA_VERSION = "nexus-generation-rejection.v2"
MODEL_CATALOG_SCHEMA_VERSION = "nexus-codex-model-catalog.v1"
MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024
MAX_TOOL_GRANT_BYTES = 16 * 1024
MAX_MODEL_TOOL_PLAN_BYTES = 64 * 1024
MAX_MODEL_CATALOG_BODY_BYTES = 2 * 1024 * 1024
MAX_ADMISSION_BODY_BYTES = 4 * 1024
COMMAND_ENVELOPE_BYTES = 4 * 1024
MAX_COMMAND_BODY_BYTES = (
    6
    * (
        32 * 1024
        + 1024 * 1024
        + MAX_OUTPUT_SCHEMA_BYTES
        + MAX_TOOL_GRANT_BYTES
        + MAX_MODEL_TOOL_PLAN_BYTES
    )
    + COMMAND_ENVELOPE_BYTES
)


CatalogKey = Annotated[str, StringConstraints(min_length=1, max_length=256)]
CatalogRevision = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class CodexCatalogReasoning(WireTaggedModel):
    key: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    native_wire_value: CatalogKey


class CodexCatalogUpgrade(WireTaggedModel):
    target_key: CatalogKey


class CodexCatalogModel(WireTaggedModel):
    key: CatalogKey
    dispatch_model: CatalogKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    input_modalities: tuple[Literal["text", "image"], ...] = Field(min_length=1)
    reasoning: tuple[CodexCatalogReasoning, ...] = Field(min_length=1, max_length=16)
    source_default_reasoning: Presence[CatalogKey]
    upgrade: Presence[CodexCatalogUpgrade]
    retirement: Absent
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

    schema_version: Literal["nexus-codex-model-catalog.v1"] = MODEL_CATALOG_SCHEMA_VERSION
    backend_contract_revision: CatalogRevision
    definition_revision: Sha256Hex
    native_revision: Presence[CatalogRevision]
    observed_at: datetime
    models: tuple[CodexCatalogModel, ...] = Field(max_length=512)

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


class _GenerationCommandFacts(WireTaggedModel):
    """Grant-free semantic facts shared by admission and dispatch."""

    request_id: UUID
    spec: GenerationSpecWire
    intent: GenerationIntent

    @model_validator(mode="after")
    def _matches_frozen_spec(self) -> Self:
        if not isinstance(self.spec.selection, CodexPersonalSelection) or not isinstance(
            self.spec.resolved_dispatch_target, CodexDispatchTargetSnapshot
        ):
            raise ValueError("Codex host accepts only CodexPersonal GenerationSpec values")
        validate_intent_bounds(
            self.intent,
            instructions_max_bytes=self.spec.bounds.instructions_max_bytes,
            input_max_bytes=self.spec.bounds.input_max_bytes,
        )
        if _text_digest(self.intent.instructions) != self.spec.instructions_digest:
            raise ValueError("instructions differ from the frozen GenerationSpec")
        if _text_digest(self.intent.input) != self.spec.input_digest:
            raise ValueError("input differs from the frozen GenerationSpec")
        if _digest(self.intent.model_dump(mode="json", by_alias=True)) != (
            self.spec.prompt_payload_ref.payload_digest
        ):
            raise ValueError("intent differs from the frozen prompt payload identity")
        _validate_output_contract(self)

        plan = self.spec.model_tool_plan_snapshot
        if isinstance(plan, Present):
            if plan.value.exposure.type != "Native":
                raise ValueError("Codex ModelTools requires Native tool exposure")
        elif not isinstance(plan, Absent):
            assert_never(plan)
        if isinstance(self.intent.output, JsonSchemaOutput):
            schema_bytes = _canonical_json_bytes(self.intent.output.schema_)
            if len(schema_bytes) > MAX_OUTPUT_SCHEMA_BYTES:
                raise ValueError(f"schema bytes exceed {MAX_OUTPUT_SCHEMA_BYTES} bytes")
        if isinstance(plan, Present):
            plan_bytes = len(_canonical_json_bytes(plan.value.model_dump(mode="json")))
            if plan_bytes > MAX_MODEL_TOOL_PLAN_BYTES:
                raise ValueError(f"model tool plan bytes exceed {MAX_MODEL_TOOL_PLAN_BYTES} bytes")
        return self


class GenerationCommandDraft(_GenerationCommandFacts):
    """Grant-free command admitted before any durable child or SDK work."""

    schema_version: Literal["nexus-generation-command-draft.v1"] = COMMAND_DRAFT_SCHEMA_VERSION


class GenerationCommand(_GenerationCommandFacts):
    """The sole dispatchable command, created only after host admission."""

    schema_version: Literal["nexus-generation-command.v3"] = COMMAND_SCHEMA_VERSION
    tool_grant: BearerToolGrant | None = None

    @model_validator(mode="after")
    def _dispatch_authority_is_exact(self) -> Self:
        plan = self.spec.model_tool_plan_snapshot
        if isinstance(plan, Present):
            if self.tool_grant is None:
                raise ValueError("ModelTools generation requires a bearer grant")
        elif isinstance(plan, Absent):
            if self.tool_grant is not None:
                raise ValueError("NoModelTools generation forbids a bearer grant")
        else:
            assert_never(plan)
        if self.tool_grant is not None:
            grant_bytes = utf8_size(self.tool_grant.token.get_secret_value())
            if grant_bytes > MAX_TOOL_GRANT_BYTES:
                raise ValueError(f"grant bytes exceed {MAX_TOOL_GRANT_BYTES} bytes")
        return self


class GenerationAdmissionRequest(WireTaggedModel):
    """Grant-free immutable identity used to reserve the sole host slot."""

    schema_version: Literal["nexus-generation-admission-request.v2"] = (
        "nexus-generation-admission-request.v2"
    )
    request_id: UUID
    generation_spec_fingerprint: Sha256Hex
    request_fingerprint: Sha256Hex
    turn_timeout_seconds: int = Field(gt=0)
    model_tool_plan_fingerprint: Sha256Hex


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


class GenerationFailure(WireTaggedModel):
    kind: FailureKind


class GenerationUsage(WireTaggedModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)
    cache_read_input_tokens: int | None = Field(default=None, ge=0)
    cache_write_input_tokens: int | None = Field(default=None, ge=0)


class GenerationSessionRef(WireTaggedModel):
    schema_version: Literal["agent-session-ref.v1"]
    backend: Literal["codex"]
    transport: Literal["sdk"]
    native_session_id: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    profile_key: Literal["codex-personal"]
    state_root_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    cwd_fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


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
        if self.phase == "completed" and self.succeeded is None:
            raise ValueError("completed tool use requires succeeded")
        if self.phase != "completed" and self.succeeded is not None:
            raise ValueError("succeeded is valid only for completed tool use")
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
        if self.operation == "tool_use" and self.tool_name is None:
            raise ValueError("tool_use permission request requires tool_name")
        if self.operation != "tool_use" and self.tool_name is not None:
            raise ValueError("tool_name is valid only for tool_use permission requests")
        return self


class GenerationNative(WireTaggedModel):
    kind: Literal["native"] = "native"
    native_type: Annotated[str, StringConstraints(min_length=1, max_length=128)]


AcceptedAt = Annotated[
    str,
    StringConstraints(
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$",
    ),
]


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
        try:
            parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as error:
            raise ValueError("admitted_at must be a real UTC RFC3339 instant") from error
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("admitted_at must be UTC")
        return value


Diagnostic = Annotated[str, StringConstraints(min_length=1, max_length=1_000)]


class GenerationTerminal(WireTaggedModel):
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


class GenerationFrame(WireTaggedModel):
    schema_version: Literal["nexus-generation-event.v2"] = EVENT_SCHEMA_VERSION
    request_id: UUID
    sequence: int = Field(ge=0)
    event: GenerationEvent


class GenerationHealth(WireTaggedModel):
    schema_version: Literal["nexus-generation-health.v2"] = HEALTH_SCHEMA_VERSION
    status: Literal["ready"] = "ready"
    backend: Literal["codex"] = "codex"
    transport: Literal["sdk"] = "sdk"
    auth_profile: Literal["codex-personal"] = "codex-personal"
    command_schema_version: Literal["nexus-generation-command.v3"] = COMMAND_SCHEMA_VERSION
    sdk_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    runtime_version: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class GenerationCapacityRejection(WireTaggedModel):
    schema_version: Literal["nexus-generation-rejection.v2"] = REJECTION_SCHEMA_VERSION
    kind: Literal["capacity_unavailable"] = "capacity_unavailable"


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
        return FAILURE_KIND_TO_NORMALIZED[kind]
    except KeyError as error:
        raise GenerationContractDefect(f"unknown host failure kind {kind!r}") from error


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


def codex_model_catalog_to_wire(catalog: AgentModelCatalog) -> CodexModelCatalog:
    """Translate the external AgentRuntime value at the private-host boundary."""

    return CodexModelCatalog(
        backend_contract_revision=catalog.backend_contract_revision,
        definition_revision=catalog.definition_revision,
        native_revision=_runtime_presence_to_wire(catalog.native_revision),
        observed_at=catalog.observed_at,
        models=tuple(_codex_model_to_wire(model) for model in catalog.models),
    )


def codex_model_catalog_from_wire(catalog: CodexModelCatalog) -> AgentModelCatalog:
    """Recover the public AgentRuntime value after strict private-wire decoding."""

    from provider_runtime.agent_runtime import AgentModelCatalog

    return AgentModelCatalog(
        backend_contract_revision=catalog.backend_contract_revision,
        definition_revision=catalog.definition_revision,
        native_revision=_wire_presence_to_runtime(catalog.native_revision),
        observed_at=catalog.observed_at,
        models=tuple(_codex_model_from_wire(model) for model in catalog.models),
        diagnostics=(),
    )


def _codex_model_to_wire(model: AgentModelFacts) -> CodexCatalogModel:
    upgrade: Absent | Present[CodexCatalogUpgrade]
    if isinstance(model.upgrade, RuntimePresent):
        upgrade = Present[CodexCatalogUpgrade](
            value=CodexCatalogUpgrade(target_key=model.upgrade.value.target_key)
        )
    else:
        upgrade = Absent()
    return CodexCatalogModel(
        key=model.key,
        dispatch_model=model.dispatch_model,
        label=model.label,
        source_context_window=_runtime_presence_to_wire(model.source_context_window),
        source_max_output_tokens=_runtime_presence_to_wire(model.source_max_output_tokens),
        input_modalities=model.input_modalities,
        reasoning=tuple(
            CodexCatalogReasoning(
                key=reasoning.key,
                label=reasoning.label,
                native_wire_value=reasoning.native_wire_value,
            )
            for reasoning in model.reasoning
        ),
        source_default_reasoning=_runtime_presence_to_wire(model.source_default_reasoning),
        upgrade=upgrade,
        retirement=Absent(),
        row_fingerprint=model.row_fingerprint,
    )


def _codex_model_from_wire(model: CodexCatalogModel) -> AgentModelFacts:
    from provider_runtime.agent_runtime import (
        AgentModelFacts,
        AgentReasoningFacts,
        AgentUpgradeFacts,
    )

    upgrade: RuntimeAbsent | RuntimePresent[AgentUpgradeFacts]
    if isinstance(model.upgrade, Present):
        upgrade = RuntimePresent(AgentUpgradeFacts(target_key=model.upgrade.value.target_key))
    else:
        upgrade = RuntimeAbsent()
    return AgentModelFacts(
        key=model.key,
        dispatch_model=model.dispatch_model,
        label=model.label,
        source_context_window=_wire_presence_to_runtime(model.source_context_window),
        source_max_output_tokens=_wire_presence_to_runtime(model.source_max_output_tokens),
        input_modalities=model.input_modalities,
        reasoning=tuple(
            AgentReasoningFacts(
                key=reasoning.key,
                label=reasoning.label,
                native_wire_value=reasoning.native_wire_value,
            )
            for reasoning in model.reasoning
        ),
        source_default_reasoning=_wire_presence_to_runtime(model.source_default_reasoning),
        upgrade=upgrade,
        retirement=RuntimeAbsent(),
        row_fingerprint=model.row_fingerprint,
    )


def _runtime_presence_to_wire[T](value: RuntimeAbsent | RuntimePresent[T]) -> Absent | Present[T]:
    if isinstance(value, RuntimeAbsent):
        return Absent()
    return Present[T](value=value.value)


def _wire_presence_to_runtime[T](value: Absent | Present[T]) -> RuntimeAbsent | RuntimePresent[T]:
    if isinstance(value, Absent):
        return RuntimeAbsent()
    return RuntimePresent(value.value)


def capacity_rejection_bytes() -> bytes:
    return b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}'


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json_bytes(value)).hexdigest()


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_output_contract(command: _GenerationCommandFacts) -> None:
    output = command.intent.output
    frozen = command.spec.output_contract
    if isinstance(output, TextOutput) and isinstance(frozen, TextOutputSnapshot):
        return
    if isinstance(output, JsonSchemaOutput) and isinstance(frozen, StrictJsonOutputSnapshot):
        if (output.name, output.schema_) == (frozen.name, frozen.json_schema):
            return
    raise ValueError("generation output differs from the frozen GenerationSpec")


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
        request_id=command.request_id,
        spec=command.spec,
        intent=command.intent,
    )


def generation_command_from_draft(
    draft: GenerationCommandDraft,
    *,
    tool_grant: BearerToolGrant | None,
) -> GenerationCommand:
    """Create the only dispatchable command after successful host admission."""

    return GenerationCommand(
        request_id=draft.request_id,
        spec=draft.spec,
        intent=draft.intent,
        tool_grant=tool_grant,
    )


def generation_admission_request(draft: GenerationCommandDraft) -> GenerationAdmissionRequest:
    """Project a grant-free draft onto its replay-stable admission identity."""

    plan = draft.spec.model_tool_plan_snapshot
    if isinstance(plan, Present):
        plan_fingerprint = _digest(plan.value.model_dump(mode="json"))
    elif isinstance(plan, Absent):
        plan_fingerprint = _digest(plan.model_dump(mode="json"))
    else:
        assert_never(plan)
    return GenerationAdmissionRequest(
        request_id=draft.request_id,
        generation_spec_fingerprint=draft.spec.fingerprint,
        request_fingerprint=generation_draft_fingerprint(draft),
        turn_timeout_seconds=draft.spec.bounds.turn_timeout_seconds,
        model_tool_plan_fingerprint=plan_fingerprint,
    )


__all__ = [
    "ADMISSION_SCHEMA_VERSION",
    "COMMAND_DRAFT_SCHEMA_VERSION",
    "COMMAND_SCHEMA_VERSION",
    "COMMAND_ENVELOPE_BYTES",
    "EVENT_SCHEMA_VERSION",
    "MODEL_CATALOG_SCHEMA_VERSION",
    "MAX_COMMAND_BODY_BYTES",
    "MAX_ADMISSION_BODY_BYTES",
    "MAX_OUTPUT_SCHEMA_BYTES",
    "MAX_MODEL_TOOL_PLAN_BYTES",
    "MAX_MODEL_CATALOG_BODY_BYTES",
    "MAX_TOOL_GRANT_BYTES",
    "FAILURE_KIND_TO_NORMALIZED",
    "NormalizedFailureCode",
    "GenerationCapacityRejection",
    "CodexModelCatalog",
    "GenerationAdmission",
    "GenerationAdmissionRequest",
    "GenerationCommand",
    "GenerationCommandDraft",
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
    "codex_model_catalog_from_wire",
    "codex_model_catalog_to_wire",
    "normalized_failure",
    "retained_terminal_error_detail",
    "generation_admission_request",
    "generation_command_draft",
    "generation_command_from_draft",
    "generation_draft_fingerprint",
]
