"""Single admission service above Codex Personal and provider API transports."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from llm_tools import Available

from nexus.schemas.llm import Ready
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_admission import (
    GenerationConfigurationDefect,
    GenerationOperationUnavailable,
)
from nexus.services.generation_catalog import (
    GenerationCatalogService,
    ResolvedCatalogPair,
    workflow_transport_capability,
)
from nexus.services.generation_policy import (
    EffectMode,
    ExactHostToolPlan,
    ExactModelTools,
    GenerationPolicy,
    NoHostToolPlan,
    NoModelTools,
    OperationWorkflowSpec,
)
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    CodexDispatchTargetSnapshot,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationIntent,
    GenerationOperation,
    GenerationSpec,
    GenerationSpecFacts,
    ImmutablePromptPayloadRef,
    JsonSchemaOutput,
    StrictJsonOutputSnapshot,
    TextOutput,
    TextOutputSnapshot,
    generation_fact_digest,
    validate_intent_bounds,
)
from nexus.services.tool_runtime.catalog import (
    ComposedToolRuntime,
    FrozenToolOperation,
    freeze_tool_plan_snapshot,
)


@dataclass(frozen=True, slots=True)
class ModelToolAdmission:
    operation: FrozenToolOperation
    effect_mode: EffectMode
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

    def freeze_chat_from_pair(
        self,
        *,
        catalog_definition_revision: str,
        pair: ResolvedCatalogPair,
        scope: FrozenToolScope,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
    ) -> GenerationSpec:
        """Freeze a prevalidated Chat receipt without holding locks across I/O."""

        if len(catalog_definition_revision) != 64:
            raise ValueError("Chat catalog definition revision must be SHA-256")
        workflow = self._policy.chat.workflow
        policy = workflow.model_tool_policy
        if not isinstance(policy, ExactModelTools):
            raise GenerationConfigurationDefect("Chat workflow lacks its exact model-tool plan")
        if "TextWithTools" not in pair.capabilities:
            raise GenerationOperationUnavailable(
                "chat", "text with frozen model tools is unavailable"
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
            host_plan=None,
            host_evidence_revision=None,
            model_tools=ModelToolAdmission(
                operation=self._required_tool_operation(
                    plan_id=policy.plan_id,
                    authority_revision=policy.authority_revision,
                    owner="chat",
                ),
                effect_mode=policy.effect_mode,
                scope=scope,
            ),
        )

    async def freeze_background(
        self,
        *,
        operation: BackgroundOperationKey,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
        scope: FrozenToolScope | None = None,
        host_plan: FrozenHostToolPlanSnapshot | None = None,
        host_evidence_revision: str | None = None,
    ) -> GenerationSpec:
        snapshot = await self._catalog.read_for_admission()
        entry = self._policy.background_operations[operation]
        pair = snapshot.pair(entry.selection)
        if pair is None:
            raise GenerationConfigurationDefect(
                f"background operation {operation!r} selection is absent from the catalog"
            )
        if not isinstance(pair.readiness, Ready):
            raise GenerationOperationUnavailable(operation, pair.readiness)
        if workflow_transport_capability(entry.workflow) not in pair.capabilities:
            raise GenerationOperationUnavailable(
                operation, "required model output mode is unavailable"
            )
        _validate_host_policy(entry.workflow, host_plan, host_evidence_revision)
        return _freeze_spec(
            operation=operation,
            selection_source="BackgroundPolicy",
            pair=pair,
            catalog_definition_revision=snapshot.catalog.definition_revision,
            policy_revision=self._policy.revision,
            workflow=entry.workflow,
            intent=intent,
            prompt_template_revision=prompt_template_revision,
            prompt_payload_ref=prompt_payload_ref,
            host_plan=host_plan,
            host_evidence_revision=host_evidence_revision,
            model_tools=self._background_tool_admission(operation, entry.workflow, scope),
        )

    async def require_dispatch_ready(self, spec: GenerationSpec) -> None:
        """Recheck the exact frozen target and volatile readiness before dispatch."""

        snapshot = await self._catalog.read_for_admission()
        pair = snapshot.pair(spec.selection)
        if pair is None:
            raise GenerationConfigurationDefect(
                f"frozen {spec.operation!r} selection disappeared before dispatch"
            )
        frozen = (
            spec.source_catalog_definition_revision,
            spec.source_row_fingerprint,
            spec.backend_contract_revision,
            spec.resolved_dispatch_target,
            spec.source_context_window,
            spec.source_max_output_tokens,
        )
        current = (
            pair.source_catalog_definition_revision,
            pair.source_row_fingerprint,
            pair.backend_contract_revision,
            pair.resolved_dispatch_target,
            pair.source_context_window,
            pair.source_max_output_tokens,
        )
        if frozen != current:
            raise GenerationConfigurationDefect(
                f"frozen {spec.operation!r} dispatch identity changed before dispatch"
            )
        if not isinstance(pair.readiness, Ready):
            raise GenerationOperationUnavailable(spec.operation, pair.readiness)
        has_tools = isinstance(spec.model_tool_plan_snapshot, Present)
        required_mode = (
            "StructuredWithTools"
            if isinstance(spec.output_contract, StrictJsonOutputSnapshot) and has_tools
            else "StrictStructured"
            if isinstance(spec.output_contract, StrictJsonOutputSnapshot)
            else "TextWithTools"
            if has_tools
            else "Text"
        )
        if required_mode not in pair.capabilities:
            raise GenerationOperationUnavailable(
                spec.operation, "required model output mode is unavailable"
            )
        operation = self.model_tool_operation(spec)
        if operation is not None:
            _require_available_bindings(operation, owner=spec.operation)

    def model_tool_operation(self, spec: GenerationSpec) -> FrozenToolOperation | None:
        """Resolve executable authority only from the already-frozen plan snapshot."""

        snapshot = spec.model_tool_plan_snapshot
        if isinstance(snapshot, Absent):
            return None
        operation = self._tools.operations.get(snapshot.value.plan_id)
        if operation is None or freeze_tool_plan_snapshot(operation) != snapshot.value:
            raise GenerationConfigurationDefect(
                "frozen model-tool plan is not executable by this runtime"
            )
        return operation

    def _background_tool_admission(
        self,
        operation: BackgroundOperationKey,
        workflow: OperationWorkflowSpec,
        scope: FrozenToolScope | None,
    ) -> ModelToolAdmission | None:
        policy = workflow.model_tool_policy
        if isinstance(policy, NoModelTools):
            if scope is not None:
                raise ValueError("NoModelTools background admission received a tool scope")
            return None
        if scope is None:
            raise ValueError("ExactModelTools background admission requires a frozen scope")
        return ModelToolAdmission(
            operation=self._required_tool_operation(
                plan_id=policy.plan_id,
                authority_revision=policy.authority_revision,
                owner=operation,
            ),
            effect_mode=policy.effect_mode,
            scope=scope,
        )

    def _required_tool_operation(
        self, *, plan_id: str, authority_revision: str, owner: str
    ) -> FrozenToolOperation:
        try:
            operation = self._tools.operations[plan_id]
        except KeyError as error:
            raise GenerationConfigurationDefect(f"unknown model-tool plan {plan_id!r}") from error
        if operation.definition.authority_revision != authority_revision:
            raise GenerationConfigurationDefect(f"model-tool plan {plan_id!r} authority drifted")
        _require_available_bindings(operation, owner=owner)
        return operation


def _require_available_bindings(operation: FrozenToolOperation, *, owner: str) -> None:
    unavailable = tuple(
        str(grant.id)
        for grant in operation.profile.ordered_grants
        if not isinstance(operation.plan.catalog_view.binding(grant.id).execute, Available)
    )
    if unavailable:
        raise GenerationOperationUnavailable(owner, {"unavailable_tools": unavailable})


def _validate_host_policy(
    workflow: OperationWorkflowSpec,
    host_plan: FrozenHostToolPlanSnapshot | None,
    host_evidence_revision: str | None,
) -> None:
    policy = workflow.host_tool_plan
    if (host_plan is None) != (host_evidence_revision is None):
        raise ValueError("host-tool evidence requires both a plan and a revision")
    if isinstance(policy, NoHostToolPlan):
        if host_plan is not None:
            raise ValueError("NoHostToolPlan admission received host evidence")
        return
    if not isinstance(policy, ExactHostToolPlan):
        raise GenerationConfigurationDefect("unknown host-tool policy arm")
    if host_plan is None:
        raise ValueError("exact host-tool policy requires frozen evidence")
    if (host_plan.plan_id, host_plan.authority_revision) != (
        policy.plan_id,
        policy.authority_revision,
    ):
        raise ValueError("frozen host-tool evidence differs from policy")


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
    host_plan: FrozenHostToolPlanSnapshot | None,
    host_evidence_revision: str | None,
    model_tools: ModelToolAdmission | None,
) -> GenerationSpec:
    validate_intent_bounds(
        intent,
        instructions_max_bytes=workflow.bounds.instructions_max_bytes,
        input_max_bytes=workflow.bounds.input_max_bytes,
    )
    if prompt_payload_ref.payload_digest != generation_fact_digest(intent.model_dump(mode="json")):
        raise ValueError("prompt payload ref differs from the admitted intent")
    output = _output_snapshot(workflow, intent)
    target = pair.resolved_dispatch_target
    facts = GenerationSpecFacts(
        operation=operation,
        selection=pair.selection,
        selection_source=selection_source,
        resolved_dispatch_target=target,
        source_catalog_definition_revision=pair.source_catalog_definition_revision,
        source_row_fingerprint=pair.source_row_fingerprint,
        agent_definition_revision=(
            Present(value=target.agent_definition_revision)
            if isinstance(target, CodexDispatchTargetSnapshot)
            else Absent()
        ),
        source_context_window=pair.source_context_window,
        source_max_output_tokens=pair.source_max_output_tokens,
        effective_context_budget_tokens=_budget(
            workflow.request_budget.max_context_tokens, pair.source_context_window
        ),
        effective_output_budget_tokens=_budget(
            workflow.request_budget.max_output_tokens, pair.source_max_output_tokens
        ),
        bounds=workflow.bounds,
        prompt_template_revision=prompt_template_revision,
        prompt_payload_ref=prompt_payload_ref,
        instructions_digest=_text_digest(intent.instructions),
        input_digest=_text_digest(intent.input),
        output_contract=output,
        output_contract_fingerprint=generation_fact_digest(
            output.model_dump(mode="json", by_alias=True)
        ),
        display_at_dispatch=pair.presentation,
        host_tool_plan_snapshot=(Absent() if host_plan is None else Present(value=host_plan)),
        host_evidence_revision=(
            Absent() if host_evidence_revision is None else Present(value=host_evidence_revision)
        ),
        model_tool_plan_snapshot=(
            Absent()
            if model_tools is None
            else Present(value=freeze_tool_plan_snapshot(model_tools.operation))
        ),
        tool_effect_mode=(
            Absent() if model_tools is None else Present[EffectMode](value=model_tools.effect_mode)
        ),
        admitted_tool_scope=(Absent() if model_tools is None else Present(value=model_tools.scope)),
        admitted_tool_scope_digest=(
            Absent()
            if model_tools is None
            else Present(value=generation_fact_digest(model_tools.scope.model_dump(mode="json")))
        ),
        catalog_definition_revision=catalog_definition_revision,
        policy_revision=policy_revision,
        backend_contract_revision=pair.backend_contract_revision,
        provider_registry_revision=(
            Absent()
            if isinstance(target, CodexDispatchTargetSnapshot)
            else Present(value=target.registry_revision)
        ),
    )
    return GenerationSpec.freeze(facts)


def _output_snapshot(
    workflow: OperationWorkflowSpec, intent: GenerationIntent
) -> TextOutputSnapshot | StrictJsonOutputSnapshot:
    if workflow.output_contract == "Text" and isinstance(intent.output, TextOutput):
        return TextOutputSnapshot()
    if workflow.output_contract == "StrictJson" and isinstance(intent.output, JsonSchemaOutput):
        return StrictJsonOutputSnapshot(name=intent.output.name, schema=intent.output.schema_)
    raise ValueError("generation intent output differs from its operation contract")


def _budget(requested: int, capacity: Presence[int]) -> int:
    return min(requested, capacity.value) if isinstance(capacity, Present) else requested


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
