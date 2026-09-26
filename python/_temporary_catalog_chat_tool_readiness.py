"""Temporary catalog/admission composition proof; remove after live acceptance."""

import asyncio
from datetime import UTC, datetime
from typing import cast

import httpx
from llm_tools import BraveSearchProvider
from provider_runtime.registry import api_model_catalog

from nexus.schemas.llm import Ineligible, Ready
from nexus.schemas.presence import Absent
from nexus.services.codex_generation_contract import (
    CodexCatalogModel,
    CodexCatalogReasoning,
    CodexModelCatalog,
)
from nexus.services.generation_admission import GenerationOperationUnavailable
from nexus.services.generation_catalog import (
    CatalogReadinessSnapshot,
    GenerationCatalogService,
    GenerationSelectionUnavailableError,
    compose_generation_catalog,
    resolve_chat_selection,
)
from nexus.services.generation_policy import GENERATION_POLICY
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    CodexPersonalSelection,
    FrozenToolScope,
    GenerationIntent,
    ImmutablePromptPayloadRef,
    TextOutput,
    generation_fact_digest,
)
from nexus.services.tool_runtime.catalog import ComposedToolRuntime, compose_tool_runtime


def main() -> None:
    checked_at = datetime.now(UTC)
    reasoning = tuple(
        CodexCatalogReasoning(key=key, label=key, native_wire_value=key)
        for key in ("low", "medium", "high", "xhigh", "max")
    )
    source = CodexModelCatalog(
        backend_contract_revision="test-codex-contract",
        definition_revision="a" * 64,
        native_revision=Absent(),
        observed_at=checked_at,
        supports_frozen_mcp_tools=False,
        models=tuple(
            CodexCatalogModel(
                key=model,
                dispatch_model=model,
                label=model,
                source_context_window=Absent(),
                source_max_output_tokens=Absent(),
                input_modalities=("text",),
                reasoning=reasoning,
                source_default_reasoning=Absent(),
                row_fingerprint=character * 64,
            )
            for model, character in (
                ("gpt-6-sol", "b"),
                ("gpt-6-astra", "c"),
                ("gpt-6-luna", "d"),
            )
        ),
    )

    def catalog_for(runtime: ComposedToolRuntime):
        return compose_generation_catalog(
            agent_catalog=source,
            api_catalog=api_model_catalog(),
            configured_api_providers=(),
            readiness=CatalogReadinessSnapshot(
                observed_at=checked_at,
                routes=(("CodexPersonal", Ready(last_checked=checked_at)),),
            ),
            policy=GENERATION_POLICY,
            tool_runtime=runtime,
            now=checked_at,
        )

    runtime = compose_tool_runtime(None)
    snapshot = catalog_for(runtime)
    selection = CodexPersonalSelection(route="CodexPersonal", model="gpt-6-sol", reasoning="low")
    pair = snapshot.pair(selection)
    assert pair is not None
    intent = GenerationIntent(instructions="test", input="test", output=TextOutput())
    service = GenerationService(
        catalog=cast(GenerationCatalogService, None), policy=GENERATION_POLICY, tools=runtime
    )
    try:
        service.freeze_chat_from_pair(
            catalog_definition_revision=snapshot.catalog.definition_revision,
            pair=pair,
            scope=FrozenToolScope(admitted_refs=(), predicates=()),
            intent=intent,
            prompt_template_revision="test",
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="test",
                owner_id="test",
                revision="test",
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
        )
    except GenerationOperationUnavailable as error:
        assert error.reason == "text with frozen model tools is unavailable"
    else:
        raise AssertionError("expected admission to reject unsupported Codex model tools")

    assert isinstance(snapshot.catalog.routes[0].readiness, Ready)
    for model in snapshot.catalog.routes[0].models:
        for row in model.reasoning:
            assert isinstance(row.chat_state, Ineligible), (
                "catalog offered a selectable Codex pair without frozen tool authority: "
                f"{model.key}/{row.key}"
            )
            assert row.chat_state.code == "unsupported_capability"
            assert isinstance(row.readiness, Ready)
    try:
        resolve_chat_selection(
            snapshot,
            catalog_definition_revision=snapshot.catalog.definition_revision,
            selection=selection,
        )
    except GenerationSelectionUnavailableError as error:
        assert isinstance(error.pair.state, Ineligible)
    else:
        raise AssertionError("admission resolver accepted unsupported Codex tool plan")

    # A configured dependency does not restore Codex's absent tool authority.
    client = httpx.AsyncClient()
    configured_runtime = compose_tool_runtime(BraveSearchProvider(client, api_key="test-key"))
    configured_snapshot = catalog_for(configured_runtime)
    assert configured_snapshot.catalog.definition_revision == snapshot.catalog.definition_revision
    assert isinstance(configured_snapshot.catalog.routes[0].readiness, Ready)
    for model in configured_snapshot.catalog.routes[0].models:
        for row in model.reasoning:
            assert isinstance(row.chat_state, Ineligible), f"{model.key}/{row.key}"
            assert isinstance(row.readiness, Ready)
    try:
        resolve_chat_selection(
            configured_snapshot,
            catalog_definition_revision=configured_snapshot.catalog.definition_revision,
            selection=selection,
        )
    except GenerationSelectionUnavailableError as error:
        assert isinstance(error.pair.state, Ineligible)
    else:
        raise AssertionError("configured tool dependency made Codex selectable")
    configured_service = GenerationService(
        catalog=cast(GenerationCatalogService, None),
        policy=GENERATION_POLICY,
        tools=configured_runtime,
    )
    configured_pair = configured_snapshot.pair(selection)
    assert configured_pair is not None
    try:
        configured_service.freeze_chat_from_pair(
            catalog_definition_revision=configured_snapshot.catalog.definition_revision,
            pair=configured_pair,
            scope=FrozenToolScope(admitted_refs=(), predicates=()),
            intent=intent,
            prompt_template_revision="test",
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="test",
                owner_id="test",
                revision="test",
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
        )
    except GenerationOperationUnavailable as error:
        assert error.reason == "text with frozen model tools is unavailable"
    else:
        raise AssertionError("direct freeze accepted Codex tool plan")
    asyncio.run(client.aclose())


if __name__ == "__main__":
    main()
