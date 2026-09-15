"""Cross-route credential and continuation isolation through real service peers."""

from __future__ import annotations

import asyncio
import json
import os
import ssl
from importlib.util import find_spec
from pathlib import Path
from uuid import UUID, uuid4

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = all(
    find_spec(module) is not None
    for module in (
        "nexus.services.generation_continuations",
        "nexus.services.generation_service",
        "nexus.services.provider_generation_backend",
    )
)


def test_route_secrets_and_continuations_never_cross_boundaries(tmp_path: Path) -> None:
    """Prove route projections and the complete ProviderApi request boundary.

    Native Codex process environment/argv rejection remains owned by
    ``test_codex_runtime_confinement.py``. Bearer claims, lease fences, and MCP
    consumption remain owned by ``test_generation_tool_authority.py`` and
    ``test_agent_tool_grants.py``. This node composes their sensitive values
    with both real route projections and observes ProviderApi headers and bodies
    at the controller-owned TLS protocol peer without duplicating those owners.
    """

    assert _CUTOVER_PRESENT, "the route-neutral generation secret boundary is absent"
    asyncio.run(_prove_route_secret_isolation(tmp_path))


async def _prove_route_secret_isolation(tmp_path: Path) -> None:
    import httpx
    from apps.codex_agent.host import RuntimeVersions, _terminal_to_wire
    from provider_runtime.agent_runtime import (
        AgentFailure,
        AgentSessionRef,
        AgentTerminal,
        CredentialRef,
    )
    from provider_runtime.types import Succeeded

    from nexus.config import Settings
    from nexus.services import generation_policy
    from nexus.services.codex_generation_operations import resolve_codex_generation
    from nexus.services.generation_continuations import (
        GenerationContinuationContext,
    )
    from nexus.services.generation_intent import GenerationIntent, TextOutput
    from nexus.services.generation_service import GenerationService
    from nexus.services.generation_spec import (
        FrozenToolScope,
        ImmutablePromptPayloadRef,
        generation_fact_digest,
    )
    from nexus.services.llm_credentials import (
        generation_continuation_cipher,
        provider_generation_credentials,
    )
    from nexus.services.provider_generation_backend import (
        ProviderGenerationWiring,
        build_provider_generation_backend,
    )
    from nexus.services.provider_generation_contract import ProviderTerminal
    from nexus.services.tool_runtime.composition import (
        compose_provider_model_tools,
        freeze_tool_plan_snapshot,
    )
    from tests.testkit.codex_generation import (
        codex_generation_command,
        codex_model_tool_fixture,
    )
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime
    from tests.testkit.provider_api_server import (
        GENERATION_SECRET_ISOLATION_SENTINELS,
    )

    sentinels = dict(GENERATION_SECRET_ISOLATION_SENTINELS)
    settings = Settings()
    continuation_key = settings.effective_generation_continuation_encryption_key.get_secret_value()
    assert continuation_key == sentinels["continuation_key"], (
        "the provider peer is not observing the controller-owned continuation key"
    )
    provider_secrets: list[str] = []
    for provider in settings.generation_api_provider_list:
        credential = getattr(settings, f"{provider}_generation_api_key")
        assert credential is not None
        provider_secrets.append(credential.get_secret_value())
    assert provider_secrets and all(provider_secrets)
    credentials = provider_generation_credentials(settings)
    assert all(secret not in repr(credentials) for secret in provider_secrets)

    codex_registry, codex_tools = codex_model_tool_fixture()
    codex_operation = codex_tools.operations["ChatRead"]
    command = codex_generation_command(
        request_id=UUID(int=701),
        operation="chat",
        instructions="Use only the frozen read tools.",
        input_text="Return a bounded secret-isolation fixture response.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        model_tool_plan=freeze_tool_plan_snapshot(codex_operation),
        tool_grant=sentinels["codex_tool_bearer"],
    )
    resolved_codex = resolve_codex_generation(
        command,
        working_directory=tmp_path,
        model_tool_registry=codex_registry,
        mcp_origin="https://mcp.nexus.example.test/internal/agent-tools/mcp",
        tool_credential=CredentialRef(
            kind="secret_reference",
            profile_key="codex-personal",
            name="generation-secret-isolation-grant-ref",
        ),
    )
    assert resolved_codex.session.auth == CredentialRef(
        kind="local_account",
        profile_key="codex-personal",
    )
    codex_child_projection = json.dumps(
        {
            "command": command.model_dump(mode="json"),
            "resolved_session": repr(resolved_codex.session),
            "resolved_turn": repr(resolved_codex.turn),
        },
        default=str,
        sort_keys=True,
    )
    assert all(secret not in codex_child_projection for secret in provider_secrets), (
        "a ProviderApi credential entered Codex command/session/turn input"
    )
    assert sentinels["codex_auth"] not in codex_child_projection
    assert sentinels["codex_tool_bearer"] not in codex_child_projection
    assert sentinels["codex_tool_bearer"] not in repr(command)

    continuation_context = GenerationContinuationContext(
        generation_id=UUID(int=702),
        source_turn_seq=1,
        successor_turn_seq=2,
        target_fingerprint="a" * 64,
        codec_id="secret-isolation.v1",
        policy_revision="generation-secret-isolation.v1",
    )
    sealed = generation_continuation_cipher(settings).seal(
        canonical_continuation=sentinels["continuation_payload"].encode(),
        context=continuation_context,
    )
    assert sentinels["continuation_payload"] not in repr(sealed)
    assert sentinels["continuation_key"] not in repr(sealed)

    failed = AgentTerminal(
        status="failed",
        failure=AgentFailure("backend_failed"),
        final_text=sentinels["codex_failure_text"],
        structured_output=None,
        session_ref=AgentSessionRef(
            schema_version="agent-session-ref.v1",
            backend="codex",
            transport="sdk",
            native_session_id="generation-secret-isolation-session",
            profile_key="codex-personal",
            state_root_fingerprint="1" * 64,
            cwd_fingerprint="2" * 64,
        ),
        diagnostics=(sentinels["codex_diagnostic"],),
    )
    redacted_terminal = _terminal_to_wire(
        failed,
        operation=resolved_codex,
        accepted_at="2026-08-31T12:34:56.123456Z",
        versions=RuntimeVersions(sdk="secret-isolation", runtime="secret-isolation"),
    )
    diagnostic_projection = redacted_terminal.model_dump_json() + repr(redacted_terminal)
    assert sentinels["codex_failure_text"] not in diagnostic_projection
    assert sentinels["codex_diagnostic"] not in diagnostic_projection
    assert redacted_terminal.diagnostics == (
        "codex generation host turn_stream: runtime terminal backend_failed",
    )

    endpoint_overrides = _controller_endpoint_overrides()
    tls_context = ssl.create_default_context(cafile=_controller_ca_certificate())
    product_tools = compose_available_product_tool_runtime()
    catalog = configured_chat_catalog_service()
    catalog_snapshot = await catalog.read_for_admission()
    pair = catalog_snapshot.pair(CHAT_TEST_SELECTION)
    assert pair is not None, "the controlled OpenAI Chat row is absent"
    intent = GenerationIntent(
        instructions="Return the exact requested fixture response.",
        input="NEXUS_PROVIDER_SCENARIO=text secret-isolation",
        output=TextOutput(),
    )
    admission = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=product_tools,
    )
    spec = admission.freeze_chat_from_pair(
        catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
        pair=pair,
        tool_authority="ReadOnly",
        scope=FrozenToolScope(admitted_refs=(), predicates=()),
        intent=intent,
        prompt_template_revision="generation-secret-isolation.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="generation-secret-isolation-proof",
            owner_id="provider-route",
            revision="v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
    )
    model_tool_operation = admission.model_tool_operation(spec)
    assert model_tool_operation is not None
    model_tools = compose_provider_model_tools(model_tool_operation)

    async with httpx.AsyncClient(
        verify=tls_context,
        timeout=httpx.Timeout(10.0),
        trust_env=False,
    ) as client:
        provider = build_provider_generation_backend(
            settings,
            client,
            wiring=ProviderGenerationWiring(endpoint_overrides=endpoint_overrides),
        )
        turn = provider.prepare_initial_turn(
            generation_id=uuid4(),
            spec=spec,
            intent=intent,
            model_tools=model_tools,
        )
        events = [event async for event in provider.stream_turn(turn)]
        terminal = events[-1]
        assert isinstance(terminal, ProviderTerminal)
        assert isinstance(terminal.outcome, Succeeded)

        observation_response = await client.get(
            f"{endpoint_overrides['openai']}/_test/generation-secret-observations"
        )
        observation_response.raise_for_status()
        observations = observation_response.json()

    provider_log_projection = "\n".join(
        (repr(credentials), repr(turn), *(repr(event) for event in events))
    )
    assert all(sentinel not in provider_log_projection for sentinel in sentinels.values()), (
        "Codex or continuation secret material entered a ProviderApi log-safe projection"
    )
    assert observations["request_count"] >= 1
    assert observations["authorization_header_seen"] is True
    assert set(observations["sentinels"]) == set(sentinels)
    assert all(
        locations == {"body": False, "headers": False}
        for locations in observations["sentinels"].values()
    ), "Codex or continuation secret material entered ProviderApi headers or body"


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
