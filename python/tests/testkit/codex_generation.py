"""Valid frozen Codex command fixtures for transport-boundary proofs."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid5

from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    HandlerSuccess,
    Native,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
)
from pydantic import SecretStr
from sqlalchemy.orm import Session

from nexus.schemas.llm import (
    PrivacyDisclosure,
    ProcessorChain,
    SelectionPresentation,
    SubscriptionBilling,
)
from nexus.schemas.presence import Absent, Present
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationCommand,
    GenerationCommandDraft,
    generation_command_from_draft,
    generation_draft_fingerprint,
)
from nexus.services.codex_generation_operations import CodexModelToolPlanRegistry
from nexus.services.generation_backend import (
    BackendGenerationRequest,
    CodexAdmissionBinder,
    CodexGenerationTransport,
    GenerationBackend,
    GenerationBackendComposition,
    PreparedCodexChild,
    ProviderGenerationTransport,
)
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_intent import (
    BearerToolGrant,
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
)
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    FrozenToolScope,
    GenerationBounds,
    GenerationOperation,
    GenerationSpec,
    GenerationSpecFacts,
    GenerationStreamBounds,
    ImmutablePromptPayloadRef,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
    generation_fact_digest,
    tool_scope_digest,
)
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    ModelTurnStart,
    arm_model_turn_dispatch_in_current_transaction,
    generation_spec_document,
    start_generation_in_current_transaction,
    start_model_turn_in_current_transaction,
)
from nexus.services.tool_runtime.composition import ComposedToolRuntime, compose_tool_runtime
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot
from tests.testkit.generation_catalog import configured_chat_catalog_service


@dataclass(frozen=True, slots=True)
class _CodexProjection:
    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild:
        return PreparedCodexChild(
            draft=GenerationCommandDraft(
                request_id=request.generation_id,
                spec=request.spec,
                intent=request.intent,
            )
        )


class _UnusedProvider:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"Codex-only proof used ProviderApi member {name!r}")


class _NoProviderTools:
    def resolve(self, _spec: GenerationSpec) -> None:
        return None


def compose_codex_execution_runtime(
    transport: CodexGenerationTransport,
    *,
    tools: ComposedToolRuntime,
    catalog: GenerationCatalogService | None = None,
) -> ComposedExecutionRuntime:
    """Compose the real route-neutral runtime around a fail-loud Codex peer."""

    return ComposedExecutionRuntime(
        backend=GenerationBackend(
            GenerationBackendComposition(
                codex=transport,
                provider=cast(ProviderGenerationTransport, _UnusedProvider()),
                codex_projection=_CodexProjection(),
                provider_tools=_NoProviderTools(),
            )
        ),
        continuation_cipher=GenerationContinuationCipher(b"c" * 32),
        admission=GenerationService(
            catalog=catalog or configured_chat_catalog_service(),
            policy=generation_policy.GENERATION_POLICY,
            tools=tools,
        ),
    )


async def bind_test_codex_admission(
    draft: GenerationCommandDraft,
    binder: CodexAdmissionBinder,
) -> GenerationCommand:
    """Reserve one deterministic test slot and cross the durable binder once."""

    return await binder(
        GenerationAdmission(
            request_id=draft.request_id,
            admission_id=uuid5(
                NAMESPACE_URL,
                f"nexus-test-codex-admission:{generation_draft_fingerprint(draft)}",
            ),
            admitted_at="2026-08-24T12:34:56.123456Z",
            runtime_deadline_seconds=draft.spec.bounds.turn_timeout_seconds,
        )
    )


async def _unused_handler(
    _value: object,
    _context: object,
) -> HandlerSuccess[dict[str, object]]:
    return HandlerSuccess(value={}, actual_attempts=0)


def _binding(
    spec: Any,
    *,
    replay_policy: ReplayPolicy,
) -> ToolBinding[Any, Any, Any]:
    return ToolBinding(
        spec=spec,
        execute=Available(_unused_handler),
        replay_policy=replay_policy,
        implementation_revision="codex_generation.v1",
        policy_epoch=PolicyEpoch("codex-transport-proof-v1"),
        policy_inputs={"owner": "codex-transport-proof"},
    )


def codex_model_tool_fixture() -> tuple[CodexModelToolPlanRegistry, ComposedToolRuntime]:
    """Compose available deterministic bindings for transport-only proofs."""

    runtime = compose_tool_runtime(
        _binding(WEB_SEARCH_SPEC, replay_policy=ReplayPolicy.BilledOnce),
        nexus_bindings=tuple(
            _binding(entry.spec, replay_policy=ReplayPolicy.ReDispatchable)
            for entry in NEXUS_TOOL_DECLARATIONS
        ),
    )
    native = tuple(
        operation
        for operation in runtime.operations.values()
        if isinstance(operation.plan.exposure, Native)
    )
    return CodexModelToolPlanRegistry(native), runtime


def codex_generation_draft(
    *,
    request_id: UUID,
    operation: GenerationOperation,
    instructions: str,
    input_text: str,
    model: str,
    reasoning: str,
    turn_timeout_seconds: int,
    structured_schema: dict[str, object] | None = None,
    model_tool_plan: FrozenToolPlanSnapshot | None = None,
) -> GenerationCommandDraft:
    if structured_schema is None:
        intent_output = TextOutput()
        output_contract = TextOutputSnapshot()
    else:
        intent_output = JsonSchemaOutput(
            name="answer",
            schema=structured_schema,
            strict=True,
        )
        output_contract = StrictJsonOutputSnapshot(
            name="answer",
            schema=structured_schema,
        )
    intent = GenerationIntent(
        instructions=instructions,
        input=input_text,
        output=intent_output,
    )
    if model_tool_plan is None:
        plan = Absent()
        effect_mode = Absent()
        scope = Absent()
        scope_digest = Absent()
    else:
        plan = Present(value=model_tool_plan)
        effect_mode = Present(
            value="ReadOnly" if model_tool_plan.max_live_writes is None else "AdditiveWrites"
        )
        scope_value = FrozenToolScope(admitted_refs=(), predicates=())
        scope = Present(value=scope_value)
        scope_digest = Present(value=tool_scope_digest(scope_value))
    is_chat = operation == "chat"
    stream = (
        GenerationStreamBounds(
            max_frames=16_384,
            max_frame_bytes=8 * 1024 * 1024,
            max_stream_bytes=16 * 1024 * 1024,
            text_flush_interval_ms=Present(value=100),
            text_flush_bytes=Present(value=8 * 1024),
        )
        if is_chat
        else GenerationStreamBounds(
            max_frames=1_024,
            max_frame_bytes=256 * 1024,
            max_stream_bytes=1024 * 1024,
            text_flush_interval_ms=Absent(),
            text_flush_bytes=Absent(),
        )
    )
    spec = GenerationSpec.freeze(
        GenerationSpecFacts(
            operation=operation,
            selection=CodexPersonalSelection(
                route="CodexPersonal",
                model=model,
                reasoning=reasoning,
            ),
            selection_source="ChatRun" if is_chat else "BackgroundPolicy",
            resolved_dispatch_target=CodexDispatchTargetSnapshot(
                model_key=model,
                dispatch_model=model,
                agent_definition_revision="2" * 64,
            ),
            source_catalog_definition_revision="2" * 64,
            source_row_fingerprint="1" * 64,
            agent_definition_revision=Present(value="2" * 64),
            source_context_window=Absent(),
            source_max_output_tokens=Absent(),
            effective_context_budget_tokens=400_000 if is_chat else 64_000,
            effective_output_budget_tokens=32_000 if is_chat else 8_000,
            bounds=GenerationBounds(
                instructions_max_bytes=32 * 1024,
                input_max_bytes=512 * 1024 if is_chat else 1024 * 1024,
                turn_timeout_seconds=turn_timeout_seconds,
                session_open_timeout_seconds=90,
                runtime_close_timeout_seconds=30,
                transport_margin_seconds=15,
                transport_deadline_seconds=turn_timeout_seconds + 135,
                stream=stream,
            ),
            prompt_template_revision="codex-transport-proof.prompt.v1",
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="CodexTransportProof",
                owner_id=str(request_id),
                revision="v1",
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            instructions_digest=hashlib.sha256(intent.instructions.encode()).hexdigest(),
            input_digest=hashlib.sha256(intent.input.encode()).hexdigest(),
            output_contract=output_contract,
            output_contract_fingerprint=generation_fact_digest(
                output_contract.model_dump(mode="json", by_alias=True)
            ),
            display_at_dispatch=SelectionPresentation(
                route_label="Codex Personal",
                model_label=model,
                reasoning_label=reasoning,
                billing=SubscriptionBilling(),
                privacy=PrivacyDisclosure(
                    summary="test disclosure",
                    retention="test retention",
                    training="test training",
                ),
                processor_chain=ProcessorChain(processors=("OpenAI",)),
            ),
            host_tool_plan_snapshot=Absent(),
            host_evidence_revision=Absent(),
            model_tool_plan_snapshot=plan,
            tool_effect_mode=effect_mode,
            admitted_tool_scope=scope,
            admitted_tool_scope_digest=scope_digest,
            catalog_definition_revision="3" * 64,
            policy_revision="codex-transport-proof.policy.v1",
            backend_contract_revision="provider-runtime.agent-model-catalog.v1",
            provider_registry_revision=Absent(),
        )
    )
    return GenerationCommandDraft(
        request_id=request_id,
        spec=spec,
        intent=intent,
    )


def codex_generation_command(
    *,
    request_id: UUID,
    operation: GenerationOperation,
    instructions: str,
    input_text: str,
    model: str,
    reasoning: str,
    turn_timeout_seconds: int,
    structured_schema: dict[str, object] | None = None,
    model_tool_plan: FrozenToolPlanSnapshot | None = None,
    tool_grant: str | None = None,
) -> GenerationCommand:
    """Build a post-admission dispatch fixture from exact grant-free facts."""

    draft = codex_generation_draft(
        request_id=request_id,
        operation=operation,
        instructions=instructions,
        input_text=input_text,
        model=model,
        reasoning=reasoning,
        turn_timeout_seconds=turn_timeout_seconds,
        structured_schema=structured_schema,
        model_tool_plan=model_tool_plan,
    )
    return generation_command_from_draft(
        draft,
        tool_grant=(
            BearerToolGrant(token=SecretStr(tool_grant)) if tool_grant is not None else None
        ),
    )


def stage_uncertain_codex_generation(
    db: Session,
    *,
    owner: LlmCallOwner,
    draft: GenerationCommandDraft,
) -> None:
    """Materialize the exact parent/armed-child ledger state used by repair proofs."""

    start_generation_in_current_transaction(
        db,
        GenerationStart(
            generation_id=draft.request_id,
            owner=owner,
            spec=generation_spec_document(draft.spec),
        ),
    )
    turn_id = uuid5(draft.request_id, "nexus-generation-model-turn.v1/1")
    request_fingerprint = generation_draft_fingerprint(draft)
    target = draft.spec.resolved_dispatch_target
    if not isinstance(target, CodexDispatchTargetSnapshot):
        raise AssertionError("Codex test draft lost its dispatch target")
    start_model_turn_in_current_transaction(
        db,
        ModelTurnStart(
            model_turn_id=turn_id,
            generation_id=draft.request_id,
            turn_seq=1,
            request_fingerprint=request_fingerprint,
            route_request_identity={
                "kind": "CodexPersonal",
                "request_id": str(draft.request_id),
                "generation_spec_fingerprint": draft.spec.fingerprint,
                "request_fingerprint": request_fingerprint,
                "model_key": target.model_key,
                "dispatch_model": target.dispatch_model,
                "reasoning": draft.spec.selection.reasoning,
                "agent_definition_revision": target.agent_definition_revision,
            },
        ),
    )
    arm_model_turn_dispatch_in_current_transaction(
        db,
        generation_id=draft.request_id,
        model_turn_id=turn_id,
    )


__all__ = [
    "bind_test_codex_admission",
    "codex_generation_command",
    "codex_generation_draft",
    "compose_codex_execution_runtime",
    "stage_uncertain_codex_generation",
    "codex_model_tool_fixture",
]
