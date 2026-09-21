"""Exact developer-owned generation selections and workflow authority.

The policy names exact route-tagged selections and conservative Nexus request
budgets; catalog admission proves those facts are currently runnable. It holds
no tier, profile, fallback, or model-capacity table.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, is_dataclass
from types import MappingProxyType
from typing import Literal, cast, get_args

from pydantic import BaseModel

from nexus.schemas.presence import Absent, Present
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    CodexPersonalSelection,
    GenerationBounds,
    GenerationSelectionSpec,
    GenerationStreamBounds,
)
from nexus.services.tool_runtime.plan_revisions import (
    TOOL_PLAN_AUTHORITY_REVISIONS,
    tool_plan_authority_revision,
)

type EffectMode = Literal["ReadOnly", "AdditiveWrites"]
type OutputContract = Literal["Text", "StrictJson"]
type ToolScopeDerivation = Literal[
    "ChatAdmittedContext", "LibraryDossierManifest", "IdeaDossierEvidenceLedger", "MetadataMedia"
]


@dataclass(frozen=True, slots=True)
class RequestBudget:
    """Policy-owned maximum prompt context and reserved model output."""

    max_context_tokens: int
    max_output_tokens: int


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


@dataclass(frozen=True, slots=True)
class OperationWorkflowSpec:
    operation: str
    revision: str
    bounds: GenerationBounds
    request_budget: RequestBudget
    output_contract: OutputContract
    host_tool_plan: HostToolPlan
    model_tool_policy: ModelToolPolicy


@dataclass(frozen=True, slots=True)
class ChatPolicy:
    seed: GenerationSelectionSpec
    workflow: OperationWorkflowSpec


@dataclass(frozen=True, slots=True)
class BackgroundOperationPolicy:
    selection: GenerationSelectionSpec
    workflow: OperationWorkflowSpec


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    revision: str
    chat: ChatPolicy
    background_operations: Mapping[BackgroundOperationKey, BackgroundOperationPolicy]


_NO_HOST = NoHostToolPlan()
_NO_TOOLS = NoModelTools()
_SYNTHESIS_STREAM = GenerationStreamBounds(
    max_frames=1_024,
    max_frame_bytes=256 * 1024,
    max_stream_bytes=1024 * 1024,
    text_flush_interval_ms=Absent(),
    text_flush_bytes=Absent(),
)
_CHAT_STREAM = GenerationStreamBounds(
    max_frames=16_384,
    max_frame_bytes=8 * 1024 * 1024,
    max_stream_bytes=16 * 1024 * 1024,
    text_flush_interval_ms=Present[int](value=100),
    text_flush_bytes=Present[int](value=8 * 1024),
)


def _codex(model: str, reasoning: str) -> CodexPersonalSelection:
    return CodexPersonalSelection(route="CodexPersonal", model=model, reasoning=reasoning)


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
    stream: GenerationStreamBounds = _SYNTHESIS_STREAM,
) -> GenerationBounds:
    return GenerationBounds(
        instructions_max_bytes=32 * 1024,
        input_max_bytes=input_max_bytes,
        turn_timeout_seconds=turn_timeout_seconds,
        session_open_timeout_seconds=90,
        runtime_close_timeout_seconds=30,
        transport_margin_seconds=15,
        transport_deadline_seconds=90 + turn_timeout_seconds + 30 + 15,
        stream=stream,
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


def _workflow(
    operation: str,
    *,
    bounds: GenerationBounds,
    request_budget: RequestBudget,
    output_contract: OutputContract,
    host_tool_plan: HostToolPlan = _NO_HOST,
    model_tool_policy: ModelToolPolicy = _NO_TOOLS,
) -> OperationWorkflowSpec:
    facts = {
        "operation": operation,
        "bounds": _canonical_value(bounds),
        "request_budget": _canonical_value(request_budget),
        "output_contract": output_contract,
        "host_tool_plan": _canonical_value(host_tool_plan),
        "model_tool_policy": _canonical_value(model_tool_policy),
    }
    digest = hashlib.sha256(b"nexus.operation-workflow.v2\0" + _canonical(facts)).hexdigest()
    return OperationWorkflowSpec(
        operation=operation,
        revision=f"operation-workflow.v2.{digest}",
        bounds=bounds,
        request_budget=request_budget,
        output_contract=output_contract,
        host_tool_plan=host_tool_plan,
        model_tool_policy=model_tool_policy,
    )


_METADATA_TOOLS = ExactModelTools(
    "MetadataRead", _tool_authority_revision("MetadataRead"), "ReadOnly", "MetadataMedia"
)
_LIBRARY_TOOLS = ExactModelTools(
    "LibraryDossierRead",
    _tool_authority_revision("LibraryDossierRead"),
    "ReadOnly",
    "LibraryDossierManifest",
)
_IDEA_TOOLS = ExactModelTools(
    "IdeaDossierRead",
    _tool_authority_revision("IdeaDossierRead"),
    "ReadOnly",
    "IdeaDossierEvidenceLedger",
)
_IDEA_HOST_PLAN = ExactHostToolPlan(
    "idea_dossier_research", _tool_authority_revision("idea_dossier_research")
)

# operation, model, reasoning, turn timeout s, input KiB, context tokens,
# output tokens, host-tool plan, model-tool policy. Every background operation
# is strict JSON over Codex Personal.
_BACKGROUND_ROWS: tuple[
    tuple[BackgroundOperationKey, str, str, int, int, int, int, HostToolPlan, ModelToolPolicy], ...
] = (
    ("metadata_enrichment", "luna", "low", 300, 32, 64_000, 8_000, _NO_HOST, _METADATA_TOOLS),
    ("media_summary", "luna", "low", 120, 256, 128_000, 16_000, _NO_HOST, _NO_TOOLS),
    ("synapse", "luna", "low", 120, 256, 128_000, 16_000, _NO_HOST, _NO_TOOLS),
    ("oracle", "terra", "medium", 180, 256, 128_000, 16_000, _NO_HOST, _NO_TOOLS),
    ("dossier_page", "luna", "low", 120, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_note", "luna", "low", 120, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_media", "terra", "medium", 180, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_conversation", "terra", "medium", 180, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_library", "terra", "high", 300, 1024, 400_000, 32_000, _NO_HOST, _LIBRARY_TOOLS),
    ("dossier_podcast", "terra", "high", 300, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_contributor", "terra", "high", 300, 1024, 400_000, 32_000, _NO_HOST, _NO_TOOLS),
    ("dossier_idea", "terra", "high", 300, 1024, 400_000, 32_000, _IDEA_HOST_PLAN, _IDEA_TOOLS),
    ("dossier_idea_resolve", "luna", "low", 60, 256, 128_000, 16_000, _NO_HOST, _NO_TOOLS),
)
_BACKGROUND_OPERATIONS: dict[BackgroundOperationKey, BackgroundOperationPolicy] = {
    operation: BackgroundOperationPolicy(
        selection=_codex(f"gpt-5.6-{model}", reasoning),
        workflow=_workflow(
            operation,
            bounds=_bounds(input_max_bytes=input_kib * 1024, turn_timeout_seconds=timeout),
            request_budget=RequestBudget(
                max_context_tokens=context_tokens, max_output_tokens=output_tokens
            ),
            output_contract="StrictJson",
            host_tool_plan=host_plan,
            model_tool_policy=model_tools,
        ),
    )
    for (
        operation,
        model,
        reasoning,
        timeout,
        input_kib,
        context_tokens,
        output_tokens,
        host_plan,
        model_tools,
    ) in _BACKGROUND_ROWS
}

_CHAT = ChatPolicy(
    seed=_codex("gpt-5.6-terra", "medium"),
    workflow=_workflow(
        "chat",
        bounds=_bounds(input_max_bytes=512 * 1024, turn_timeout_seconds=900, stream=_CHAT_STREAM),
        request_budget=RequestBudget(max_context_tokens=400_000, max_output_tokens=32_000),
        output_contract="Text",
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
_IMMUTABLE_BACKGROUND_OPERATIONS = MappingProxyType(_BACKGROUND_OPERATIONS)
_POLICY_DIGEST = hashlib.sha256(
    b"nexus.generation-policy.v2\0"
    + _canonical({"chat": _CHAT, "background_operations": _IMMUTABLE_BACKGROUND_OPERATIONS})
).hexdigest()
GENERATION_POLICY = GenerationPolicy(
    revision=f"generation-policy.v2.{_POLICY_DIGEST}",
    chat=_CHAT,
    background_operations=_IMMUTABLE_BACKGROUND_OPERATIONS,
)
# A durable capacity pause rechecks at this low-frequency fallback only when the
# provider supplies no reset instant. It is not an ordinary generation retry.
BACKGROUND_CAPACITY_PROBE_SECONDS = 15 * 60
MODEL_TOOL_ADMISSION_RUNTIME_SECONDS = max(
    workflow.bounds.turn_timeout_seconds
    for workflow in (
        GENERATION_POLICY.chat.workflow,
        *(entry.workflow for entry in GENERATION_POLICY.background_operations.values()),
    )
    if not isinstance(workflow.model_tool_policy, NoModelTools)
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
    # Executable tool definitions load only during full process composition;
    # domain workers import policy facts without materialising the tool runtime.
    from nexus.services.tool_runtime.plans import TOOL_PLAN_DEFINITIONS_BY_ID

    expected = set(get_args(BackgroundOperationKey.__value__))
    if set(GENERATION_POLICY.background_operations) != expected:
        raise AssertionError("background operation policy is not exact and total")
    if not isinstance(GENERATION_POLICY.chat.workflow.model_tool_policy, ChatPerRunTools):
        raise AssertionError("Chat must own per-run read and additive-write plans")
    for plan_id, revision in TOOL_PLAN_AUTHORITY_REVISIONS.items():
        if TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].authority_revision != revision:
            raise AssertionError(f"reviewed tool plan {plan_id!r} authority drifted")
