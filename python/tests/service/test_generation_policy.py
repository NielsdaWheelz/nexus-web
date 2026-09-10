"""Canonical proof for total policy and immutable generation admission."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from importlib.util import find_spec
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_service") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from llm_tools import (
        WEB_SEARCH_SPEC,
        Available,
        HandlerSuccess,
        PolicyEpoch,
        ReplayPolicy,
        ToolBinding,
    )
    from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION

    from nexus.schemas.llm import (
        PrivacyDisclosure,
        ProcessorChain,
        Ready,
        Selectable,
        SelectionPresentation,
        SubscriptionBilling,
    )
    from nexus.schemas.presence import Absent, Present
    from nexus.services import generation_policy
    from nexus.services.generation_admission import (
        FrozenHostEvidence,
        GenerationConfigurationDefect,
        GenerationOperationUnavailable,
    )
    from nexus.services.generation_catalog import (
        CodexDispatchTarget,
        GenerationCatalogService,
        ResolvedCatalogPair,
    )
    from nexus.services.generation_intent import GenerationIntent, JsonSchemaOutput, TextOutput
    from nexus.services.generation_service import GenerationService
    from nexus.services.generation_spec import (
        FrozenHostToolPlanSnapshot,
        FrozenScopePredicate,
        FrozenToolScope,
        ImmutablePromptPayloadRef,
        generation_fact_digest,
    )
    from nexus.services.llm_ledger import generation_spec_document
    from nexus.services.tool_runtime.composition import (
        compose_product_tool_runtime,
        compose_tool_runtime,
    )
    from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime

_NOW = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
_CATALOG_REVISION = "a" * 64
_SOURCE_REVISION = "b" * 64
_ROW_FINGERPRINT = "c" * 64


async def _unused_web(value: object, context: object) -> HandlerSuccess[dict[str, object]]:
    del value, context
    return HandlerSuccess(value={}, actual_attempts=0)


def _tools():
    nexus_bindings = tuple(
        ToolBinding(
            spec=entry.spec,
            execute=Available(_unused_web),
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision="test_generation_policy.v1",
            policy_epoch=PolicyEpoch("generation-policy-proof-v1"),
            policy_inputs={"owner": "generation-policy-proof"},
        )
        for entry in NEXUS_TOOL_DECLARATIONS
    )
    return compose_tool_runtime(
        ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Available(_unused_web),
            replay_policy=ReplayPolicy.BilledOnce,
            implementation_revision="test_generation_policy.v1",
            policy_epoch=PolicyEpoch("generation-policy-proof-v1"),
            policy_inputs={"owner": "generation-policy-proof"},
        ),
        nexus_bindings=nexus_bindings,
    )


def _presentation(model: str, reasoning: str) -> SelectionPresentation:
    return SelectionPresentation(
        route_label="Codex Personal",
        model_label=model,
        reasoning_label=reasoning,
        billing=SubscriptionBilling(),
        privacy=PrivacyDisclosure(
            summary="Authenticated local Codex account.",
            retention="Codex account retention applies.",
            training="Nexus does not opt content into training.",
        ),
        processor_chain=ProcessorChain(processors=("Nexus", "OpenAI Codex")),
    )


def _pair(selection: Any) -> ResolvedCatalogPair:
    return ResolvedCatalogPair(
        selection=selection,
        target_key=f"CodexPersonal:{selection.model}",
        source_catalog_definition_revision=_SOURCE_REVISION,
        source_row_fingerprint=_ROW_FINGERPRINT,
        backend_contract_revision=AGENT_BACKEND_CONTRACT_REVISION,
        resolved_dispatch_target=CodexDispatchTarget(
            model_key=selection.model,
            dispatch_model=selection.model,
            agent_definition_revision=_SOURCE_REVISION,
        ),
        source_context_window=Absent(),
        source_max_output_tokens=Absent(),
        effective_context_budget_tokens=400_000,
        effective_output_budget_tokens=32_000,
        presentation=_presentation(selection.model, selection.reasoning),
        lifecycle="Active",
        readiness=Ready(last_checked=_NOW),
        state=Selectable(),
        target_qualification_revision=Present(value="target-qualified"),
        reasoning_wire_qualification_revision=Present(value="reasoning-qualified"),
        qualified_capabilities=("Text", "StrictStructured", "ToolsContinuation"),
        qualified_tool_plan_authority_revisions=tuple(
            operation.definition.authority_revision for operation in _tools().operations.values()
        ),
    )


@dataclass(frozen=True)
class _Snapshot:
    catalog: Any

    def pair(self, selection: Any) -> ResolvedCatalogPair:
        return _pair(selection)


class _Catalog:
    async def final_chat_selection_check(self, **values: Any) -> ResolvedCatalogPair:
        assert values["catalog_definition_revision"] == _CATALOG_REVISION
        return _pair(values["selection"])

    async def read_for_admission(self) -> _Snapshot:
        return _Snapshot(catalog=SimpleNamespace(definition_revision=_CATALOG_REVISION))


@dataclass(frozen=True)
class _ExactDispatchSnapshot:
    pair_value: ResolvedCatalogPair

    def pair(self, selection: Any) -> ResolvedCatalogPair:
        assert selection == self.pair_value.selection
        return self.pair_value


@dataclass(frozen=True)
class _ExactDispatchCatalog:
    pair_value: ResolvedCatalogPair

    async def read_for_admission(self) -> _ExactDispatchSnapshot:
        return _ExactDispatchSnapshot(pair_value=self.pair_value)


def _as_catalog(value: object) -> GenerationCatalogService:
    # justify-type-assertion: each controlled value implements only the public
    # catalog reads under proof so otherwise-racy source changes are deterministic.
    return cast(GenerationCatalogService, value)


def _intent(workflow: generation_policy.OperationWorkflowSpec) -> GenerationIntent:
    output = (
        TextOutput()
        if isinstance(workflow.output_contract, generation_policy.TextOutputContract)
        else JsonSchemaOutput(
            name="GenerationProof",
            schema={
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": False,
            },
        )
    )
    return GenerationIntent(
        instructions="Follow the exact contract.", input="Proof input.", output=output
    )


def _prompt_ref(operation: str, intent: GenerationIntent) -> ImmutablePromptPayloadRef:
    return ImmutablePromptPayloadRef(
        owner_kind=operation,
        owner_id=f"proof-{operation}",
        revision=f"{operation}.prompt.v1",
        payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
    )


def _scope(operation: str) -> FrozenToolScope:
    return FrozenToolScope(
        admitted_refs=(f"media:{operation}",),
        predicates=(
            FrozenScopePredicate(
                kind="ExactRefSet",
                arguments={"operation": operation},
            ),
        ),
    )


def test_total_policy_and_frozen_admission_contract() -> None:
    """Risk: a caller can omit policy facts or make workers reinterpret them."""

    assert _CUTOVER_PRESENT, "the final generation admission owner is absent"
    asyncio.run(_prove_total_policy_and_frozen_admission())


def test_dispatch_recheck_refuses_catalog_substitution_and_incomplete_frozen_tools() -> None:
    """Risk: worker readiness is borrowed from a changed target or incomplete tool runtime."""

    asyncio.run(_prove_exact_dispatch_recheck())


async def _prove_exact_dispatch_recheck() -> None:
    policy = generation_policy.GENERATION_POLICY
    original_pair = _pair(policy.chat.seed)
    unavailable_runtime = compose_product_tool_runtime(None)
    available_tools = compose_available_product_tool_runtime()
    admission = GenerationService(
        catalog=_as_catalog(_Catalog()),
        policy=policy,
        tools=available_tools,
    )
    intent = _intent(policy.chat.workflow)
    spec = admission.freeze_chat_from_pair(
        catalog_definition_revision=_CATALOG_REVISION,
        pair=original_pair,
        tool_authority="ReadOnly",
        scope=_scope("chat"),
        intent=intent,
        prompt_template_revision="chat.dispatch-recheck.v1",
        prompt_payload_ref=_prompt_ref("chat", intent),
    )

    exact = GenerationService(
        catalog=_as_catalog(_ExactDispatchCatalog(original_pair)),
        policy=policy,
        tools=available_tools,
    )
    await exact.require_dispatch_ready(spec)

    target = original_pair.resolved_dispatch_target
    assert isinstance(target, CodexDispatchTarget)
    changed_pairs = {
        "catalog target key": replace(
            original_pair,
            target_key="ProviderApi:openai:gpt-5.6-terra",
        ),
        "source row fingerprint": replace(
            original_pair,
            source_row_fingerprint="d" * 64,
        ),
        "resolved dispatch target": replace(
            original_pair,
            resolved_dispatch_target=replace(
                target,
                dispatch_model="gpt-5.6-terra-substitute",
            ),
        ),
        "source capacity": replace(
            original_pair,
            source_context_window=Present(value=256_000),
        ),
    }
    for changed_fact, changed_pair in changed_pairs.items():
        changed = GenerationService(
            catalog=_as_catalog(_ExactDispatchCatalog(changed_pair)),
            policy=policy,
            tools=available_tools,
        )
        try:
            await changed.require_dispatch_ready(spec)
        except GenerationConfigurationDefect as error:
            assert "dispatch identity changed" in str(error)
        else:
            pytest.fail(f"{changed_fact} was accepted as the frozen dispatch identity")

    unavailable_tools = GenerationService(
        catalog=_as_catalog(_ExactDispatchCatalog(original_pair)),
        policy=policy,
        tools=unavailable_runtime,
    )
    with pytest.raises(GenerationOperationUnavailable) as unavailable:
        await unavailable_tools.require_dispatch_ready(spec)
    assert unavailable.value.operation == "chat"
    assert unavailable.value.reason == {"unavailable_tools": ("web.search",)}


async def _prove_total_policy_and_frozen_admission() -> None:
    policy = generation_policy.GENERATION_POLICY
    tools = _tools()
    service = GenerationService(catalog=_as_catalog(_Catalog()), policy=policy, tools=tools)

    chat_intent = _intent(policy.chat.workflow)
    chat = await service.freeze_chat(
        catalog_definition_revision=_CATALOG_REVISION,
        selection=policy.chat.seed,
        tool_authority="ReadOnly",
        scope=_scope("chat"),
        intent=chat_intent,
        prompt_template_revision="chat.prompt.v1",
        prompt_payload_ref=_prompt_ref("chat", chat_intent),
    )
    assert chat.selection == policy.chat.seed
    assert chat.selection_source == "ChatRun"
    assert chat.model_tool_plan_snapshot.value.plan_id == "ChatRead"
    assert chat.tool_effect_mode.value == "ReadOnly"
    assert generation_spec_document(chat).fingerprint == chat.fingerprint

    admitted: dict[str, object] = {}
    for operation, operation_policy in policy.background_operations.items():
        workflow = operation_policy.workflow
        intent = _intent(workflow)
        scope = (
            _scope(operation)
            if isinstance(workflow.model_tool_policy, generation_policy.ExactModelTools)
            else None
        )
        host = None
        if isinstance(workflow.host_tool_plan, generation_policy.ExactHostToolPlan):
            host = FrozenHostEvidence(
                plan=FrozenHostToolPlanSnapshot(
                    plan_id=workflow.host_tool_plan.plan_id,
                    authority_revision=workflow.host_tool_plan.authority_revision,
                    facts={"bounded": True},
                ),
                evidence_revision=f"{operation}.evidence.v1",
            )
        spec = await service.freeze_background(
            operation=operation,
            intent=intent,
            prompt_template_revision=f"{operation}.prompt.v1",
            prompt_payload_ref=_prompt_ref(operation, intent),
            scope=scope,
            host=host,
        )
        admitted[operation] = spec
        assert spec.selection == operation_policy.selection
        assert spec.policy_revision == policy.revision, (
            "background admission replaced the frozen policy revision"
        )
        assert spec.selection_source == "BackgroundPolicy"
        assert generation_spec_document(spec).value == spec.model_dump(mode="json", by_alias=True)

    assert tuple(admitted) == tuple(policy.background_operations)
    assert admitted["dossier_library"].model_tool_plan_snapshot.value.plan_id == (
        "LibraryDossierRead"
    )
    assert admitted["dossier_idea"].model_tool_plan_snapshot.value.plan_id == "IdeaDossierRead"
    assert admitted["dossier_idea"].host_tool_plan_snapshot.value.plan_id == (
        "idea_dossier_research"
    )
    assert all(
        isinstance(spec.model_tool_plan_snapshot, Absent)
        for key, spec in admitted.items()
        if key not in {"dossier_library", "dossier_idea"}
    )
