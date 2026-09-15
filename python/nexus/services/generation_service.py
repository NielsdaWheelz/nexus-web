"""Single admission service above Codex Personal and provider API transports."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from llm_tools import Available

from nexus.schemas.llm import (
    CapacityPaused,
    OperatorActionRequired,
    Ready,
    TemporarilyUnavailable,
)
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_admission import (
    FrozenHostEvidence,
    GenerationConfigurationDefect,
    GenerationOperationUnavailable,
)
from nexus.services.generation_catalog import (
    CodexDispatchTarget,
    GenerationCatalogService,
    GenerationSelectionUnavailableError,
    ProviderDispatchTarget,
    ResolvedCatalogPair,
)
from nexus.services.generation_intent import (
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
    validate_intent_bounds,
)
from nexus.services.generation_policy import (
    ChatPerRunTools,
    ExactHostToolPlan,
    ExactModelTools,
    GenerationPolicy,
    NoHostToolPlan,
    NoModelTools,
    OperationWorkflowSpec,
    StrictJsonOutputContract,
    TextOutputContract,
)
from nexus.services.generation_selection import (
    CodexPersonalSelection,
    GenerationSelectionSpec,
    ProviderApiSelection,
)
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    CodexDispatchTargetSnapshot,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationBounds,
    GenerationOperation,
    GenerationSpec,
    GenerationSpecFacts,
    GenerationStreamBounds,
    ImmutablePromptPayloadRef,
    ProviderDispatchTargetSnapshot,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
    generation_fact_digest,
)
from nexus.services.tool_runtime.composition import (
    ComposedToolRuntime,
    FrozenToolOperation,
    freeze_tool_plan_snapshot,
)

type ChatToolAuthority = Literal["ReadOnly", "AdditiveWrites"]


@dataclass(frozen=True, slots=True)
class ModelToolAdmission:
    operation: FrozenToolOperation
    effect_mode: Literal["ReadOnly", "AdditiveWrites"]
    scope: FrozenToolScope


class GenerationService:
    """Resolve current admission once; workers consume only the returned spec."""

    def __init__(
        self,
        *,
        catalog: GenerationCatalogService,
        policy: GenerationPolicy,
        tools: ComposedToolRuntime,
    ) -> None:
        self._catalog = catalog
        self._policy = policy
        self._tools = tools

    async def freeze_chat(
        self,
        *,
        catalog_definition_revision: str,
        selection: GenerationSelectionSpec,
        tool_authority: ChatToolAuthority,
        scope: FrozenToolScope,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
    ) -> GenerationSpec:
        pair = await self._catalog.final_chat_selection_check(
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
        )
        return self.freeze_chat_from_pair(
            catalog_definition_revision=catalog_definition_revision,
            pair=pair,
            tool_authority=tool_authority,
            scope=scope,
            intent=intent,
            prompt_template_revision=prompt_template_revision,
            prompt_payload_ref=prompt_payload_ref,
        )

    def freeze_chat_from_pair(
        self,
        *,
        catalog_definition_revision: str,
        pair: ResolvedCatalogPair,
        tool_authority: ChatToolAuthority,
        scope: FrozenToolScope,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
    ) -> GenerationSpec:
        """Freeze a prevalidated Chat catalog receipt without further I/O.

        Chat admission performs the final catalog/readiness check before opening
        its database transaction.  The transaction then freezes prompt, scope,
        tool plan, and this exact immutable pair into one spec; it must not hold
        database locks while refreshing a remote catalog or readiness source.
        """

        if len(catalog_definition_revision) != 64:
            raise ValueError("Chat catalog definition revision must be SHA-256")
        workflow = self._policy.chat.workflow
        tool_admission = self._chat_tool_admission(
            workflow=workflow,
            authority=tool_authority,
            scope=scope,
        )
        return _freeze_spec(
            operation="chat",
            selection_source="ChatRun",
            pair=pair,
            catalog_definition_revision=catalog_definition_revision,
            policy_revision=self._policy.revision,
            workflow=workflow,
            intent=intent,
            prompt_template_revision=prompt_template_revision,
            prompt_payload_ref=prompt_payload_ref,
            host=None,
            model_tools=tool_admission,
        )

    async def freeze_background(
        self,
        *,
        operation: BackgroundOperationKey,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
        scope: FrozenToolScope | None = None,
        host: FrozenHostEvidence | None = None,
    ) -> GenerationSpec:
        snapshot = await self._catalog.read_for_admission()
        operation_policy = self._policy.background_operations[operation]
        pair = snapshot.pair(operation_policy.selection)
        if pair is None:
            raise GenerationConfigurationDefect(
                f"background operation {operation!r} selection is absent from the catalog"
            )
        _require_background_readiness(operation, pair)
        tool_admission = self._background_tool_admission(
            operation=operation,
            workflow=operation_policy.workflow,
            scope=scope,
        )
        return _freeze_spec(
            operation=operation,
            selection_source="BackgroundPolicy",
            pair=pair,
            catalog_definition_revision=snapshot.catalog.definition_revision,
            policy_revision=self._policy.revision,
            workflow=operation_policy.workflow,
            intent=intent,
            prompt_template_revision=prompt_template_revision,
            prompt_payload_ref=prompt_payload_ref,
            host=_validate_host(operation_policy.workflow, host),
            model_tools=tool_admission,
        )

    async def require_dispatch_ready(self, spec: GenerationSpec) -> None:
        """Recheck the exact frozen target and volatile readiness before dispatch."""

        snapshot = await self._catalog.read_for_admission()
        pair = snapshot.pair(spec.selection)
        if pair is None:
            raise GenerationConfigurationDefect(
                f"frozen {spec.operation!r} selection disappeared before dispatch"
            )
        _require_exact_dispatch_identity(spec, pair)
        if pair.lifecycle == "Retired":
            raise GenerationConfigurationDefect(
                f"frozen {spec.operation!r} selection retired before dispatch"
            )
        readiness = pair.readiness
        if isinstance(
            readiness,
            CapacityPaused | OperatorActionRequired | TemporarilyUnavailable,
        ):
            raise GenerationOperationUnavailable(spec.operation, readiness)
        if not isinstance(readiness, Ready):
            raise GenerationSelectionUnavailableError(pair)
        operation = self.model_tool_operation(spec)
        if operation is not None:
            _require_available_tool_bindings(
                operation,
                unavailable_owner=spec.operation,
            )

    def model_tool_operation(self, spec: GenerationSpec) -> FrozenToolOperation | None:
        """Resolve executable authority only from an already-frozen plan snapshot.

        Admission owns this reverse lookup so domain callers never reach into the
        configured tool catalogue or select a plan independently of ``spec``.
        """

        snapshot = spec.model_tool_plan_snapshot
        if isinstance(snapshot, Absent):
            return None
        operation = self._tools.operations.get(snapshot.value.plan_id)
        if operation is None or freeze_tool_plan_snapshot(operation) != snapshot.value:
            raise GenerationConfigurationDefect(
                "frozen model-tool plan is not executable by this runtime"
            )
        return operation

    def _chat_tool_admission(
        self,
        *,
        workflow: OperationWorkflowSpec,
        authority: ChatToolAuthority,
        scope: FrozenToolScope,
    ) -> ModelToolAdmission:
        policy = workflow.model_tool_policy
        if not isinstance(policy, ChatPerRunTools):
            raise GenerationConfigurationDefect("Chat workflow lacks per-run tool authority")
        if authority == "ReadOnly":
            plan_id = policy.read_plan_id
            expected_revision = policy.read_plan_authority_revision
        else:
            plan_id = policy.additive_write_plan_id
            expected_revision = policy.additive_write_plan_authority_revision
        operation = _required_tool_operation(
            self._tools,
            plan_id=plan_id,
            authority_revision=expected_revision,
            unavailable_owner="chat",
        )
        return ModelToolAdmission(operation=operation, effect_mode=authority, scope=scope)

    def _background_tool_admission(
        self,
        *,
        operation: BackgroundOperationKey,
        workflow: OperationWorkflowSpec,
        scope: FrozenToolScope | None,
    ) -> ModelToolAdmission | None:
        policy = workflow.model_tool_policy
        if isinstance(policy, NoModelTools):
            if scope is not None:
                raise ValueError("NoModelTools background admission received a tool scope")
            return None
        if not isinstance(policy, ExactModelTools):
            raise GenerationConfigurationDefect(
                f"background operation {operation!r} has a non-background tool policy"
            )
        if scope is None:
            raise ValueError("ExactModelTools background admission requires a frozen scope")
        tool_operation = _required_tool_operation(
            self._tools,
            plan_id=policy.plan_id,
            authority_revision=policy.authority_revision,
            unavailable_owner=operation,
        )
        return ModelToolAdmission(
            operation=tool_operation,
            effect_mode=policy.effect_mode,
            scope=scope,
        )


def _required_tool_operation(
    runtime: ComposedToolRuntime,
    *,
    plan_id: str,
    authority_revision: str,
    unavailable_owner: str,
) -> FrozenToolOperation:
    try:
        operation = runtime.operations[plan_id]
    except KeyError as error:
        raise GenerationConfigurationDefect(f"unknown model-tool plan {plan_id!r}") from error
    if operation.definition.authority_revision != authority_revision:
        raise GenerationConfigurationDefect(f"model-tool plan {plan_id!r} authority drifted")
    _require_available_tool_bindings(operation, unavailable_owner=unavailable_owner)
    return operation


def _require_available_tool_bindings(
    operation: FrozenToolOperation,
    *,
    unavailable_owner: str,
) -> None:
    unavailable = tuple(
        str(grant.id)
        for grant in operation.profile.ordered_grants
        if not isinstance(operation.plan.catalog_view.binding(grant.id).execute, Available)
    )
    if unavailable:
        raise GenerationOperationUnavailable(
            unavailable_owner,
            {"unavailable_tools": unavailable},
        )


def _require_exact_dispatch_identity(
    spec: GenerationSpec,
    pair: ResolvedCatalogPair,
) -> None:
    dispatch, agent_revision, registry_revision = _dispatch_snapshot(pair)
    current_source_facts = (
        pair.selection,
        pair.target_key,
        pair.source_catalog_definition_revision,
        pair.source_row_fingerprint,
        pair.backend_contract_revision,
        dispatch,
        agent_revision,
        pair.source_context_window,
        pair.source_max_output_tokens,
        registry_revision,
    )
    frozen_source_facts = (
        spec.selection,
        _selection_target_key(spec.selection),
        spec.source_catalog_definition_revision,
        spec.source_row_fingerprint,
        spec.backend_contract_revision,
        spec.resolved_dispatch_target,
        spec.agent_definition_revision,
        spec.source_context_window,
        spec.source_max_output_tokens,
        spec.provider_registry_revision,
    )
    if current_source_facts != frozen_source_facts:
        raise GenerationConfigurationDefect(
            f"frozen {spec.operation!r} dispatch identity changed before dispatch"
        )


def _selection_target_key(
    selection: CodexPersonalSelection | ProviderApiSelection,
) -> str:
    if isinstance(selection, CodexPersonalSelection):
        return f"CodexPersonal:{selection.model}"
    if isinstance(selection, ProviderApiSelection):
        return f"ProviderApi:{selection.model_ref}"
    raise GenerationConfigurationDefect("generation selection union is not exhaustive")


def _validate_host(
    workflow: OperationWorkflowSpec,
    host: FrozenHostEvidence | None,
) -> FrozenHostEvidence | None:
    policy = workflow.host_tool_plan
    if isinstance(policy, NoHostToolPlan):
        if host is not None:
            raise ValueError("NoHostToolPlan admission received host evidence")
        return None
    if not isinstance(policy, ExactHostToolPlan):
        raise GenerationConfigurationDefect("unknown host-tool policy arm")
    if host is None:
        raise ValueError("exact host-tool policy requires frozen evidence")
    if (host.plan.plan_id, host.plan.authority_revision) != (
        policy.plan_id,
        policy.authority_revision,
    ):
        raise ValueError("frozen host-tool evidence differs from policy")
    return host


def _require_background_readiness(operation: str, pair: ResolvedCatalogPair) -> None:
    if pair.lifecycle == "Retired":
        raise GenerationConfigurationDefect(f"background operation {operation!r} is retired")
    readiness = pair.readiness
    if isinstance(readiness, Ready):
        return
    if isinstance(readiness, CapacityPaused):
        raise GenerationOperationUnavailable(operation, readiness)
    if isinstance(readiness, OperatorActionRequired | TemporarilyUnavailable):
        raise GenerationOperationUnavailable(operation, readiness)
    raise GenerationSelectionUnavailableError(pair)


def _freeze_spec(
    *,
    operation: GenerationOperation,
    selection_source: Literal["ChatRun", "BackgroundPolicy"],
    pair: ResolvedCatalogPair,
    catalog_definition_revision: str,
    policy_revision: str,
    workflow: OperationWorkflowSpec,
    intent: GenerationIntent,
    prompt_template_revision: str,
    prompt_payload_ref: ImmutablePromptPayloadRef,
    host: FrozenHostEvidence | None,
    model_tools: ModelToolAdmission | None,
) -> GenerationSpec:
    validate_intent_bounds(
        intent,
        instructions_max_bytes=workflow.bounds.instructions_max_bytes,
        input_max_bytes=workflow.bounds.input_max_bytes,
    )
    output = _output_snapshot(workflow, intent)
    expected_payload_digest = generation_fact_digest(intent.model_dump(mode="json"))
    if prompt_payload_ref.payload_digest != expected_payload_digest:
        raise ValueError("prompt payload ref differs from the admitted intent")
    effective_context = _effective_budget(
        workflow.request_budget.max_context_tokens,
        pair.source_context_window,
    )
    effective_output = _effective_budget(
        workflow.request_budget.max_output_tokens,
        pair.source_max_output_tokens,
    )
    if model_tools is None:
        model_plan = Absent()
        effect_mode: Presence[Literal["ReadOnly", "AdditiveWrites"]] = Absent()
        tool_scope = Absent()
        scope_digest = Absent()
    else:
        model_plan = Present(value=freeze_tool_plan_snapshot(model_tools.operation))
        effect_mode = Present[Literal["ReadOnly", "AdditiveWrites"]](value=model_tools.effect_mode)
        tool_scope = Present(value=model_tools.scope)
        scope_digest = Present(
            value=generation_fact_digest(model_tools.scope.model_dump(mode="json"))
        )
    if host is None:
        host_plan: Presence[FrozenHostToolPlanSnapshot] = Absent()
        host_revision: Presence[str] = Absent()
    else:
        host_plan = Present(value=host.plan)
        host_revision = Present(value=host.evidence_revision)
    dispatch, agent_revision, registry_revision = _dispatch_snapshot(pair)
    facts = GenerationSpecFacts(
        operation=operation,
        selection=pair.selection,
        selection_source=selection_source,
        resolved_dispatch_target=dispatch,
        source_catalog_definition_revision=pair.source_catalog_definition_revision,
        source_row_fingerprint=pair.source_row_fingerprint,
        agent_definition_revision=agent_revision,
        source_context_window=pair.source_context_window,
        source_max_output_tokens=pair.source_max_output_tokens,
        effective_context_budget_tokens=effective_context,
        effective_output_budget_tokens=effective_output,
        bounds=_bounds_snapshot(workflow),
        prompt_template_revision=prompt_template_revision,
        prompt_payload_ref=prompt_payload_ref,
        instructions_digest=_text_digest(intent.instructions),
        input_digest=_text_digest(intent.input),
        output_contract=output,
        output_contract_fingerprint=generation_fact_digest(
            output.model_dump(mode="json", by_alias=True)
        ),
        display_at_dispatch=pair.presentation,
        host_tool_plan_snapshot=host_plan,
        host_evidence_revision=host_revision,
        model_tool_plan_snapshot=model_plan,
        tool_effect_mode=effect_mode,
        admitted_tool_scope=tool_scope,
        admitted_tool_scope_digest=scope_digest,
        catalog_definition_revision=catalog_definition_revision,
        policy_revision=policy_revision,
        backend_contract_revision=pair.backend_contract_revision,
        provider_registry_revision=registry_revision,
    )
    return GenerationSpec.freeze(facts)


def _effective_budget(requested: int, capacity: Presence[int]) -> int:
    return min(requested, capacity.value) if isinstance(capacity, Present) else requested


def _bounds_snapshot(workflow: OperationWorkflowSpec) -> GenerationBounds:
    bounds = workflow.bounds
    return GenerationBounds(
        instructions_max_bytes=bounds.instructions_max_bytes,
        input_max_bytes=bounds.input_max_bytes,
        turn_timeout_seconds=bounds.turn_timeout_seconds,
        session_open_timeout_seconds=bounds.session_open_timeout_seconds,
        runtime_close_timeout_seconds=bounds.runtime_close_timeout_seconds,
        transport_margin_seconds=bounds.transport_margin_seconds,
        transport_deadline_seconds=bounds.transport_deadline_seconds,
        stream=GenerationStreamBounds(
            max_frames=bounds.stream.max_frames,
            max_frame_bytes=bounds.stream.max_frame_bytes,
            max_stream_bytes=bounds.stream.max_stream_bytes,
            text_flush_interval_ms=(
                Present(value=bounds.stream.text_flush_interval_ms)
                if bounds.stream.text_flush_interval_ms is not None
                else Absent()
            ),
            text_flush_bytes=(
                Present(value=bounds.stream.text_flush_bytes)
                if bounds.stream.text_flush_bytes is not None
                else Absent()
            ),
        ),
    )


def _output_snapshot(
    workflow: OperationWorkflowSpec,
    intent: GenerationIntent,
) -> TextOutputSnapshot | StrictJsonOutputSnapshot:
    policy_output = workflow.output_contract
    if isinstance(policy_output, TextOutputContract) and isinstance(intent.output, TextOutput):
        return TextOutputSnapshot()
    if isinstance(policy_output, StrictJsonOutputContract) and isinstance(
        intent.output, JsonSchemaOutput
    ):
        return StrictJsonOutputSnapshot(
            name=intent.output.name,
            schema=intent.output.schema_,
        )
    raise ValueError("generation intent output differs from its operation contract")


def _dispatch_snapshot(
    pair: ResolvedCatalogPair,
) -> tuple[
    CodexDispatchTargetSnapshot | ProviderDispatchTargetSnapshot,
    Presence[str],
    Presence[str],
]:
    target = pair.resolved_dispatch_target
    if isinstance(target, CodexDispatchTarget):
        return (
            CodexDispatchTargetSnapshot(
                model_key=target.model_key,
                dispatch_model=target.dispatch_model,
                agent_definition_revision=target.agent_definition_revision,
            ),
            Present(value=target.agent_definition_revision),
            Absent(),
        )
    if isinstance(target, ProviderDispatchTarget):
        return (
            ProviderDispatchTargetSnapshot.model_validate(
                {
                    "kind": "ProviderApi",
                    "model_ref": target.model_ref,
                    "provider": target.provider,
                    "model_id": target.model_id,
                    "engine": target.engine,
                    "base_url": target.base_url.model_dump(mode="json"),
                    "correlation": target.correlation,
                    "routing": target.routing.model_dump(mode="json"),
                    "continuation_codec": target.continuation_codec,
                    "registry_revision": target.registry_revision,
                }
            ),
            Absent(),
            Present(value=target.registry_revision),
        )
    raise GenerationConfigurationDefect("catalog dispatch target union is not exhaustive")


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = [
    "ChatToolAuthority",
    "GenerationService",
    "ModelToolAdmission",
]
