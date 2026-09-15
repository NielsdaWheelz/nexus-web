"""One compositional proof for catalog completeness and exact selection."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from provider_runtime import Credentials
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import Present as RuntimePresent

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_catalog") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime.agent_runtime import (
        AGENT_BACKEND_CONTRACT_REVISION,
        AgentModelCatalog,
        AgentModelFacts,
        AgentReasoningFacts,
    )
    from provider_runtime.registry import api_model_catalog

    from nexus.auth.middleware import Viewer, get_viewer
    from nexus.errors import ApiError
    from nexus.responses import api_error_handler
    from nexus.schemas.llm import Ready, Selectable, TemporarilyUnavailable
    from nexus.schemas.presence import Absent, Present
    from nexus.services import generation_policy
    from nexus.services.generation_catalog import (
        CatalogDefinitionStaleError,
        GenerationCatalogRefreshError,
        GenerationCatalogService,
        GenerationSelectionUnavailableError,
        InvalidGenerationSelectionError,
        ReasoningWireQualificationReceipt,
        TargetQualificationReceipt,
        ToolPlanQualification,
        compose_generation_catalog,
        production_catalog_readiness,
        qualification_snapshot,
        readiness_snapshot,
        resolve_chat_selection,
        source_controlled_qualification_snapshot,
        validate_background_policy,
    )
    from nexus.services.generation_selection import (
        CodexPersonalSelection,
        ProviderApiSelection,
        ProviderReasoningLevel,
        selection_fingerprint,
    )
    from nexus.services.tool_runtime.profiles import tool_plan_policy_facts

_NOW = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
_PROVIDERS = (
    "openai",
    "anthropic",
    "gemini",
    "moonshot",
    "openrouter",
    "deepseek",
    "xai",
)
_API_MODEL_REFS = (
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


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _agent_catalog() -> AgentModelCatalog:
    rows = []
    for key, default in (
        ("gpt-5.6-luna", "low"),
        ("gpt-5.6-terra", "medium"),
        ("gpt-5.6-sol", "high"),
    ):
        rows.append(
            AgentModelFacts(
                key=key,
                dispatch_model=key,
                label=" ".join(part.title() for part in key.split("-")),
                source_context_window=RuntimeAbsent(),
                source_max_output_tokens=RuntimeAbsent(),
                input_modalities=("text", "image"),
                reasoning=tuple(
                    AgentReasoningFacts(
                        key=level,
                        label=level.title(),
                        native_wire_value=level,
                    )
                    for level in ("low", "medium", "high")
                ),
                source_default_reasoning=RuntimePresent(default),
                upgrade=RuntimeAbsent(),
                retirement=RuntimeAbsent(),
                row_fingerprint=_digest(f"agent-row:{key}"),
            )
        )
    return AgentModelCatalog(
        backend_contract_revision=AGENT_BACKEND_CONTRACT_REVISION,
        definition_revision=_digest("agent-definition"),
        native_revision=RuntimeAbsent(),
        observed_at=_NOW,
        models=tuple(rows),
        diagnostics=(),
    )


def _selection_rows(agent: AgentModelCatalog) -> tuple[tuple[str, str, object], ...]:
    rows: list[tuple[str, str, object]] = []
    for model in agent.models:
        target_key = f"CodexPersonal:{model.key}"
        for reasoning in model.reasoning:
            rows.append(
                (
                    target_key,
                    model.row_fingerprint,
                    CodexPersonalSelection(
                        route="CodexPersonal",
                        model=model.key,
                        reasoning=reasoning.key,
                    ),
                )
            )
    for model in api_model_catalog().models:
        target_key = f"ProviderApi:{model.model_ref}"
        for reasoning in model.reasoning:
            rows.append(
                (
                    target_key,
                    model.row_fingerprint,
                    ProviderApiSelection(
                        route="ProviderApi",
                        model_ref=model.model_ref,
                        reasoning=reasoning.key,
                    ),
                )
            )
    return tuple(rows)


def _qualifications(agent: AgentModelCatalog):
    selection_rows = _selection_rows(agent)
    plan_facts = tool_plan_policy_facts()
    tool_qualifications = tuple(
        ToolPlanQualification(
            output_contract="Text" if index < 2 else "StrictJson",
            authority_revision=item.authority_revision,
        )
        for index, item in enumerate(plan_facts)
    )
    row_by_target: dict[str, str] = {}
    for target_key, row_fingerprint, _selection in selection_rows:
        row_by_target[target_key] = row_fingerprint
    return qualification_snapshot(
        targets=tuple(
            TargetQualificationReceipt(
                target_key=target_key,
                source_row_fingerprint=row_fingerprint,
                capabilities=("Text", "StrictStructured", "ToolsContinuation"),
                tool_plan_qualifications=tool_qualifications,
                revision=_digest(f"target-qualification:{target_key}"),
            )
            for target_key, row_fingerprint in row_by_target.items()
        ),
        reasoning=tuple(
            ReasoningWireQualificationReceipt(
                selection_fingerprint=selection_fingerprint(selection),
                source_row_fingerprint=row_fingerprint,
                revision=_digest(f"reasoning-qualification:{selection_fingerprint(selection)}"),
            )
            for _target_key, row_fingerprint, selection in selection_rows
        ),
    )


def _readiness(*, unavailable_target: str | None = None):
    ready = Ready(last_checked=_NOW)
    unavailable = TemporarilyUnavailable(
        code="provider_unavailable",
        explanation="The provider health check failed.",
        action="Retry after provider health recovers.",
        last_checked=_NOW,
    )
    return readiness_snapshot(
        observed_at=_NOW,
        routes={
            "CodexPersonal": ready,
            **{f"ProviderApi:{provider}": ready for provider in _PROVIDERS},
        },
        targets={unavailable_target: unavailable} if unavailable_target else {},
    )


def _compose(*, unavailable_target: str | None = None):
    agent = _agent_catalog()
    return compose_generation_catalog(
        agent_catalog=agent,
        api_catalog=api_model_catalog(),
        configured_api_providers=_PROVIDERS,
        qualifications=_qualifications(agent),
        readiness=_readiness(unavailable_target=unavailable_target),
        policy=generation_policy.GENERATION_POLICY,
        now=_NOW,
    )


def test_complete_catalog_and_selection_contract() -> None:
    """Risk: catalog drift reintroduces profiles, partial rows, or pair fallback."""

    assert _CUTOVER_PRESENT, "the final generation catalog owner is absent"
    snapshot = _compose()
    catalog = snapshot.catalog
    assert tuple(route.route.kind for route in catalog.routes) == (
        "CodexPersonal",
        *("ProviderApi" for _provider in _PROVIDERS),
    )
    assert (
        tuple(
            model.key
            for route in catalog.routes
            if route.route.kind == "ProviderApi"
            for model in route.models
        )
        == _API_MODEL_REFS
    )
    assert tuple(model.key for model in catalog.routes[0].models) == (
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
    )
    assert all(
        isinstance(model.source_context_window, Absent)
        and isinstance(model.source_max_output_tokens, Absent)
        for model in catalog.routes[0].models
    )
    assert all(
        isinstance(row.chat_state, Selectable)
        for route in catalog.routes
        for model in route.models
        for row in model.reasoning
    )
    assert len(snapshot.pairs) == sum(
        len(model.reasoning) for route in catalog.routes for model in route.models
    )
    assert catalog.chat_seed.selection == generation_policy.GENERATION_POLICY.chat.seed
    assert catalog.chat_seed.policy_revision == generation_policy.POLICY_REVISION
    validate_background_policy(snapshot, policy=generation_policy.GENERATION_POLICY)

    for model in catalog.routes[0].models:
        assert model.effective_chat_context_budget_tokens == 400_000
        assert model.effective_chat_output_budget_tokens == 32_000
        assert isinstance(model.source_context_window, Absent)

    openrouter = next(
        model
        for route in catalog.routes
        for model in route.models
        if model.key == "openrouter:kimi-k3"
    )
    assert isinstance(openrouter.source_default_reasoning, Absent)


def test_readiness_is_volatile_and_exact_selection_never_substitutes() -> None:
    ready = _compose()
    unavailable_target = "ProviderApi:xai:grok-4.5"
    unavailable = _compose(unavailable_target=unavailable_target)
    assert unavailable.catalog.definition_revision == ready.catalog.definition_revision

    selection = ProviderApiSelection(
        route="ProviderApi",
        model_ref="xai:grok-4.5",
        reasoning="high",
    )
    with pytest.raises(GenerationSelectionUnavailableError) as observed:
        resolve_chat_selection(
            unavailable,
            catalog_definition_revision=unavailable.catalog.definition_revision,
            selection=selection,
        )
    assert observed.value.pair.selection == selection
    assert observed.value.pair.state.kind == "TemporarilyUnavailable"

    with pytest.raises(CatalogDefinitionStaleError):
        resolve_chat_selection(
            ready,
            catalog_definition_revision="0" * 64,
            selection=generation_policy.GENERATION_POLICY.chat.seed,
        )

    unsupported = ProviderApiSelection(
        route="ProviderApi",
        model_ref="xai:grok-4.5",
        reasoning=cast(ProviderReasoningLevel, "max"),
    )
    with pytest.raises(InvalidGenerationSelectionError):
        resolve_chat_selection(
            ready,
            catalog_definition_revision=ready.catalog.definition_revision,
            selection=unsupported,
        )


def test_configured_provider_filter_is_exact_and_not_a_marketplace() -> None:
    agent = _agent_catalog()
    snapshot = compose_generation_catalog(
        agent_catalog=agent,
        api_catalog=api_model_catalog(),
        configured_api_providers=("openai",),
        qualifications=_qualifications(agent),
        readiness=readiness_snapshot(
            observed_at=_NOW,
            routes={
                "CodexPersonal": Ready(last_checked=_NOW),
                "ProviderApi:openai": Ready(last_checked=_NOW),
            },
        ),
        policy=generation_policy.GENERATION_POLICY,
        now=_NOW,
    )
    assert tuple(route.route.kind for route in snapshot.catalog.routes) == (
        "CodexPersonal",
        "ProviderApi",
    )
    assert tuple(model.key for model in snapshot.catalog.routes[1].models) == (
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
    )
    assert all(
        isinstance(model.source_context_window, Present)
        for model in snapshot.catalog.routes[1].models
    )


def test_catalog_service_owns_freshness_and_preserves_only_stale_chat_decode() -> None:
    asyncio.run(_prove_catalog_service_freshness())


async def _prove_catalog_service_freshness() -> None:
    agent = _agent_catalog()
    now = [_NOW]
    agent_reads = 0
    readiness_reads = 0
    fail_readiness = False

    async def load_agent_catalog() -> AgentModelCatalog:
        nonlocal agent_reads
        agent_reads += 1
        return agent

    async def load_readiness():
        nonlocal readiness_reads
        readiness_reads += 1
        if fail_readiness:
            raise OSError("provider health unavailable")
        ready = Ready(last_checked=now[0])
        return readiness_snapshot(
            observed_at=now[0],
            routes={
                "CodexPersonal": ready,
                "ProviderApi:openai": ready,
            },
        )

    service = GenerationCatalogService(
        configured_api_providers=("openai",),
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=load_agent_catalog,
        load_qualifications=lambda: _qualifications(agent),
        load_readiness=load_readiness,
        clock=lambda: now[0],
    )
    initial = await service.startup()
    cached = await service.read_chat()
    assert cached is not initial
    assert cached.catalog.definition_revision == initial.catalog.definition_revision
    assert (agent_reads, readiness_reads) == (1, 1)

    now[0] += timedelta(seconds=61)
    fail_readiness = True
    stale = await service.read_chat()
    assert stale.catalog.definition_revision == initial.catalog.definition_revision
    assert stale.catalog.chat_seed.state.kind == "TemporarilyUnavailable"
    with pytest.raises(GenerationCatalogRefreshError):
        await service.read_for_admission()

    fail_readiness = False
    recovered = await service.read_for_admission()
    assert recovered.catalog.chat_seed.state.kind == "Selectable"
    assert readiness_reads == 4

    now[0] += timedelta(seconds=301)
    await service.read_chat()
    assert agent_reads == 2


def test_source_controlled_receipts_fail_closed_on_source_drift() -> None:
    """Risk: evidence for one transport composition gets generalized to another."""

    qualifications = source_controlled_qualification_snapshot()
    api_catalog = api_model_catalog()
    assert {
        receipt.target_key
        for receipt in qualifications.targets
        if receipt.target_key.startswith("ProviderApi:")
    } == {f"ProviderApi:{model.model_ref}" for model in api_catalog.models}
    for model in api_catalog.models:
        receipt = qualifications.target(f"ProviderApi:{model.model_ref}")
        assert receipt is not None
        assert receipt.source_row_fingerprint == model.row_fingerprint
        for reasoning in model.reasoning:
            selection = ProviderApiSelection(
                route="ProviderApi",
                model_ref=model.model_ref,
                reasoning=reasoning.key,
            )
            wire_receipt = qualifications.reasoning_for(selection)
            assert wire_receipt is not None
            assert wire_receipt.source_row_fingerprint == model.row_fingerprint

    provider = qualifications.target("ProviderApi:openai:gpt-5.6-sol")
    assert provider is not None
    assert provider.revision.startswith("nexus.provider-loopback-conformance.v1:")
    assert provider.qualifies_tool_plan(
        output_contract="Text",
        authority_revision=tool_plan_policy_facts()[0].authority_revision,
    )
    assert not provider.qualifies_tool_plan(
        output_contract="StrictJson",
        authority_revision=tool_plan_policy_facts()[2].authority_revision,
    )

    drifted_agent = _agent_catalog()
    snapshot = compose_generation_catalog(
        agent_catalog=drifted_agent,
        api_catalog=api_model_catalog(),
        configured_api_providers=_PROVIDERS,
        qualifications=qualifications,
        readiness=_readiness(),
        policy=generation_policy.GENERATION_POLICY,
        now=_NOW,
    )
    codex_rows = snapshot.catalog.routes[0].models
    assert all(
        row.chat_state.kind == "Ineligible" for model in codex_rows for row in model.reasoning
    )
    assert all(
        row.chat_state.kind == "Selectable"
        for route in snapshot.catalog.routes[1:]
        for model in route.models
        for row in model.reasoning
    )
    with pytest.raises(AssertionError, match="^metadata_enrichment tool plan is not qualified$"):
        validate_background_policy(snapshot, policy=generation_policy.GENERATION_POLICY)


class _HealthyCodexClient:
    async def health(self) -> object:
        return object()


def test_production_readiness_checks_host_and_credential_presence_only() -> None:
    """Risk: catalog reads accidentally spend provider quota or conceal a missing key."""

    snapshot = asyncio.run(
        production_catalog_readiness(
            codex_client=_HealthyCodexClient(),
            credentials=Credentials(openai="configured"),
            configured_api_providers=("openai", "xai"),
            observed_at=_NOW,
        )
    )
    assert snapshot.route("CodexPersonal").kind == "Ready"
    assert snapshot.route("ProviderApi:openai").kind == "Ready"
    assert snapshot.route("ProviderApi:xai").kind == "OperatorActionRequired"


def _catalog_api(service: GenerationCatalogService) -> FastAPI:
    from nexus.api.routes.llm import router as llm_router

    app = FastAPI()
    app.add_exception_handler(ApiError, api_error_handler)
    app.include_router(llm_router)
    app.state.generation_catalog_service = service
    app.dependency_overrides[get_viewer] = lambda: Viewer(
        user_id=uuid4(),
        default_library_id=uuid4(),
    )
    return app


def test_llm_catalog_route_returns_strict_private_snapshot() -> None:
    """Risk: the public wire diverges from the process-owned catalog snapshot."""

    agent = _agent_catalog()

    async def load_agent_catalog() -> AgentModelCatalog:
        return agent

    async def load_readiness():
        return readiness_snapshot(
            observed_at=_NOW,
            routes={
                "CodexPersonal": Ready(last_checked=_NOW),
                "ProviderApi:openai": Ready(last_checked=_NOW),
            },
        )

    catalog_service = GenerationCatalogService(
        configured_api_providers=("openai",),
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=load_agent_catalog,
        load_qualifications=lambda: _qualifications(agent),
        load_readiness=load_readiness,
        clock=lambda: _NOW,
    )
    with TestClient(_catalog_api(catalog_service)) as client:
        response = client.get("/llm-catalog")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert set(response.json()) == {"data"}
    assert set(response.json()["data"]) == {
        "definition_revision",
        "observed_at",
        "chat_seed",
        "routes",
    }
    assert tuple(
        model["key"]
        for route in response.json()["data"]["routes"]
        if route["route"]["kind"] == "ProviderApi"
        for model in route["models"]
    ) == (
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
    )


def test_llm_catalog_route_maps_source_failure_without_leaking_detail() -> None:
    """Risk: host/catalog failures escape as raw transport or exception details."""

    async def unavailable_agent_catalog() -> AgentModelCatalog:
        raise OSError("sensitive local transport detail")

    async def unused_readiness():
        raise AssertionError("readiness must not run after definition failure")

    service = GenerationCatalogService(
        configured_api_providers=(),
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=unavailable_agent_catalog,
        load_qualifications=source_controlled_qualification_snapshot,
        load_readiness=unused_readiness,
    )
    with TestClient(_catalog_api(service)) as client:
        response = client.get("/llm-catalog")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "E_GENERATION_RUNTIME_UNAVAILABLE"
    assert "sensitive local transport detail" not in response.text
