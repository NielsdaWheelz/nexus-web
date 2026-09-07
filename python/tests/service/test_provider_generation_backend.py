"""Provider API backend behavior through the controller-owned TLS peer."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import ssl
from importlib.util import find_spec
from uuid import uuid4


def test_route_local_transcripts_preserve_terminal_truth() -> None:
    """Every configured API route must use the frozen, tool-capable backend."""

    assert find_spec("nexus.services.provider_generation_backend") is not None, (
        "ProviderApi selections have no route-neutral generation backend"
    )
    asyncio.run(_route_local_transcript_proof())


async def _route_local_transcript_proof() -> None:
    import httpx
    from provider_runtime.registry import api_model_catalog
    from provider_runtime.tool_adapter import CanonicalToolCall
    from provider_runtime.types import (
        Absent as RuntimeAbsent,
    )
    from provider_runtime.types import (
        Present as RuntimePresent,
    )
    from provider_runtime.types import (
        StructuredContent,
        Succeeded,
        TextContent,
        thaw_json_value,
    )

    from nexus.config import Settings
    from nexus.schemas.llm import (
        MeteredApiBilling,
        PrivacyDisclosure,
        ProcessorChain,
        SelectionPresentation,
    )
    from nexus.schemas.presence import Absent, Present
    from nexus.services.generation_catalog import source_controlled_qualification_snapshot
    from nexus.services.generation_intent import (
        GenerationIntent,
        JsonSchemaOutput,
        TextOutput,
    )
    from nexus.services.generation_selection import ProviderApiSelection
    from nexus.services.generation_spec import (
        FrozenToolScope,
        GenerationBounds,
        GenerationSpec,
        GenerationSpecFacts,
        GenerationStreamBounds,
        ImmutablePromptPayloadRef,
        ProviderDispatchTargetSnapshot,
        StrictJsonOutputSnapshot,
        TextOutputSnapshot,
        generation_fact_digest,
    )
    from nexus.services.provider_generation_backend import (
        ProviderGenerationWiring,
        build_provider_generation_backend,
    )
    from nexus.services.provider_generation_contract import (
        ProviderTerminal,
        ProviderToolProposed,
        ProviderToolResult,
        ProviderUsageObserved,
    )
    from nexus.services.tool_runtime.composition import (
        compose_product_tool_runtime,
        compose_provider_model_tools,
    )

    settings = Settings()
    endpoint_overrides = _controller_endpoint_overrides()
    assert set(endpoint_overrides) == set(settings.generation_api_provider_list), (
        "controller endpoint map must name the exact configured provider set"
    )
    tls_context = ssl.create_default_context(cafile=_controller_ca_certificate())
    catalog = api_model_catalog()
    expected_model_refs = (
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
        "anthropic:claude-sonnet-5",
        "anthropic:claude-fable-5",
        "gemini:gemini-3.5-flash",
        "moonshot:kimi-k3",
        "openrouter:kimi-k3",
        "deepseek:deepseek-v4-pro",
        "deepseek:deepseek-v4-flash",
        "xai:grok-4.5",
    )
    assert tuple(row.model_ref for row in catalog.models) == expected_model_refs

    qualifications = source_controlled_qualification_snapshot()
    target_receipts = {
        receipt.target_key: receipt
        for receipt in qualifications.targets
        if receipt.target_key.startswith("ProviderApi:")
    }
    assert tuple(sorted(target_receipts)) == tuple(
        sorted(f"ProviderApi:{model_ref}" for model_ref in expected_model_refs)
    ), "provider qualification targets differ from the complete pinned API catalog"

    provider_reasoning_levels = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
    schema = {
        "Absent": Absent,
        "Present": Present,
        "ProviderApiSelection": ProviderApiSelection,
        "ProviderDispatchTargetSnapshot": ProviderDispatchTargetSnapshot,
        "GenerationBounds": GenerationBounds,
        "GenerationStreamBounds": GenerationStreamBounds,
        "TextOutputSnapshot": TextOutputSnapshot,
        "StrictJsonOutputSnapshot": StrictJsonOutputSnapshot,
        "ImmutablePromptPayloadRef": ImmutablePromptPayloadRef,
        "SelectionPresentation": SelectionPresentation,
        "MeteredApiBilling": MeteredApiBilling,
        "PrivacyDisclosure": PrivacyDisclosure,
        "ProcessorChain": ProcessorChain,
        "FrozenToolScope": FrozenToolScope,
        "GenerationSpecFacts": GenerationSpecFacts,
        "GenerationSpec": GenerationSpec,
        "RuntimeAbsent": RuntimeAbsent,
        "RuntimePresent": RuntimePresent,
    }
    tool_runtime = compose_product_tool_runtime(None)
    tool_operations_by_revision = {
        operation.definition.authority_revision: operation
        for operation in tool_runtime.operations.values()
    }
    text_coverage: set[tuple[str, str]] = set()
    strict_cases: dict[tuple[str, str], object] = {}
    tool_cases: dict[tuple[str, str, str, str], tuple[object, object]] = {}

    for row in catalog.models:
        receipt = target_receipts[f"ProviderApi:{row.model_ref}"]
        assert receipt.source_row_fingerprint == row.row_fingerprint
        advertised_capabilities = set(receipt.capabilities)
        assert advertised_capabilities <= {
            "Text",
            "StrictStructured",
            "ToolsContinuation",
        }, f"peer proof does not cover {advertised_capabilities!r} for {row.model_ref}"
        assert "Text" in advertised_capabilities
        assert ("ToolsContinuation" in advertised_capabilities) == bool(
            receipt.tool_plan_qualifications
        ), f"{row.model_ref} tool capability and qualified compositions disagree"
        declared_reasoning = tuple(item.key for item in row.reasoning)
        qualified_reasoning = tuple(
            level
            for level in provider_reasoning_levels
            if qualifications.reasoning_for(
                ProviderApiSelection(
                    route="ProviderApi",
                    model_ref=row.model_ref,
                    reasoning=level,
                )
            )
            is not None
        )
        assert qualified_reasoning == declared_reasoning, (
            f"{row.model_ref} qualification reasoning differs from llm-calling: "
            f"{qualified_reasoning!r} != {declared_reasoning!r}"
        )
        shape = (row.provider, row.dispatch.engine)
        if "StrictStructured" in advertised_capabilities:
            strict_cases.setdefault(shape, row)
        for qualification in receipt.tool_plan_qualifications:
            tool_cases.setdefault(
                (
                    row.provider,
                    row.dispatch.engine,
                    qualification.output_contract,
                    qualification.authority_revision,
                ),
                (row, qualification),
            )

    async with httpx.AsyncClient(
        verify=tls_context,
        timeout=httpx.Timeout(10.0),
        trust_env=False,
    ) as client:
        backend = build_provider_generation_backend(
            settings,
            client,
            wiring=ProviderGenerationWiring(endpoint_overrides=endpoint_overrides),
        )

        for row in catalog.models:
            for reasoning_fact in row.reasoning:
                reasoning = reasoning_fact.key
                intent = GenerationIntent(
                    instructions="Return the exact requested fixture response.",
                    input=(
                        "NEXUS_PROVIDER_SCENARIO=text "
                        f"NEXUS_EXPECT_REASONING={reasoning} model={row.model_ref}"
                    ),
                    output=TextOutput(),
                )
                spec = _provider_spec(
                    catalog=catalog,
                    row=row,
                    reasoning=reasoning,
                    intent=intent,
                    model_tools=None,
                    generation_fact_digest=generation_fact_digest,
                    schema=schema,
                )
                turn = backend.prepare_initial_turn(
                    generation_id=uuid4(),
                    spec=spec,
                    intent=intent,
                    model_tools=None,
                )
                events = [event async for event in backend.stream_turn(turn)]
                terminal = events[-1]
                assert isinstance(terminal, ProviderTerminal), (
                    f"{row.model_ref}/{reasoning} omitted its terminal: {events!r}"
                )
                assert isinstance(terminal.outcome, Succeeded), (
                    f"{row.model_ref}/{reasoning} failed: {terminal.outcome!r}"
                )
                assert isinstance(terminal.outcome.response.content, TextContent)
                assert terminal.outcome.response.content.text == (
                    f"provider:{row.provider}:text-ok"
                )
                expected_native_reasoning = json.dumps(
                    thaw_json_value(reasoning_fact.native_wire_fragment),
                    sort_keys=True,
                    separators=(",", ":"),
                )
                assert terminal.outcome.meta.native_reasoning == RuntimePresent(
                    expected_native_reasoning
                )
                assert isinstance(terminal.outcome.meta.usage, RuntimePresent)
                usage_events = tuple(
                    event for event in events if isinstance(event, ProviderUsageObserved)
                )
                assert usage_events and (
                    usage_events[-1].usage == terminal.outcome.meta.usage.value
                )
                if row.dispatch.correlation == "none":
                    assert isinstance(terminal.correlation, Absent)
                else:
                    assert isinstance(terminal.correlation, Present)
                assert isinstance(terminal.successor, Absent)
                text_coverage.add((row.model_ref, reasoning))

        strict_coverage: set[tuple[str, str]] = set()
        for shape, row in strict_cases.items():
            reasoning = _default_reasoning(row, RuntimePresent)
            strict_intent = GenerationIntent(
                instructions="Return one strict object.",
                input=(
                    "NEXUS_PROVIDER_SCENARIO=strict "
                    f"NEXUS_EXPECT_REASONING={reasoning} model={row.model_ref}"
                ),
                output=JsonSchemaOutput(
                    name="FixtureAnswer",
                    schema={
                        "type": "object",
                        "properties": {"answer": {"type": "string"}},
                        "required": ["answer"],
                        "additionalProperties": False,
                    },
                    strict=True,
                ),
            )
            strict_spec = _provider_spec(
                catalog=catalog,
                row=row,
                reasoning=reasoning,
                intent=strict_intent,
                model_tools=None,
                generation_fact_digest=generation_fact_digest,
                schema=schema,
            )
            strict_turn = backend.prepare_initial_turn(
                generation_id=uuid4(),
                spec=strict_spec,
                intent=strict_intent,
                model_tools=None,
            )
            strict_events = [event async for event in backend.stream_turn(strict_turn)]
            strict_terminal = strict_events[-1]
            assert isinstance(strict_terminal, ProviderTerminal)
            assert isinstance(strict_terminal.outcome, Succeeded)
            assert isinstance(strict_terminal.outcome.response.content, StructuredContent)
            assert strict_terminal.outcome.response.content.payload == {"answer": "strict-ok"}
            strict_coverage.add(shape)

        tool_coverage: set[tuple[str, str, str, str]] = set()
        for coverage_key, (row, qualification) in tool_cases.items():
            assert qualification.output_contract == "Text", (
                f"unproved qualified provider composition {coverage_key!r}"
            )
            tool_operation = tool_operations_by_revision.get(qualification.authority_revision)
            assert tool_operation is not None, (
                f"qualified tool authority is absent from composition: {coverage_key!r}"
            )
            model_tools = compose_provider_model_tools(tool_operation)
            reasoning = _default_reasoning(row, RuntimePresent)
            tool_intent = GenerationIntent(
                instructions="Use the supplied Nexus tool before answering.",
                input=(
                    "NEXUS_PROVIDER_SCENARIO=tool "
                    f"NEXUS_EXPECT_REASONING={reasoning} model={row.model_ref}"
                ),
                output=TextOutput(),
            )
            tool_spec = _provider_spec(
                catalog=catalog,
                row=row,
                reasoning=reasoning,
                intent=tool_intent,
                model_tools=model_tools,
                generation_fact_digest=generation_fact_digest,
                schema=schema,
            )
            generation_id = uuid4()
            first_turn = backend.prepare_initial_turn(
                generation_id=generation_id,
                spec=tool_spec,
                intent=tool_intent,
                model_tools=model_tools,
            )
            first_events = [event async for event in backend.stream_turn(first_turn)]
            proposed = tuple(
                event for event in first_events if isinstance(event, ProviderToolProposed)
            )
            assert len(proposed) == 1, (
                f"{coverage_key!r} expected one tool proposal; got {first_events!r}"
            )
            assert isinstance(proposed[0].proposal, CanonicalToolCall)
            assert str(proposed[0].proposal.tool_id) == str(
                tool_operation.profile.ordered_grants[0].id
            )
            assert proposed[0].proposal.arguments == {"query": "fixture"}
            first_terminal = first_events[-1]
            assert isinstance(first_terminal, ProviderTerminal)
            assert isinstance(first_terminal.outcome, Succeeded)
            assert isinstance(first_terminal.successor, Present)
            successor = first_terminal.successor.value
            assert "NEXUS_PROVIDER_SCENARIO" not in repr(successor)
            second_turn = backend.prepare_successor_turn(
                generation_id=generation_id,
                spec=tool_spec,
                intent=tool_intent,
                source_turn_seq=1,
                canonical_continuation=successor.canonical_bytes,
                tool_results=(
                    ProviderToolResult(
                        provider_call_id=proposed[0].proposal.provider_call_id,
                        output='{"matches":["fixture evidence"]}',
                        is_error=False,
                    ),
                ),
                model_tools=model_tools,
            )
            assert second_turn.turn_seq == 2
            assert second_turn.request_fingerprint != first_turn.request_fingerprint
            assert second_turn.continuation_fingerprint == successor.fingerprint
            second_events = [event async for event in backend.stream_turn(second_turn)]
            second_terminal = second_events[-1]
            assert isinstance(second_terminal, ProviderTerminal)
            assert isinstance(second_terminal.outcome, Succeeded)
            assert isinstance(second_terminal.outcome.response.content, TextContent)
            assert second_terminal.outcome.response.content.text == (
                f"provider:{row.provider}:tool-ok"
            )
            assert isinstance(second_terminal.successor, Absent)
            tool_coverage.add(coverage_key)

    expected_text_coverage = {
        (row.model_ref, reasoning.key) for row in catalog.models for reasoning in row.reasoning
    }
    assert text_coverage == expected_text_coverage
    assert strict_coverage == set(strict_cases)
    assert tool_coverage == set(tool_cases)


def _provider_spec(
    *,
    catalog: object,
    row: object,
    reasoning: str,
    intent: object,
    model_tools: object,
    generation_fact_digest: object,
    schema: dict[str, object],
) -> object:
    Absent = schema["Absent"]
    Present = schema["Present"]
    RuntimeAbsent = schema["RuntimeAbsent"]
    RuntimePresent = schema["RuntimePresent"]
    base_url = (
        Present(value=row.dispatch.base_url.value)
        if isinstance(row.dispatch.base_url, RuntimePresent)
        else Absent()
    )
    if isinstance(row.dispatch.routing, RuntimePresent):
        routing = row.dispatch.routing.value
        routing_value = {
            "only": list(routing.only),
            "order": list(routing.order),
            "quantizations": list(routing.quantizations),
            "allow_fallbacks": routing.allow_fallbacks,
            "require_parameters": routing.require_parameters,
            "data_collection": routing.data_collection,
            "zdr": routing.zdr,
        }
        routing_presence = Present(value=routing_value)
    elif isinstance(row.dispatch.routing, RuntimeAbsent):
        routing_presence = Absent()
    else:
        raise AssertionError("runtime routing Presence is not closed")
    selection = schema["ProviderApiSelection"](
        route="ProviderApi",
        model_ref=row.model_ref,
        reasoning=reasoning,
    )
    dispatch = schema["ProviderDispatchTargetSnapshot"](
        model_ref=row.model_ref,
        provider=row.provider,
        model_id=row.dispatch.model_id,
        engine=row.dispatch.engine,
        base_url=base_url,
        correlation=row.dispatch.correlation,
        routing=routing_presence,
        continuation_codec=row.continuation_codec,
        registry_revision=catalog.registry_revision,
    )
    if intent.output.kind == "Text":
        output = schema["TextOutputSnapshot"]()
    else:
        output = schema["StrictJsonOutputSnapshot"](
            name=intent.output.name,
            schema=intent.output.schema_,
        )
    if model_tools is None:
        model_plan = Absent()
        effect_mode = Absent()
        scope = Absent()
        scope_digest = Absent()
    else:
        tool_scope = schema["FrozenToolScope"](
            admitted_refs=("urn:nexus:test:fixture",),
            predicates=(),
        )
        model_plan = Present(value=model_tools.snapshot)
        effect_mode = Present(
            value=("ReadOnly" if model_tools.snapshot.max_live_writes is None else "AdditiveWrites")
        )
        scope = Present(value=tool_scope)
        scope_digest = Present(value=generation_fact_digest(tool_scope.model_dump(mode="json")))
    presentation = schema["SelectionPresentation"](
        route_label=f"{row.provider.title()} API",
        model_label=row.model_ref,
        reasoning_label=reasoning,
        billing=schema["MeteredApiBilling"](),
        privacy=schema["PrivacyDisclosure"](
            summary="Fixture provider processing.",
            retention="Fixture requests are ephemeral.",
            training="Fixture requests are not used for training.",
        ),
        processor_chain=schema["ProcessorChain"](processors=("Nexus", row.provider)),
    )
    facts = schema["GenerationSpecFacts"](
        operation="chat",
        selection=selection,
        selection_source="ChatRun",
        resolved_dispatch_target=dispatch,
        source_catalog_definition_revision=catalog.definition_revision,
        source_row_fingerprint=row.row_fingerprint,
        agent_definition_revision=Absent(),
        source_context_window=Present(value=row.context_window),
        source_max_output_tokens=Present(value=row.max_output_tokens),
        effective_context_budget_tokens=min(32_000, row.context_window),
        effective_output_budget_tokens=min(4_096, row.max_output_tokens),
        bounds=schema["GenerationBounds"](
            instructions_max_bytes=32 * 1024,
            input_max_bytes=64 * 1024,
            turn_timeout_seconds=10,
            session_open_timeout_seconds=1,
            runtime_close_timeout_seconds=1,
            transport_margin_seconds=2,
            transport_deadline_seconds=15,
            stream=schema["GenerationStreamBounds"](
                max_frames=1_024,
                max_frame_bytes=1 * 1024 * 1024,
                max_stream_bytes=8 * 1024 * 1024,
                text_flush_interval_ms=Absent(),
                text_flush_bytes=Absent(),
            ),
        ),
        prompt_template_revision="provider-peer.v1",
        prompt_payload_ref=schema["ImmutablePromptPayloadRef"](
            owner_kind="provider-proof",
            owner_id="fixture",
            revision="v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
        instructions_digest=hashlib.sha256(intent.instructions.encode()).hexdigest(),
        input_digest=hashlib.sha256(intent.input.encode()).hexdigest(),
        output_contract=output,
        output_contract_fingerprint=generation_fact_digest(
            output.model_dump(mode="json", by_alias=True)
        ),
        display_at_dispatch=presentation,
        host_tool_plan_snapshot=Absent(),
        host_evidence_revision=Absent(),
        model_tool_plan_snapshot=model_plan,
        tool_effect_mode=effect_mode,
        admitted_tool_scope=scope,
        admitted_tool_scope_digest=scope_digest,
        catalog_definition_revision=_sha256("nexus-provider-peer-catalog"),
        policy_revision="provider-proof-policy.v1",
        backend_contract_revision=catalog.backend_contract_revision,
        provider_registry_revision=Present(value=catalog.registry_revision),
    )
    return schema["GenerationSpec"].freeze(facts)


def _default_reasoning(row: object, runtime_present: type) -> str:
    source_default = row.source_default_reasoning
    return (
        source_default.value
        if isinstance(source_default, runtime_present)
        else row.reasoning[0].key
    )


def _controller_endpoint_overrides() -> dict[str, str]:
    value = json.loads(os.environ["GENERATION_API_BASE_URLS"])
    assert isinstance(value, dict) and all(
        isinstance(provider, str) and isinstance(origin, str) for provider, origin in value.items()
    )
    return value


def _controller_ca_certificate() -> str:
    values = json.loads(os.environ["NEXUS_TEST_TLS_CA_CERTS"])
    assert isinstance(values, list) and len(values) == 1 and isinstance(values[0], str)
    return values[0]


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
