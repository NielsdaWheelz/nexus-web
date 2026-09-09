"""Canonical PostgreSQL proof for the public Codex MCP mount's outermost authority gate."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Mapping
from contextlib import AsyncExitStack
from datetime import timedelta
from importlib.util import find_spec
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    HandlerSuccess,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
)
from pydantic import SecretStr
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.agent_tools_mcp") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job
    from nexus.schemas.llm import (
        PrivacyDisclosure,
        ProcessorChain,
        SelectionPresentation,
        SubscriptionBilling,
    )
    from nexus.schemas.presence import Absent, Present
    from nexus.services.agent_tool_grants import issue_generation_tool_grant
    from nexus.services.agent_tools_mcp import (
        MAX_MCP_REQUEST_BODY_BYTES,
        MCP_GRANT_RATE_BURST,
        MCP_PATH,
        MCP_PROTOCOL_VERSION,
        MCP_SOURCE_RATE_BURST,
        ActiveAgentToolRegistry,
        AgentToolAuthority,
        create_routed_agent_tools_mcp_app,
    )
    from nexus.services.generation_selection import CodexPersonalSelection
    from nexus.services.generation_spec import (
        CodexDispatchTargetSnapshot,
        FrozenToolScope,
        GenerationBounds,
        GenerationSpec,
        GenerationSpecFacts,
        GenerationStreamBounds,
        ImmutablePromptPayloadRef,
        TextOutputSnapshot,
        generation_fact_digest,
        tool_scope_digest,
    )
    from nexus.services.llm_ledger import (
        GenerationStart,
        LlmCallOwner,
        generation_spec_document,
        start_generation_in_current_transaction,
    )
    from nexus.services.tool_authority import (
        compose_generation_tool_executor,
        read_tool_positions,
    )
    from nexus.services.tool_runtime.composition import (
        ComposedToolRuntime,
        compose_tool_runtime,
        freeze_tool_plan_snapshot,
    )
    from nexus.services.tool_runtime.declarations import (
        NEXUS_TOOL_DECLARATIONS,
        NexusSearchSuccess,
    )

_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"
_MCP_HOST = "https://mcp.nexus.example.com"
_WIRE_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def test_public_mcp_mount_admits_only_a_live_bearer_on_the_exact_protocol(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: the public MCP mount serves a bearer without live generation authority."""

    assert _CUTOVER_PRESENT, "the grant-routed agent-tools MCP mount is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_public_mcp_mount_gate(engine))


async def _prove_public_mcp_mount_gate(engine: Engine) -> None:
    invocations: list[str] = []

    async def execute_search(value: Any, context: Any) -> HandlerSuccess[NexusSearchSuccess]:
        del context
        invocations.append(value.query)
        return HandlerSuccess(
            value=NexusSearchSuccess(matches=[], total_candidates=0),
            actual_attempts=0,
        )

    runtime = _controlled_runtime({"nexus.search": execute_search})
    operation = runtime.operations["LibraryDossierRead"]
    scope = FrozenToolScope(admitted_refs=("library:proof",), predicates=())
    spec = _generation_spec(operation=operation, scope=scope)
    owner = LlmCallOwner(kind="artifact_build", id=uuid4())
    generation_id = uuid4()
    worker_id = "agent-tools-mcp-gate-proof"
    user_id = uuid4()
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    with Session(engine) as db:
        job = enqueue_job(db, kind="agent_tools_mcp_gate_proof", max_attempts=2)
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=(),
        )
        assert claimed is not None
        job_context = JobExecutionContext(
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            resource_class="Light",
        )
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=generation_id,
                owner=owner,
                spec=generation_spec_document(spec),
            ),
        )
        db.commit()

    executor = await compose_generation_tool_executor(
        session_factory=factory,
        user_id=user_id,
        owner=owner,
        generation_id=generation_id,
        job_context=job_context,
        operation=operation,
    )
    signing_key = SecretStr("agent-tools-mcp-gate-proof-signing-key-0123456789")
    registry = ActiveAgentToolRegistry(session_factory=factory)
    registry.bind_operations((operation,))
    now = await registry.database_now()
    grant_authority = executor.authority.grant_authority()
    issued = issue_generation_tool_grant(
        grant_authority,
        signing_key=signing_key,
        now=now,
        lease_expires_at=now + timedelta(seconds=240),
        transport_deadline_at=now + timedelta(seconds=120),
    )
    # Correctly signed for the same frozen authority, but never mounted: no
    # live authority owns its nonce.
    foreign = issue_generation_tool_grant(
        grant_authority,
        signing_key=signing_key,
        now=now,
        lease_expires_at=now + timedelta(seconds=240),
        transport_deadline_at=now + timedelta(seconds=120),
    )
    stale = now - timedelta(seconds=600)
    expired = issue_generation_tool_grant(
        grant_authority,
        signing_key=signing_key,
        now=stale,
        lease_expires_at=stale + timedelta(seconds=240),
        transport_deadline_at=stale + timedelta(seconds=120),
    )
    bearer = issued.token.get_secret_value()
    # Tamper the signed payload, not the signature's last base64url character:
    # that character carries two significant bits, so a lenient decoder can
    # yield byte-identical signature bytes and the token still verifies.
    header, payload, signature = bearer.split(".")
    original_claims = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
    tampered_claims = json.dumps(
        {**json.loads(original_claims), "jti": str(uuid4())},
        separators=(",", ":"),
    ).encode()
    assert tampered_claims != original_claims
    tampered = ".".join(
        (header, base64.urlsafe_b64encode(tampered_claims).decode().rstrip("="), signature)
    )
    authority = AgentToolAuthority.from_generation_tool_executor(
        executor=executor,
        registry=registry,
        grant_jti=issued.jti,
    )
    policy_violations: list[UUID] = []

    async def on_policy_violation(value: UUID) -> None:
        policy_violations.append(value)

    app = create_routed_agent_tools_mcp_app(
        registry=registry,
        signing_key=signing_key,
        on_policy_violation=on_policy_violation,
        mcp_origin=_MCP_ORIGIN,
    )
    versioned = {"MCP-Protocol-Version": MCP_PROTOCOL_VERSION}

    async with AsyncExitStack() as stack:
        await stack.enter_async_context(app.router.lifespan_context(app))

        async def source(address: str) -> httpx.AsyncClient:
            # Production reaches this mount through Caddy's single private hop,
            # so the ASGI peer is that hop and the one X-Forwarded-For names the
            # source the rate gate keys on.
            return await stack.enter_async_context(
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, client=("10.0.0.2", 40000)),
                    base_url=_MCP_HOST,
                    headers={"X-Forwarded-For": address},
                    timeout=5,
                )
            )

        live = await source("203.0.113.10")
        initialized = await _post(live, _initialize(MCP_PROTOCOL_VERSION), bearer=bearer)
        listed = await _post(live, _TOOLS_LIST, bearer=bearer, headers=versioned)
        # The model calls the library-owned wire alias it was shown, never the
        # canonical dotted id.
        called = await _post(
            live,
            _tools_call("nexus__search", "gate proof"),
            bearer=bearer,
            headers=versioned,
        )
        with factory() as db:
            positions_after_call = read_tool_positions(db, generation_id=generation_id)

        foreign_response = await _post(
            live,
            _initialize(MCP_PROTOCOL_VERSION),
            bearer=foreign.token.get_secret_value(),
        )
        tampered_response = await _post(live, _initialize(MCP_PROTOCOL_VERSION), bearer=tampered)
        expired_response = await _post(
            live,
            _initialize(MCP_PROTOCOL_VERSION),
            bearer=expired.token.get_secret_value(),
        )
        anonymous = await _post(live, _initialize(MCP_PROTOCOL_VERSION), bearer=None)

        wrong_version = await _post(live, _initialize("2025-03-26"), bearer=bearer)
        unversioned = await _post(live, _TOOLS_LIST, bearer=bearer)
        sessioned = await _post(
            live,
            _TOOLS_LIST,
            bearer=bearer,
            headers={**versioned, "Mcp-Session-Id": "client-chosen-session"},
        )
        oversized = await _post(
            live,
            b"{" + b" " * MAX_MCP_REQUEST_BODY_BYTES + b"}",
            bearer=bearer,
            headers=versioned,
        )

        burst = await source("203.0.113.20")
        burst_statuses = [
            (await _post(burst, b"{}", bearer="not-a-grant")).status_code
            for _ in range(MCP_SOURCE_RATE_BURST + 1)
        ]
        # Three authenticated requests already landed for this grant; spread the
        # remainder across sources so only the per-grant window can trip.
        alternating = (await source("203.0.113.30"), await source("203.0.113.31"))
        admitted_statuses = [
            (
                await _post(
                    alternating[index % 2],
                    _initialize(MCP_PROTOCOL_VERSION),
                    bearer=bearer,
                )
            ).status_code
            for index in range(MCP_GRANT_RATE_BURST - 3)
        ]
        throttled = await _post(
            await source("203.0.113.32"),
            _initialize(MCP_PROTOCOL_VERSION),
            bearer=bearer,
        )
    with factory() as db:
        final_positions = read_tool_positions(db, generation_id=generation_id)
    authority.close()
    registry.unbind_operations((operation,))

    # Every assertion runs after the streamable-HTTP task group has closed, so a
    # failure surfaces as one top-level AssertionError rather than an
    # ExceptionGroup wrapped by the transport's lifespan.
    assert initialized.status_code == 200, initialized.text
    assert initialized.json()["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION
    assert initialized.json()["result"]["serverInfo"]["name"] == "nexus"
    assert listed.status_code == 200, listed.text
    published = [tool["name"] for tool in listed.json()["result"]["tools"]]
    assert "nexus__search" in published, published
    assert called.status_code == 200, called.text
    assert called.json()["result"]["isError"] is False, called.text
    receipt = json.loads(called.json()["result"]["content"][0]["text"])
    assert receipt["type"] == "Success", receipt
    assert [
        (position.path, position.transport_kind, position.replay_status)
        for position in positions_after_call
    ] == [("generation/1/tool/1", "CodexMcp", "Completed")]

    assert foreign_response.status_code == 401, (
        "an unauthorized grant crossed the public MCP mount: a signed grant with no "
        f"mounted authority received HTTP {foreign_response.status_code}"
    )
    assert tampered_response.status_code == 401, tampered_response.status_code
    assert expired_response.status_code == 401, expired_response.status_code
    assert anonymous.status_code == 401, anonymous.status_code
    assert policy_violations == []

    assert wrong_version.status_code == 400, wrong_version.status_code
    assert unversioned.status_code == 400, unversioned.status_code
    assert sessioned.status_code == 400, sessioned.status_code
    assert oversized.status_code == 413, oversized.status_code

    assert burst_statuses == [401] * MCP_SOURCE_RATE_BURST + [429], burst_statuses[-3:]
    assert admitted_statuses == [200] * (MCP_GRANT_RATE_BURST - 3), admitted_statuses
    assert throttled.status_code == 429, throttled.status_code

    assert len(final_positions) == 1
    assert invocations == ["gate proof"]


async def _post(
    client: httpx.AsyncClient,
    body: bytes,
    *,
    bearer: str | None,
    headers: Mapping[str, str] | None = None,
) -> httpx.Response:
    wire = {**_WIRE_HEADERS, **(headers or {})}
    if bearer is not None:
        wire["Authorization"] = f"Bearer {bearer}"
    return await client.post(MCP_PATH, content=body, headers=wire)


def _initialize(protocol_version: str) -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "agent-tools-mcp-gate-proof", "version": "1"},
            },
        }
    ).encode()


_TOOLS_LIST = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}).encode()


def _tools_call(wire_name: str, query: str) -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": wire_name,
                "arguments": {
                    "authors": None,
                    "formats": None,
                    "kinds": None,
                    "limit": None,
                    "query": query,
                    "roles": None,
                    "scopes": None,
                },
            },
        }
    ).encode()


def _controlled_runtime(handlers: Mapping[str, Any]) -> ComposedToolRuntime:
    async def unexpected(value: Any, context: Any) -> HandlerSuccess[Any]:
        del value, context
        raise AssertionError("proof dispatched a tool outside its controlled handler set")

    nexus_bindings = tuple(
        ToolBinding(
            spec=entry.spec,
            execute=Available(handlers.get(str(entry.spec.id), unexpected)),
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision="test_agent_tools_mcp_gate.v1",
            policy_epoch=PolicyEpoch("agent-tools-mcp-gate-proof-v1"),
            policy_inputs={"owner": "agent-tools-mcp-gate-proof"},
        )
        for entry in NEXUS_TOOL_DECLARATIONS
    )
    return compose_tool_runtime(
        ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Available(unexpected),
            replay_policy=ReplayPolicy.BilledOnce,
            implementation_revision="test_agent_tools_mcp_gate.v1",
            policy_epoch=PolicyEpoch("agent-tools-mcp-gate-proof-v1"),
            policy_inputs={"owner": "agent-tools-mcp-gate-proof"},
        ),
        nexus_bindings=nexus_bindings,
    )


def _generation_spec(*, operation: Any, scope: FrozenToolScope) -> GenerationSpec:
    output = TextOutputSnapshot()
    facts = GenerationSpecFacts(
        operation="dossier_library",
        selection=CodexPersonalSelection(
            route="CodexPersonal",
            model="gpt-5.6-terra",
            reasoning="medium",
        ),
        selection_source="BackgroundPolicy",
        resolved_dispatch_target=CodexDispatchTargetSnapshot(
            model_key="gpt-5.6-terra",
            dispatch_model="gpt-5.6-terra",
            agent_definition_revision="agent-tools-mcp-gate-agent.v1",
        ),
        source_catalog_definition_revision="agent-tools-mcp-gate-catalog.v1",
        source_row_fingerprint=generation_fact_digest("source-row"),
        agent_definition_revision=Present(value="agent-tools-mcp-gate-agent.v1"),
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
        prompt_template_revision="agent-tools-mcp-gate.prompt.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="artifact_build",
            owner_id="proof",
            revision="agent-tools-mcp-gate.prompt.v1",
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
        tool_effect_mode=Present(value="ReadOnly"),
        admitted_tool_scope=Present(value=scope),
        admitted_tool_scope_digest=Present(value=tool_scope_digest(scope)),
        catalog_definition_revision=generation_fact_digest("catalog"),
        policy_revision="agent-tools-mcp-gate-policy.v1",
        backend_contract_revision="agent-tools-mcp-gate-backend.v1",
        provider_registry_revision=Absent(),
    )
    return GenerationSpec.freeze(facts)
