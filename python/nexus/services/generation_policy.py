"""Exact developer-owned generation selections and workflow authority.

The policy is deliberately model-catalog agnostic: it names exact route-tagged
selections and conservative Nexus request budgets, while catalog admission
proves that those facts are currently runnable. It contains no tier, profile,
fallback, or model-capacity table.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, is_dataclass
from types import MappingProxyType
from typing import Literal, cast

from pydantic import BaseModel

from nexus.services.generation_selection import (
    CodexPersonalSelection,
    ProviderApiSelection,
)
from nexus.services.generation_spec import BackgroundOperationKey
from nexus.services.tool_runtime.authority import tool_plan_authority_revision

type GenerationSelection = CodexPersonalSelection | ProviderApiSelection
type EffectMode = Literal["ReadOnly", "AdditiveWrites"]
type ToolScopeDerivation = Literal[
    "ChatAdmittedContext",
    "LibraryDossierManifest",
    "IdeaDossierEvidenceLedger",
    "MetadataMedia",
]


@dataclass(frozen=True, slots=True)
class RequestBudget:
    """Policy-owned maximum prompt context and reserved model output."""

    max_context_tokens: int
    max_output_tokens: int


@dataclass(frozen=True, slots=True)
class StreamBounds:
    max_frames: int
    max_frame_bytes: int
    max_stream_bytes: int
    text_flush_interval_ms: int | None = None
    text_flush_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class OperationBounds:
    instructions_max_bytes: int
    input_max_bytes: int
    turn_timeout_seconds: int
    stream: StreamBounds
    session_open_timeout_seconds: int = 90
    runtime_close_timeout_seconds: int = 30
    transport_margin_seconds: int = 15
    transport_deadline_seconds: int = 0


@dataclass(frozen=True, slots=True)
class TextOutputContract:
    kind: Literal["Text"] = "Text"


@dataclass(frozen=True, slots=True)
class StrictJsonOutputContract:
    kind: Literal["StrictJson"] = "StrictJson"


type OutputContract = TextOutputContract | StrictJsonOutputContract


@dataclass(frozen=True, slots=True)
class NoHostToolPlan:
    kind: Literal["NoHostToolPlan"] = "NoHostToolPlan"


@dataclass(frozen=True, slots=True)
class ExactHostToolPlan:
    plan_id: str
    authority_revision: str
    kind: Literal["ExactHostToolPlan"] = "ExactHostToolPlan"


type HostToolPlan = NoHostToolPlan | ExactHostToolPlan


@dataclass(frozen=True, slots=True)
class NoModelTools:
    kind: Literal["NoModelTools"] = "NoModelTools"


@dataclass(frozen=True, slots=True)
class ExactModelTools:
    plan_id: str
    authority_revision: str
    effect_mode: EffectMode
    scope_derivation: ToolScopeDerivation
    kind: Literal["ExactModelTools"] = "ExactModelTools"


@dataclass(frozen=True, slots=True)
class ChatPerRunTools:
    read_plan_id: str
    read_plan_authority_revision: str
    additive_write_plan_id: str
    additive_write_plan_authority_revision: str
    scope_derivation: Literal["ChatAdmittedContext"]
    kind: Literal["ChatPerRunTools"] = "ChatPerRunTools"


type ModelToolPolicy = NoModelTools | ExactModelTools | ChatPerRunTools

_NO_HOST_TOOL_PLAN = NoHostToolPlan()
_NO_MODEL_TOOLS = NoModelTools()
_STRICT_JSON_OUTPUT = StrictJsonOutputContract()


@dataclass(frozen=True, slots=True)
class OperationWorkflowSpec:
    operation: str
    revision: str
    bounds: OperationBounds
    request_budget: RequestBudget
    output_contract: OutputContract
    host_tool_plan: HostToolPlan
    model_tool_policy: ModelToolPolicy


@dataclass(frozen=True, slots=True)
class ChatPolicy:
    seed: GenerationSelection
    workflow: OperationWorkflowSpec


@dataclass(frozen=True, slots=True)
class BackgroundOperationPolicy:
    selection: GenerationSelection
    workflow: OperationWorkflowSpec


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    revision: str
    chat: ChatPolicy
    background_operations: Mapping[BackgroundOperationKey, BackgroundOperationPolicy]


_SYNTHESIS_STREAM = StreamBounds(
    max_frames=1_024,
    max_frame_bytes=256 * 1024,
    max_stream_bytes=1024 * 1024,
)
_CHAT_STREAM = StreamBounds(
    max_frames=16_384,
    max_frame_bytes=8 * 1024 * 1024,
    max_stream_bytes=16 * 1024 * 1024,
    text_flush_interval_ms=100,
    text_flush_bytes=8 * 1024,
)


def _codex(model: str, reasoning: str) -> CodexPersonalSelection:
    return CodexPersonalSelection(
        route="CodexPersonal",
        model=model,
        reasoning=reasoning,
    )


def _tool_authority_revision(plan_id: str) -> str:
    try:
        return tool_plan_authority_revision(plan_id)
    except ValueError as error:
        raise AssertionError(
            f"generation policy references unknown tool plan {plan_id!r}"
        ) from error


def _bounds(
    *,
    input_max_bytes: int,
    turn_timeout_seconds: int,
    stream: StreamBounds = _SYNTHESIS_STREAM,
) -> OperationBounds:
    return OperationBounds(
        instructions_max_bytes=32 * 1024,
        input_max_bytes=input_max_bytes,
        turn_timeout_seconds=turn_timeout_seconds,
        stream=stream,
        transport_deadline_seconds=90 + turn_timeout_seconds + 30 + 15,
    )


def _canonical_value(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if is_dataclass(value) and not isinstance(value, type):
        return {key: _canonical_value(child) for key, child in asdict(value).items()}
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(child) for key, child in value.items()}
    if isinstance(value, tuple | list):
        return [_canonical_value(child) for child in value]
    return value


def _canonical(value: object) -> bytes:
    return json.dumps(
        _canonical_value(value),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _workflow_revision(facts: Mapping[str, object]) -> str:
    digest = hashlib.sha256(b"nexus.operation-workflow.v2\0" + _canonical(facts)).hexdigest()
    return f"operation-workflow.v2.{digest}"


def _workflow(
    operation: str,
    *,
    bounds: OperationBounds,
    request_budget: RequestBudget,
    output_contract: OutputContract,
    host_tool_plan: HostToolPlan = _NO_HOST_TOOL_PLAN,
    model_tool_policy: ModelToolPolicy = _NO_MODEL_TOOLS,
) -> OperationWorkflowSpec:
    facts = {
        "operation": operation,
        "bounds": _canonical_value(bounds),
        "request_budget": _canonical_value(request_budget),
        "output_contract": _canonical_value(output_contract),
        "host_tool_plan": _canonical_value(host_tool_plan),
        "model_tool_policy": _canonical_value(model_tool_policy),
    }
    return OperationWorkflowSpec(
        operation=operation,
        revision=_workflow_revision(facts),
        bounds=bounds,
        request_budget=request_budget,
        output_contract=output_contract,
        host_tool_plan=host_tool_plan,
        model_tool_policy=model_tool_policy,
    )


def _background(
    operation: BackgroundOperationKey,
    *,
    model: str,
    reasoning: str,
    timeout: int,
    input_bytes: int,
    context_tokens: int,
    output_tokens: int,
    output_contract: OutputContract = _STRICT_JSON_OUTPUT,
    host_tool_plan: HostToolPlan = _NO_HOST_TOOL_PLAN,
    model_tool_policy: ModelToolPolicy = _NO_MODEL_TOOLS,
) -> BackgroundOperationPolicy:
    return BackgroundOperationPolicy(
        selection=_codex(model, reasoning),
        workflow=_workflow(
            operation,
            bounds=_bounds(
                input_max_bytes=input_bytes,
                turn_timeout_seconds=timeout,
            ),
            request_budget=RequestBudget(
                max_context_tokens=context_tokens,
                max_output_tokens=output_tokens,
            ),
            output_contract=output_contract,
            host_tool_plan=host_tool_plan,
            model_tool_policy=model_tool_policy,
        ),
    )


_BACKGROUND_OPERATIONS: dict[BackgroundOperationKey, BackgroundOperationPolicy] = {
    "metadata_enrichment": _background(
        "metadata_enrichment",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=300,
        input_bytes=32 * 1024,
        context_tokens=64_000,
        output_tokens=8_000,
        model_tool_policy=ExactModelTools(
            plan_id="MetadataRead",
            authority_revision=_tool_authority_revision("MetadataRead"),
            effect_mode="ReadOnly",
            scope_derivation="MetadataMedia",
        ),
    ),
    "media_summary": _background(
        "media_summary",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=120,
        input_bytes=256 * 1024,
        context_tokens=128_000,
        output_tokens=16_000,
    ),
    "synapse": _background(
        "synapse",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=120,
        input_bytes=256 * 1024,
        context_tokens=128_000,
        output_tokens=16_000,
    ),
    "dawn_write": _background(
        "dawn_write",
        model="gpt-5.6-terra",
        reasoning="medium",
        timeout=180,
        input_bytes=256 * 1024,
        context_tokens=128_000,
        output_tokens=16_000,
        output_contract=TextOutputContract(),
    ),
    "oracle": _background(
        "oracle",
        model="gpt-5.6-terra",
        reasoning="medium",
        timeout=180,
        input_bytes=256 * 1024,
        context_tokens=128_000,
        output_tokens=16_000,
    ),
    "dossier_page": _background(
        "dossier_page",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=120,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_note": _background(
        "dossier_note",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=120,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_media": _background(
        "dossier_media",
        model="gpt-5.6-terra",
        reasoning="medium",
        timeout=180,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_conversation": _background(
        "dossier_conversation",
        model="gpt-5.6-terra",
        reasoning="medium",
        timeout=180,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_library": _background(
        "dossier_library",
        model="gpt-5.6-terra",
        reasoning="high",
        timeout=300,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
        model_tool_policy=ExactModelTools(
            plan_id="LibraryDossierRead",
            authority_revision=_tool_authority_revision("LibraryDossierRead"),
            effect_mode="ReadOnly",
            scope_derivation="LibraryDossierManifest",
        ),
    ),
    "dossier_podcast": _background(
        "dossier_podcast",
        model="gpt-5.6-terra",
        reasoning="high",
        timeout=300,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_contributor": _background(
        "dossier_contributor",
        model="gpt-5.6-terra",
        reasoning="high",
        timeout=300,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
    ),
    "dossier_idea": _background(
        "dossier_idea",
        model="gpt-5.6-terra",
        reasoning="high",
        timeout=300,
        input_bytes=1024 * 1024,
        context_tokens=400_000,
        output_tokens=32_000,
        host_tool_plan=ExactHostToolPlan(
            plan_id="idea_dossier_research",
            authority_revision=_tool_authority_revision("idea_dossier_research"),
        ),
        model_tool_policy=ExactModelTools(
            plan_id="IdeaDossierRead",
            authority_revision=_tool_authority_revision("IdeaDossierRead"),
            effect_mode="ReadOnly",
            scope_derivation="IdeaDossierEvidenceLedger",
        ),
    ),
    "dossier_idea_resolve": _background(
        "dossier_idea_resolve",
        model="gpt-5.6-luna",
        reasoning="low",
        timeout=60,
        input_bytes=256 * 1024,
        context_tokens=128_000,
        output_tokens=16_000,
    ),
}

_CHAT = ChatPolicy(
    seed=_codex("gpt-5.6-terra", "medium"),
    workflow=_workflow(
        "chat",
        bounds=_bounds(
            input_max_bytes=512 * 1024,
            turn_timeout_seconds=900,
            stream=_CHAT_STREAM,
        ),
        request_budget=RequestBudget(
            max_context_tokens=400_000,
            max_output_tokens=32_000,
        ),
        output_contract=TextOutputContract(),
        model_tool_policy=ChatPerRunTools(
            read_plan_id="ChatRead",
            read_plan_authority_revision=_tool_authority_revision("ChatRead"),
            additive_write_plan_id="ChatReadAdditiveWrite",
            additive_write_plan_authority_revision=_tool_authority_revision(
                "ChatReadAdditiveWrite"
            ),
            scope_derivation="ChatAdmittedContext",
        ),
    ),
)


def _policy_facts(
    *,
    chat: ChatPolicy,
    background_operations: Mapping[BackgroundOperationKey, BackgroundOperationPolicy],
) -> dict[str, object]:
    return cast(
        dict[str, object],
        _canonical_value(
            {
                "chat": chat,
                "background_operations": background_operations,
            }
        ),
    )


def policy_revision_from_facts(facts: Mapping[str, object]) -> str:
    digest = hashlib.sha256(b"nexus.generation-policy.v2\0" + _canonical(facts)).hexdigest()
    return f"generation-policy.v2.{digest}"


_IMMUTABLE_BACKGROUND_OPERATIONS = MappingProxyType(_BACKGROUND_OPERATIONS)
_INITIAL_POLICY_FACTS = _policy_facts(
    chat=_CHAT,
    background_operations=_IMMUTABLE_BACKGROUND_OPERATIONS,
)
GENERATION_POLICY = GenerationPolicy(
    revision=policy_revision_from_facts(_INITIAL_POLICY_FACTS),
    chat=_CHAT,
    background_operations=_IMMUTABLE_BACKGROUND_OPERATIONS,
)
POLICY_REVISION = GENERATION_POLICY.revision
POLICY_FINGERPRINT = hashlib.sha256(
    b"nexus.generation-policy-envelope.v2\0" + _canonical(_INITIAL_POLICY_FACTS)
).hexdigest()

# Durable capacity pauses recheck at a low-frequency fallback only when the
# provider supplies no reset instant. They are not ordinary generation retries.
BACKGROUND_CAPACITY_PROBE_SECONDS = 15 * 60

# This is a route-independent serialized-state allocation, not a model capacity
# claim. It bounds private Codex rollout files while leaving SDK bookkeeping
# headroom beyond the public event-stream ceiling.
CODEX_RUNTIME_STATE_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
_CODEX_STATE_SERIALIZATION_OVERHEAD_BYTES = 8 * 1024 * 1024
_CODEX_STATE_ROOT_FIXED_HEADROOM_BYTES = 32 * 1024 * 1024


def _round_up_mib(value: int) -> int:
    mib = 1024 * 1024
    return ((value + mib - 1) // mib) * mib


_ALL_WORKFLOWS = (
    GENERATION_POLICY.chat.workflow,
    *(entry.workflow for entry in GENERATION_POLICY.background_operations.values()),
)
CODEX_EPHEMERAL_FILE_LIMIT_BYTES = _round_up_mib(
    CODEX_RUNTIME_STATE_OUTPUT_LIMIT_BYTES
    + max(workflow.bounds.input_max_bytes for workflow in _ALL_WORKFLOWS)
    + max(workflow.bounds.instructions_max_bytes for workflow in _ALL_WORKFLOWS)
    + _CODEX_STATE_SERIALIZATION_OVERHEAD_BYTES
)
CODEX_EPHEMERAL_ROOT_BYTES = (
    2 * CODEX_EPHEMERAL_FILE_LIMIT_BYTES + _CODEX_STATE_ROOT_FIXED_HEADROOM_BYTES
)
MODEL_TOOL_ADMISSION_RUNTIME_SECONDS = max(
    workflow.bounds.turn_timeout_seconds
    for workflow in _ALL_WORKFLOWS
    if not isinstance(workflow.model_tool_policy, NoModelTools)
)


def policy_facts() -> dict[str, object]:
    """Return a fresh canonical facts tree suitable for audit and evaluation."""

    return _policy_facts(
        chat=GENERATION_POLICY.chat,
        background_operations=GENERATION_POLICY.background_operations,
    )


def background_operation_policy(operation: str) -> BackgroundOperationPolicy:
    try:
        return GENERATION_POLICY.background_operations[cast(BackgroundOperationKey, operation)]
    except KeyError as error:
        raise ValueError(f"unknown background generation operation {operation!r}") from error


def workflow_for_operation(operation: str) -> OperationWorkflowSpec:
    if operation == "chat":
        return GENERATION_POLICY.chat.workflow
    return background_operation_policy(operation).workflow


def operation_revision(operation: str) -> str:
    return workflow_for_operation(operation).revision


def validate_policy() -> None:
    # Load executable tool definitions only while validating complete process
    # composition. Domain workers may import policy facts without loading tools.
    from nexus.services.tool_runtime.profiles import tool_plan_policy_facts

    expected_operations = (
        "metadata_enrichment",
        "media_summary",
        "synapse",
        "dawn_write",
        "oracle",
        "dossier_page",
        "dossier_note",
        "dossier_media",
        "dossier_conversation",
        "dossier_library",
        "dossier_podcast",
        "dossier_contributor",
        "dossier_idea",
        "dossier_idea_resolve",
    )
    if tuple(GENERATION_POLICY.background_operations) != expected_operations:
        raise AssertionError("background operation policy is not exact and total")
    if policy_revision_from_facts(policy_facts()) != GENERATION_POLICY.revision:
        raise AssertionError("generation policy revision is not its content digest")
    if GENERATION_POLICY.chat.seed != _codex("gpt-5.6-terra", "medium"):
        raise AssertionError("Chat seed drifted")
    for operation, entry in GENERATION_POLICY.background_operations.items():
        workflow = entry.workflow
        if workflow.operation != operation:
            raise AssertionError(f"{operation} workflow identity drifted")
        if workflow.revision != _workflow_revision(
            {
                "operation": workflow.operation,
                "bounds": _canonical_value(workflow.bounds),
                "request_budget": _canonical_value(workflow.request_budget),
                "output_contract": _canonical_value(workflow.output_contract),
                "host_tool_plan": _canonical_value(workflow.host_tool_plan),
                "model_tool_policy": _canonical_value(workflow.model_tool_policy),
            }
        ):
            raise AssertionError(f"{operation} workflow revision drifted")
        if not isinstance(entry.selection, CodexPersonalSelection):
            raise AssertionError(f"{operation} must ship through Codex Personal")
        if workflow.request_budget.max_context_tokens <= 0:
            raise AssertionError(f"{operation} context budget must be positive")
        if workflow.request_budget.max_output_tokens <= 0:
            raise AssertionError(f"{operation} output budget must be positive")
        bounds = workflow.bounds
        if bounds.transport_deadline_seconds != (
            bounds.session_open_timeout_seconds
            + bounds.turn_timeout_seconds
            + bounds.runtime_close_timeout_seconds
            + bounds.transport_margin_seconds
        ):
            raise AssertionError(f"{operation} transport deadline drifted")
        if isinstance(workflow.model_tool_policy, ExactModelTools):
            if workflow.model_tool_policy.effect_mode != "ReadOnly":
                raise AssertionError(f"{operation} background tools must be read-only")
    if not isinstance(GENERATION_POLICY.chat.workflow.model_tool_policy, ChatPerRunTools):
        raise AssertionError("Chat must own per-run read and additive-write plans")
    referenced_model_plans = {
        GENERATION_POLICY.chat.workflow.model_tool_policy.read_plan_id: (
            GENERATION_POLICY.chat.workflow.model_tool_policy.read_plan_authority_revision
        ),
        GENERATION_POLICY.chat.workflow.model_tool_policy.additive_write_plan_id: (
            GENERATION_POLICY.chat.workflow.model_tool_policy.additive_write_plan_authority_revision
        ),
        **{
            workflow.model_tool_policy.plan_id: workflow.model_tool_policy.authority_revision
            for workflow in (
                entry.workflow for entry in GENERATION_POLICY.background_operations.values()
            )
            if isinstance(workflow.model_tool_policy, ExactModelTools)
        },
    }
    current_model_plans = {
        facts.plan_id: facts.authority_revision for facts in tool_plan_policy_facts()
    }
    if referenced_model_plans != current_model_plans:
        raise AssertionError("generation policy model-tool authority drifted")
    idea_host = GENERATION_POLICY.background_operations["dossier_idea"].workflow.host_tool_plan
    if not isinstance(idea_host, ExactHostToolPlan) or idea_host.authority_revision != (
        _tool_authority_revision(idea_host.plan_id)
    ):
        raise AssertionError("Idea Dossier host-tool authority drifted")
    if MODEL_TOOL_ADMISSION_RUNTIME_SECONDS != 900:
        raise AssertionError("model-tool admission runtime must remain bounded to 900 seconds")
    if CODEX_EPHEMERAL_FILE_LIMIT_BYTES != 74 * 1024 * 1024:
        raise AssertionError("Codex serialized-state file allocation drifted")
    if CODEX_EPHEMERAL_ROOT_BYTES != 180 * 1024 * 1024:
        raise AssertionError("Codex serialized-state root allocation drifted")


__all__ = [
    "BACKGROUND_CAPACITY_PROBE_SECONDS",
    "CODEX_EPHEMERAL_FILE_LIMIT_BYTES",
    "CODEX_EPHEMERAL_ROOT_BYTES",
    "CODEX_RUNTIME_STATE_OUTPUT_LIMIT_BYTES",
    "GENERATION_POLICY",
    "MODEL_TOOL_ADMISSION_RUNTIME_SECONDS",
    "POLICY_FINGERPRINT",
    "POLICY_REVISION",
    "BackgroundOperationPolicy",
    "ChatPerRunTools",
    "ChatPolicy",
    "EffectMode",
    "ExactHostToolPlan",
    "ExactModelTools",
    "GenerationPolicy",
    "HostToolPlan",
    "ModelToolPolicy",
    "NoHostToolPlan",
    "NoModelTools",
    "OperationBounds",
    "OperationWorkflowSpec",
    "OutputContract",
    "RequestBudget",
    "StreamBounds",
    "StrictJsonOutputContract",
    "TextOutputContract",
    "ToolScopeDerivation",
    "background_operation_policy",
    "operation_revision",
    "policy_facts",
    "policy_revision_from_facts",
    "validate_policy",
    "workflow_for_operation",
]
