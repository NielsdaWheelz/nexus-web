"""Canonical PostgreSQL proof for route-neutral model-tool authority."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from importlib.util import find_spec
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

import pytest
from llm_tools import (
    ExecutorConfigurationDefect,
    HandlerSuccess,
    ParsedJson,
    ToolId,
    raw_input_digest,
)
from provider_runtime.tool_adapter import CanonicalToolCall
from pydantic import SecretStr
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from tests.testkit.generation_tool_authority import (
    controlled_tool_runtime,
    generation_tool_spec,
    search_arguments,
)

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.tool_authority") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from mcp.shared.exceptions import MCPError

    from nexus.db.models import ArtifactBuild, SynthesisArtifact
    from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job, fail_job
    from nexus.services import bootstrap
    from nexus.services.agent_tool_grants import (
        issue_generation_tool_grant,
        verify_agent_tool_grant,
    )
    from nexus.services.agent_tools_mcp import (
        ActiveAgentToolRegistry,
        AgentToolAuthority,
        JsonRpcId,
    )
    from nexus.services.artifacts.bindings._shared import Candidate
    from nexus.services.artifacts.model_tools import (
        DossierToolExecutionProjection,
        dossier_candidates_from_ledger,
    )
    from nexus.services.generation_backend import BackendToolExecutionRequest
    from nexus.services.generation_spec import (
        FrozenToolScope,
        generation_fact_digest,
    )
    from nexus.services.llm_ledger import (
        GenerationStart,
        LlmCallOwner,
        generation_spec_document,
        start_generation_in_current_transaction,
    )
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_graph.schemas import CitationSnapshot
    from nexus.services.tool_authority import (
        ToolAuthorityRefused,
        compose_deferred_generation_tool_executor,
        compose_generation_tool_executor,
        read_tool_positions,
    )
    from nexus.services.tool_runtime.declarations import (
        NexusEvidence,
        NexusSearchSuccess,
        ResourceReadSuccess,
    )
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime


def test_frozen_plan_is_transport_neutral_and_fenced(
    request: pytest.FixtureRequest,
) -> None:
    """Codex and API calls share ordering, replay, authority, and refusal semantics."""

    assert _CUTOVER_PRESENT, "the route-neutral generation tool authority is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_frozen_plan_is_transport_neutral_and_fenced(engine))


async def _prove_frozen_plan_is_transport_neutral_and_fenced(engine: Engine) -> None:
    invocations: list[str] = []

    async def execute_search(value: Any, context: Any) -> HandlerSuccess[NexusSearchSuccess]:
        del context
        invocations.append(value.query)
        return HandlerSuccess(
            value=NexusSearchSuccess(matches=[], total_candidates=0),
            actual_attempts=0,
        )

    runtime = controlled_tool_runtime({"nexus.search": execute_search})
    operation = runtime.operations["LibraryDossierRead"]
    scope = FrozenToolScope(admitted_refs=("library:proof",), predicates=())
    spec = generation_tool_spec(operation=operation, scope=scope)
    owner = LlmCallOwner(kind="artifact_build", id=uuid4())
    generation_id = uuid4()
    worker_id = "generation-tool-authority-proof"
    user_id = uuid4()
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    with Session(engine) as db:
        job = enqueue_job(db, kind="generation_tool_authority_proof", max_attempts=2)
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
        deferred_provider_executor = compose_deferred_generation_tool_executor(
            session_factory=factory,
            user_id=user_id,
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            operation=operation,
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
    signing_key = SecretStr("generation-tool-authority-proof-signing-key")
    now = datetime.now(UTC)
    issued = issue_generation_tool_grant(
        executor.authority.grant_authority(),
        signing_key=signing_key,
        now=now,
        lease_expires_at=now + timedelta(seconds=240),
        transport_deadline_at=now + timedelta(seconds=120),
    )
    claims = verify_agent_tool_grant(
        issued.token,
        signing_key=signing_key,
        now=now,
    )
    registry = ActiveAgentToolRegistry(session_factory=factory)
    registry.bind_operations((operation,))
    mcp_authority = AgentToolAuthority.from_generation_tool_executor(
        executor=executor,
        registry=registry,
        grant_jti=issued.jti,
    )
    policy_violations: list[str] = []

    async def on_policy_violation(value: Any) -> None:
        policy_violations.append(str(value))

    arguments_a = search_arguments("Codex transport")
    codex = await mcp_authority.invoke(
        claims=claims,
        on_policy_violation=on_policy_violation,
        request_id=JsonRpcId.integer(1),
        provider_wire_name="nexus_search",
        tool_id="nexus.search",
        arguments=arguments_a,
    )
    arguments_b = search_arguments("Provider transport")
    provider_request = BackendToolExecutionRequest(
        generation_id=generation_id,
        child_seq=2,
        proposal=CanonicalToolCall(
            provider_call_id="provider-call-1",
            tool_id=ToolId("nexus.search"),
            arguments=arguments_b,
        ),
    )
    provider = await deferred_provider_executor.execute(provider_request)
    replayed = await deferred_provider_executor.execute(provider_request)

    assert codex.model_output.output == provider.output == replayed.output
    assert not codex.model_output.is_error
    assert not provider.is_error
    assert invocations == ["Codex transport", "Provider transport"]
    with factory() as db:
        positions = read_tool_positions(db, generation_id=generation_id)
    assert [position.path for position in positions] == [
        "generation/1/tool/1",
        "generation/1/tool/2",
    ]
    assert [position.transport_kind for position in positions] == ["CodexMcp", "ProviderApi"]
    assert [position.model_turn_seq for position in positions] == [1, 2]
    assert all(position.replay_status == "Completed" for position in positions)

    foreign_claims = claims.model_copy(update={"jti": str(uuid4())})
    with pytest.raises(MCPError):
        await mcp_authority.invoke(
            claims=foreign_claims,
            on_policy_violation=on_policy_violation,
            request_id=JsonRpcId.integer(2),
            provider_wire_name="nexus_search",
            tool_id="nexus.search",
            arguments=search_arguments("foreign bearer"),
        )
    assert policy_violations == [str(generation_id)]

    with pytest.raises(ToolAuthorityRefused, match="different generation"):
        await executor.execute(
            BackendToolExecutionRequest(
                generation_id=uuid4(),
                child_seq=3,
                proposal=CanonicalToolCall(
                    provider_call_id="foreign-generation-call",
                    tool_id=ToolId("nexus.search"),
                    arguments=search_arguments("foreign"),
                ),
            )
        )
    with pytest.raises(ToolAuthorityRefused, match="outside the frozen catalogue"):
        await executor.execute_canonical(
            transport_kind="CodexMcp",
            model_turn_seq=1,
            transport_call_id="mcp:integer:2",
            provider_wire_name="nexus_note_create",
            tool_id=ToolId("nexus.note.create"),
            arguments={},
        )
    with pytest.raises(ToolAuthorityRefused, match="widen the frozen resource scope"):
        await executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=3,
            transport_call_id="provider-call-scope-widening",
            provider_wire_name="nexus_search",
            tool_id=ToolId("nexus.search"),
            arguments=search_arguments("scope widening", scopes=["library:foreign"]),
        )
    with pytest.raises(ValueError, match="reused with different authority"):
        await executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=2,
            transport_call_id="provider-call-1",
            provider_wire_name="nexus_search",
            tool_id=ToolId("nexus.search"),
            arguments=search_arguments("changed replay"),
        )

    # A write-capable plan may run only beside a projection that owns its
    # reverted writes; a bare ledger count would admit failed and undone writes
    # against the live-write cap, so the authority refuses before any effect.
    write_operation = compose_available_product_tool_runtime().operations["ChatReadAdditiveWrite"]
    write_generation_id = uuid4()
    write_owner = LlmCallOwner(kind="chat_run", id=uuid4())
    with factory() as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=write_generation_id,
                owner=write_owner,
                spec=generation_spec_document(
                    generation_tool_spec(
                        operation=write_operation,
                        scope=scope,
                        effect_mode="AdditiveWrites",
                        generation_operation="chat",
                        selection_source="ChatRun",
                    )
                ),
            ),
        )
        db.commit()
    unowned_write_executor = await compose_generation_tool_executor(
        session_factory=factory,
        user_id=user_id,
        owner=write_owner,
        generation_id=write_generation_id,
        job_context=job_context,
        operation=write_operation,
    )
    with pytest.raises(ExecutorConfigurationDefect, match="no projection owning reverted writes"):
        await unowned_write_executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=1,
            transport_call_id="provider-call-unowned-write",
            provider_wire_name="nexus_note_create",
            tool_id=ToolId("nexus.note.create"),
            arguments={"markdown": "An assistant write with no revert owner.", "page_uri": None},
        )
    with factory() as db:
        unowned_positions = read_tool_positions(db, generation_id=write_generation_id)
    assert "Completed" not in {position.replay_status for position in unowned_positions}, (
        f"an unowned write completed a durable position: {unowned_positions!r}"
    )

    with factory() as db:
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=job_context.attempt_no,
                error_code="proof_lease_released",
                error_message="release the worker lease through the queue owner",
                retry_delays_seconds=(1,),
            )
            == "failed"
        )
        db.commit()
    with pytest.raises(ToolAuthorityRefused, match="absent or expired"):
        await executor.execute_canonical(
            transport_kind="CodexMcp",
            model_turn_seq=1,
            transport_call_id="mcp:integer:3",
            provider_wire_name="nexus_search",
            tool_id=ToolId("nexus.search"),
            arguments=search_arguments("lost lease"),
        )
    with factory() as db:
        assert len(read_tool_positions(db, generation_id=generation_id)) == 2
    mcp_authority.close()
    registry.unbind_operations((operation,))


def test_dossier_projection_uses_only_completed_durable_read_evidence(
    request: pytest.FixtureRequest,
) -> None:
    """A Dossier exposes one stable candidate only after its read receipt commits."""

    assert _CUTOVER_PRESENT, "the route-neutral generation tool authority is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_dossier_projection_uses_only_completed_read_evidence(engine))


async def _prove_dossier_projection_uses_only_completed_read_evidence(
    engine: Engine,
) -> None:
    user_id = uuid4()
    baseline_target = ResourceRef(scheme="media", id=uuid4())
    read_target = ResourceRef(scheme="media", id=uuid4())
    baseline = Candidate(
        index=0,
        target=baseline_target,
        text="Admission-owned evidence.",
        snapshot=CitationSnapshot(
            title="Baseline",
            excerpt="Admission-owned evidence.",
            result_type="media",
        ),
    )
    invocations: list[str] = []

    async def execute_read(value: Any, context: Any) -> HandlerSuccess[ResourceReadSuccess]:
        invocations.append(value.uri)
        return HandlerSuccess(
            value=ResourceReadSuccess(
                evidence=NexusEvidence(
                    admission_scope=str(context.scope),
                    citation_target=value.uri,
                    content_sha256=generation_fact_digest("Model-read evidence."),
                    context_ref=value.uri,
                    excerpt_id=None,
                    locator=None,
                    observed_at=None,
                    resource_uri=value.uri,
                    snapshot_revision=None,
                ),
                kind="full",
                text="Model-read evidence.",
                uri=value.uri,
            ),
            actual_attempts=0,
        )

    runtime = controlled_tool_runtime({"nexus.resource.read": execute_read})
    operation = runtime.operations["LibraryDossierRead"]
    scope = FrozenToolScope(admitted_refs=(read_target.uri,), predicates=())
    spec = generation_tool_spec(operation=operation, scope=scope)
    generation_id = uuid4()
    worker_id = "dossier-tool-projection-proof"
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            user_id,
            f"dossier-tool-projection-{user_id}@example.invalid",
        )
        artifact = SynthesisArtifact(
            subject_scheme="library",
            subject_id=uuid4(),
            audience_scheme="user",
            audience_id=str(user_id),
        )
        db.add(artifact)
        db.flush()
        build = ArtifactBuild(
            artifact_id=artifact.id,
            requester_user_id=user_id,
            instruction=None,
            idempotency_key=f"dossier-tool-projection-{uuid4()}",
        )
        db.add(build)
        db.flush()
        owner = LlmCallOwner(kind="artifact_build", id=build.id)
        projection = DossierToolExecutionProjection(
            build_id=build.id,
            baseline_candidates=(baseline,),
        )
        job = enqueue_job(db, kind="dossier_tool_projection_proof", max_attempts=2)
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
        projection=projection,
    )
    prepared_arguments = search_arguments("not completed")
    prepared = await executor.authority.prepare_position(
        transport_kind="CodexMcp",
        model_turn_seq=1,
        transport_call_id="mcp:string:prepared",
        provider_wire_name="nexus_search",
        tool_id=ToolId("nexus.search"),
        input_digest=raw_input_digest(ParsedJson(prepared_arguments)),
        arguments=prepared_arguments,
    )
    assert prepared.path == "generation/1/tool/1"
    assert prepared.replay_status == "Prepared"

    arguments = {"uri": read_target.uri}
    completed = await executor.execute_canonical(
        transport_kind="CodexMcp",
        model_turn_seq=1,
        transport_call_id="mcp:string:completed",
        provider_wire_name="nexus_resource_read",
        tool_id=ToolId("nexus.resource.read"),
        arguments=arguments,
    )
    replayed = await executor.execute_canonical(
        transport_kind="CodexMcp",
        model_turn_seq=1,
        transport_call_id="mcp:string:completed",
        provider_wire_name="nexus_resource_read",
        tool_id=ToolId("nexus.resource.read"),
        arguments=arguments,
    )
    assert completed.model_output.output == replayed.model_output.output
    assert invocations == [read_target.uri]
    rendered = json.loads(completed.model_output.output)
    assert rendered["dossier_citation_candidates"] == [
        {"candidate_index": 1, "target_uri": read_target.uri}
    ]

    with factory() as db:
        positions = read_tool_positions(db, generation_id=generation_id)
        candidates = dossier_candidates_from_ledger(
            db,
            generation_id=generation_id,
            baseline_candidates=(baseline,),
        )
    assert [position.replay_status for position in positions] == ["Prepared", "Completed"]
    assert [(candidate.index, candidate.target.uri) for candidate in candidates] == [
        (0, baseline_target.uri),
        (1, read_target.uri),
    ]

    with pytest.raises(ToolAuthorityRefused, match="requester is not live"):
        await compose_generation_tool_executor(
            session_factory=factory,
            user_id=uuid4(),
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            operation=operation,
            projection=projection,
        )
