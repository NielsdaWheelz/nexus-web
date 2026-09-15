"""Controlled definitions for production generation-tool authority proofs."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    Available,
    HandlerSuccess,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
)

from nexus.schemas.llm import (
    PrivacyDisclosure,
    ProcessorChain,
    SelectionPresentation,
    SubscriptionBilling,
)
from nexus.schemas.presence import Absent, Present
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    FrozenToolScope,
    GenerationBounds,
    GenerationOperation,
    GenerationSpec,
    GenerationSpecFacts,
    GenerationStreamBounds,
    ImmutablePromptPayloadRef,
    TextOutputSnapshot,
    generation_fact_digest,
    tool_scope_digest,
)
from nexus.services.tool_runtime.composition import (
    ComposedToolRuntime,
    compose_tool_runtime,
    freeze_tool_plan_snapshot,
)
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS


def controlled_tool_runtime(handlers: Mapping[str, Any]) -> ComposedToolRuntime:
    async def unexpected(value: Any, context: Any) -> HandlerSuccess[Any]:
        del value, context
        raise AssertionError("proof dispatched a tool outside its controlled handler set")

    nexus_bindings = tuple(
        ToolBinding(
            spec=entry.spec,
            execute=Available(handlers.get(str(entry.spec.id), unexpected)),
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision="test_generation_tool_authority.v1",
            policy_epoch=PolicyEpoch("generation-tool-authority-proof-v1"),
            policy_inputs={"owner": "generation-tool-authority-proof"},
        )
        for entry in NEXUS_TOOL_DECLARATIONS
    )
    return compose_tool_runtime(
        ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Available(handlers.get("web.search", unexpected)),
            replay_policy=ReplayPolicy.BilledOnce,
            implementation_revision="test_generation_tool_authority.v1",
            policy_epoch=PolicyEpoch("generation-tool-authority-proof-v1"),
            policy_inputs={"owner": "generation-tool-authority-proof"},
        ),
        web_read_binding=ToolBinding(
            spec=WEB_READ_SPEC,
            execute=Available(handlers.get("web.read", unexpected)),
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision="test_generation_tool_authority.v1",
            policy_epoch=PolicyEpoch("generation-tool-authority-proof-v1"),
            policy_inputs={"owner": "generation-tool-authority-proof"},
        ),
        nexus_bindings=nexus_bindings,
    )


def search_arguments(
    query: str,
    *,
    scopes: list[str] | None = None,
) -> dict[str, object]:
    return {
        "authors": None,
        "formats": None,
        "kinds": None,
        "limit": None,
        "query": query,
        "roles": None,
        "scopes": scopes,
    }


def generation_tool_spec(
    *,
    operation: Any,
    scope: FrozenToolScope,
    effect_mode: Literal["ReadOnly", "AdditiveWrites"] = "ReadOnly",
    generation_operation: GenerationOperation = "dossier_library",
    selection_source: Literal["ChatRun", "BackgroundPolicy"] = "BackgroundPolicy",
) -> GenerationSpec:
    output = TextOutputSnapshot()
    facts = GenerationSpecFacts(
        operation=generation_operation,
        selection=CodexPersonalSelection(
            route="CodexPersonal",
            model="gpt-5.6-terra",
            reasoning="medium",
        ),
        selection_source=selection_source,
        resolved_dispatch_target=CodexDispatchTargetSnapshot(
            model_key="gpt-5.6-terra",
            dispatch_model="gpt-5.6-terra",
            agent_definition_revision="generation-tool-authority-agent.v1",
        ),
        source_catalog_definition_revision="generation-tool-authority-catalog.v1",
        source_row_fingerprint=generation_fact_digest("source-row"),
        agent_definition_revision=Present(value="generation-tool-authority-agent.v1"),
        source_context_window=Absent(),
        source_max_output_tokens=Absent(),
        effective_context_budget_tokens=32_000,
        effective_output_budget_tokens=4_096,
        bounds=GenerationBounds(
            instructions_max_bytes=32_768,
            input_max_bytes=65_536,
            turn_timeout_seconds=120,
            session_open_timeout_seconds=10,
            runtime_close_timeout_seconds=10,
            transport_margin_seconds=5,
            transport_deadline_seconds=125,
            stream=GenerationStreamBounds(
                max_frames=1_024,
                max_frame_bytes=1_048_576,
                max_stream_bytes=8_388_608,
                text_flush_interval_ms=Absent(),
                text_flush_bytes=Absent(),
            ),
        ),
        prompt_template_revision="generation-tool-authority.prompt.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="artifact_build",
            owner_id="proof",
            revision="generation-tool-authority.prompt.v1",
            payload_digest=generation_fact_digest("prompt"),
        ),
        instructions_digest=generation_fact_digest("instructions"),
        input_digest=generation_fact_digest("input"),
        output_contract=output,
        output_contract_fingerprint=generation_fact_digest(output.model_dump(mode="json")),
        display_at_dispatch=SelectionPresentation(
            route_label="Codex Personal",
            model_label="GPT-5.6 Terra",
            reasoning_label="Medium",
            billing=SubscriptionBilling(),
            privacy=PrivacyDisclosure(
                summary="Local authenticated Codex account.",
                retention="Codex account retention applies.",
                training="Nexus does not opt content into training.",
            ),
            processor_chain=ProcessorChain(processors=("Nexus", "OpenAI Codex")),
        ),
        host_tool_plan_snapshot=Absent(),
        host_evidence_revision=Absent(),
        model_tool_plan_snapshot=Present(value=freeze_tool_plan_snapshot(operation)),
        tool_effect_mode=Present(value=effect_mode),
        admitted_tool_scope=Present(value=scope),
        admitted_tool_scope_digest=Present(value=tool_scope_digest(scope)),
        catalog_definition_revision=generation_fact_digest("catalog"),
        policy_revision="generation-tool-authority-policy.v1",
        backend_contract_revision="generation-tool-authority-backend.v1",
        provider_registry_revision=Absent(),
    )
    return GenerationSpec.freeze(facts)
