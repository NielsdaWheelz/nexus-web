"""RED service proof for the sessionless MCP ChatTools boundary.

The scenario deliberately enters through the official Streamable HTTP shape and
the real Postgres/runtime fixtures.  It must not be replaced by a fake tool
handler or an in-process authorization shortcut when the service is built.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4
from xml.etree import ElementTree

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    ContentBlock,
    ContentIndexState,
    Fragment,
    LibraryEntry,
    Message,
    MessageToolCall,
)
from nexus.db.session import create_session_factory
from nexus.jobs.queue import get_job, update_running_job_payload
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.presence import present
from nexus.services import bootstrap, generation_policy, library_governance
from nexus.services.agent_tool_grants import (
    AGENT_TOOL_GRANT_AUDIENCE,
    AGENT_TOOL_GRANT_ISSUER,
    AGENT_TOOL_GRANT_SCOPE,
    MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    AgentToolGrantClaims,
    issue_agent_tool_grant,
)
from nexus.services.agent_tools_mcp import (
    MAX_MCP_REQUEST_BODY_BYTES,
    MCP_PATH,
    MCP_PROTOCOL_VERSION,
    MCP_RATE_BURST,
    AgentToolAuthority,
    JsonRpcId,
    create_agent_tools_mcp_app,
)
from nexus.services.chat_run_finalize import finalize_cancelled
from nexus.services.chat_run_steps import ChatStepRuntime, PreparedChatRun, step_fingerprint
from nexus.services.chat_runs import cancel_chat_run
from nexus.services.codex_generation_client import CodexGenerationClient
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    GenerationTerminal,
    request_fingerprint,
)
from nexus.services.durable_step_journal import (
    Completed,
    StepReplayState,
    encode_step_result,
    payload_with_step_state,
    stable_generation_id,
)
from nexus.services.generation_intent import BearerToolGrant, GenerationIntent, TextOutput
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    complete_generation_in_current_transaction,
    lock_generation_owner_in_current_transaction,
    start_generation_in_current_transaction,
)
from nexus.services.resource_graph.context import add_context_ref_without_commit
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.tool_runtime.declarations import (
    BROWSER_TOOL_PROJECTION_REVISION,
    CHAT_TOOL_DECLARATIONS,
)
from tests.testkit.auth import UserRecord
from tests.testkit.chat import create_entitled_chat
from tests.testkit.llm_tool_scenarios import (
    claim_chat_tool_job,
    compose_keyless_tool_runtime,
    create_readable_media,
)
from tests.testkit.unreachable_state import expire_job_claim

_SIGNING_KEY = SecretStr("dedicated-chat-tools-hs256-test-key")


def _mcp_request(
    request_id: int | str | None, method: str, params: dict[str, object]
) -> dict[str, object]:
    request: dict[str, object] = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }
    if request_id is not None:
        request["id"] = request_id
    return request


def _headers(
    *,
    bearer: str | None,
    initialized: bool = True,
    method: str | None = None,
    name: str | None = None,
) -> dict[str, str]:
    del method, name
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if initialized:
        headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def _model_result(response: httpx.Response) -> dict[str, object]:
    text = response.json()["result"]["content"][0]["text"]
    if text.startswith("{"):
        value = json.loads(text)
    else:
        root = ElementTree.fromstring(text)
        assert (root.tag, root.attrib) == ("section", {"kind": "tool_result"})
        payload = next(child for child in root if child.attrib == {"kind": "payload"})
        value = json.loads(payload.text or "")
    assert isinstance(value, dict)
    return value


@dataclass(frozen=True, slots=True)
class _WriteRace:
    app: FastAPI
    bearer: str
    user_id: UUID
    run_id: UUID
    job_id: UUID
    assistant_message_id: UUID
    generation_id: UUID
    media_id: UUID
    library_id: UUID
    policy_violations: list[str]


def _prepare_write_race(engine: Engine, user: UserRecord, *, label: str) -> _WriteRace:
    worker_id = f"mcp-write-race-{label}"
    generation_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        admitted = create_entitled_chat(
            db,
            content=f"File the race target ({label}).",
            user_id=user.id,
        )
        run = db.get(ChatRun, admitted.run_id)
        assert run is not None
        operation = compose_keyless_tool_runtime().operations["chat"]
        job_context = claim_chat_tool_job(
            db,
            job_id=admitted.job_id,
            worker_id=worker_id,
        )
        media_id = create_readable_media(
            db,
            user_id=user.id,
            default_library_id=user.default_library_id,
            title=f"MCP cancellation race {label}",
            canonical_text="A cancelled write must have one serialized outcome.",
        )
        media_uri = f"media:{media_id}"
        add_context_ref_without_commit(
            db,
            viewer_id=user.id,
            conversation_id=run.conversation_id,
            target=ResourceRef(scheme="media", id=media_id),
            origin="user",
        )
        library_id = uuid4()
        library_governance.create_library(
            db,
            user.id,
            CreateLibraryRequest(
                library_id=library_id,
                name=f"MCP cancellation race {label}",
            ),
        )
        intent = GenerationIntent(
            instructions="Use only the admitted Nexus tools.",
            input="File the admitted resource.",
            output=TextOutput(),
        )
        prepared = PreparedChatRun(
            generate_intent=intent,
            admitted_resource_uris=(media_uri,),
            initial_citation_ordinal=1,
            initial_tool_call_index=0,
        )
        claimed_job = get_job(db, admitted.job_id)
        assert claimed_job is not None
        prepared_state = StepReplayState(
            generation_id=stable_generation_id(run.id, "prepare"),
            dispatch_phase=Completed,
            request_fingerprint=present(step_fingerprint(prepared)),
            terminal_result=present(encode_step_result(prepared)),
        )
        assert update_running_job_payload(
            db,
            job_id=admitted.job_id,
            worker_id=worker_id,
            attempt_no=job_context.attempt_no,
            payload=payload_with_step_state(
                claimed_job.payload,
                step_path="prepare",
                state=prepared_state,
            ),
        )
        run.status = "running"
        run.profile_id = "balanced"
        run.model_name = "gpt-5.6-terra"
        run.reasoning_effort = "medium"
        db.commit()

        placeholder = GenerationCommand(
            request_id=generation_id,
            operation=ChatOperation(
                kind="chat",
                revision=generation_policy.operation_revision("chat", profile="balanced"),
                profile="balanced",
            ),
            policy_revision=generation_policy.POLICY_REVISION,
            policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
            intent=intent,
            tool_grant=BearerToolGrant(token=SecretStr("placeholder-chat-grant-" + "x" * 32)),
        )
        now = datetime.now(UTC).replace(microsecond=0)
        issued_at = int(now.timestamp())
        claims = AgentToolGrantClaims(
            iss=AGENT_TOOL_GRANT_ISSUER,
            aud=AGENT_TOOL_GRANT_AUDIENCE,
            scope=AGENT_TOOL_GRANT_SCOPE,
            sub=str(user.id),
            jti=str(uuid4()),
            run_id=str(run.id),
            job_id=str(admitted.job_id),
            worker_id=worker_id,
            attempt_no=job_context.attempt_no,
            generation_id=str(generation_id),
            tool_plan_revision=str(operation.plan.plan_revision),
            request_fingerprint=request_fingerprint(placeholder),
            iat=issued_at,
            nbf=issued_at,
            exp=issued_at + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
        )
        bearer = issue_agent_tool_grant(
            claims,
            signing_key=_SIGNING_KEY,
            now=now,
        ).get_secret_value()
        command = placeholder.model_copy(
            update={"tool_grant": BearerToolGrant(token=SecretStr(bearer))}
        )
        run_id = run.id
        assistant_message_id = run.assistant_message_id
        job_id = admitted.job_id

    session_factory = create_session_factory(engine)
    with session_factory() as ledger_db:
        with ledger_db.begin():
            start_generation_in_current_transaction(
                ledger_db,
                GenerationStart(
                    owner=LlmCallOwner(kind="chat_run", id=run_id),
                    command=command,
                    streaming=True,
                ),
            )
    policy_violations: list[str] = []

    async def policy_violation(value: UUID) -> None:
        policy_violations.append(str(value))

    authority = AgentToolAuthority.from_claimed_chat_attempt(
        session_factory=session_factory,
        run_id=run_id,
        job_id=job_id,
        attempt_no=job_context.attempt_no,
        resource_class=job_context.resource_class,
        operation=operation,
        worker_id=worker_id,
        generation_id=generation_id,
        admitted_resource_uris=(media_uri,),
    )
    return _WriteRace(
        app=create_agent_tools_mcp_app(
            authority=authority,
            signing_key=_SIGNING_KEY,
            on_policy_violation=policy_violation,
            mcp_origin="http://mcp.test/internal/agent-tools/mcp",
        ),
        bearer=bearer,
        user_id=user.id,
        run_id=run_id,
        job_id=job_id,
        assistant_message_id=assistant_message_id,
        generation_id=generation_id,
        media_id=media_id,
        library_id=library_id,
        policy_violations=policy_violations,
    )


def _await_backend_blocked_by(
    engine: Engine,
    *,
    blocking_pid: int,
    query_pattern: str,
) -> int:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            waiting_pid = connection.scalar(
                text(
                    """
                    SELECT pid
                    FROM pg_stat_activity
                    WHERE :blocking_pid = ANY(pg_blocking_pids(pid))
                      AND query ILIKE :query_pattern
                    ORDER BY query_start, pid
                    LIMIT 1
                    """
                ),
                {
                    "blocking_pid": blocking_pid,
                    "query_pattern": query_pattern,
                },
            )
            if waiting_pid is not None:
                return int(waiting_pid)
            connection.execute(text("SELECT pg_sleep(0.01)"))
    raise AssertionError(
        f"no backend matching {query_pattern!r} blocked behind backend {blocking_pid}"
    )


def _library_add(client: TestClient, race: _WriteRace, *, request_id: str) -> httpx.Response:
    return client.post(
        MCP_PATH,
        headers=_headers(
            bearer=race.bearer,
            method="tools/call",
            name="nexus.library.add",
        ),
        json=_mcp_request(
            request_id,
            "tools/call",
            {
                "name": "nexus.library.add",
                "arguments": {
                    "resource_uri": f"media:{race.media_id}",
                    "library_id": str(race.library_id),
                    "library_name": None,
                },
            },
        ),
    )


def _cancel_race(engine: Engine, race: _WriteRace) -> bool:
    with Session(engine) as db:
        response = cancel_chat_run(db, viewer_id=race.user_id, run_id=race.run_id)
        return response.run.cancel_requested_at is not None


def _fold_race_cancelled(engine: Engine, race: _WriteRace) -> None:
    """Land the worker's one cancelled terminal after Cancel has won authority."""
    with Session(engine) as db:
        complete_generation_in_current_transaction(
            db,
            owner=LlmCallOwner(kind="chat_run", id=race.run_id),
            generation_id=race.generation_id,
            terminal=GenerationTerminal(
                status="cancelled",
                failure=None,
                final_text="",
                structured_output=None,
                session_ref=None,
                usage=None,
                diagnostics=("cancelled by exact MCP write race",),
                accepted_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                sdk_version=generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                runtime_version=generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
            ),
            latency_ms=1,
        )
        run = db.get(ChatRun, race.run_id)
        assert run is not None and run.cancel_requested_at is not None
        finalize_cancelled(db, run)


def _assert_race_folded_cancelled(db: Session, race: _WriteRace) -> None:
    run = db.get(ChatRun, race.run_id)
    assistant = db.get(Message, race.assistant_message_id)
    assert run is not None and run.status == "cancelled"
    assert assistant is not None and assistant.status == "cancelled"
    done_events = db.scalars(
        select(ChatRunEvent).where(
            ChatRunEvent.run_id == race.run_id,
            ChatRunEvent.event_type == "done",
        )
    ).all()
    assert len(done_events) == 1
    assert done_events[0].payload["status"] == "cancelled"
    assert done_events[0].payload["cancelled"] is True


def test_cancelled_signed_grant_is_bodylessly_denied_and_notifies_host_once(
    engine: Engine,
) -> None:
    user_id = uuid4()
    email = f"mcp-cancelled-grant-{user_id}@example.invalid"
    with Session(engine) as db:
        default_library_id = bootstrap.ensure_user_and_default_library(db, user_id, email)
        db.commit()
    race = _prepare_write_race(
        engine,
        UserRecord(id=user_id, email=email, default_library_id=default_library_id),
        label="cancelled-grant",
    )
    assert _cancel_race(engine, race)

    with TestClient(race.app, base_url="http://mcp.test") as client:
        denied = tuple(
            client.post(
                MCP_PATH,
                headers=_headers(bearer=race.bearer),
                json=_mcp_request(request_id, "tools/list", {}),
            )
            for request_id in ("cancelled-list-1", "cancelled-list-2")
        )

    assert tuple((response.status_code, response.content) for response in denied) == (
        (401, b""),
        (401, b""),
    )
    assert race.policy_violations == [str(race.generation_id)]


def test_mcp_mount_projects_declarations_and_is_sessionless(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """One real worker owns read/write calls and durable replay identities."""
    user_id = test_user.id
    admitted = create_entitled_chat(
        db_session,
        content="Read one bounded resource and add it to my queue.",
        user_id=user_id,
    )
    run = db_session.get(ChatRun, admitted.run_id)
    assert run is not None
    # The production authority factory must enqueue/claim this actual Chat job,
    # then construct ChatStepRuntime and ToolExecutor from that lease identity.
    runtime = compose_keyless_tool_runtime()
    operation = runtime.operations["chat"]
    job_context = claim_chat_tool_job(
        db_session,
        job_id=admitted.job_id,
        worker_id="worker-red-proof",
    )
    media_id = create_readable_media(
        db_session,
        user_id=user_id,
        default_library_id=test_user.default_library_id,
        title="MCP bounded read",
        canonical_text="bounded content",
    )
    exact_text = "x" * 50_000
    exact_media_id = create_readable_media(
        db_session,
        user_id=user_id,
        default_library_id=test_user.default_library_id,
        title="MCP exact read ceiling",
        canonical_text=exact_text,
    )
    oversized_text = "y" * 50_001
    oversized_media_id = create_readable_media(
        db_session,
        user_id=user_id,
        default_library_id=test_user.default_library_id,
        title="MCP over read ceiling",
        canonical_text=oversized_text,
    )
    for target_id, body, label in (
        (media_id, "bounded content", "Bounded section"),
        (oversized_media_id, oversized_text, "Oversized section"),
    ):
        fragment_id = db_session.scalar(select(Fragment.id).where(Fragment.media_id == target_id))
        assert fragment_id is not None
        db_session.add(
            ContentIndexState(
                owner_kind="media",
                owner_id=target_id,
                revision=1,
                status="ready",
            )
        )
        db_session.add(
            ContentBlock(
                owner_kind="media",
                owner_id=target_id,
                block_idx=0,
                block_kind="heading",
                canonical_text=label,
                extraction_confidence=1.0,
                source_start_offset=0,
                source_end_offset=len(body),
                parent_block_id=None,
                heading_path=[label],
                locator={
                    "section_id": label.casefold().replace(" ", "-"),
                    "fragment_id": str(fragment_id),
                    "fragment_idx": 0,
                    "heading_level": 1,
                    "start_offset": 0,
                    "end_offset": len(body),
                },
                selector={"kind": "heading"},
                metadata_json={"depth": 1, "ordinal": 1},
            )
        )
    admitted_uris = tuple(
        f"media:{target_id}" for target_id in (media_id, exact_media_id, oversized_media_id)
    )
    for target_id in (media_id, exact_media_id, oversized_media_id):
        add_context_ref_without_commit(
            db_session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            target=ResourceRef(scheme="media", id=target_id),
            origin="user",
        )
    filing_library_id = uuid4()
    library_governance.create_library(
        db_session,
        user_id,
        CreateLibraryRequest(
            library_id=filing_library_id,
            name="MCP reversible filing",
        ),
    )
    generation_id = uuid4()
    now = datetime.now(UTC).replace(microsecond=0)
    issued_at = int(now.timestamp())
    operation_revision = generation_policy.operation_revision("chat", profile="balanced")
    intent = GenerationIntent(
        instructions="Use only the admitted Nexus tools.",
        input="Read the admitted resource.",
        output=TextOutput(),
    )
    missing_uri = f"media:{uuid4()}"
    prepared = PreparedChatRun(
        generate_intent=intent,
        admitted_resource_uris=(*admitted_uris, missing_uri),
        initial_citation_ordinal=1,
        initial_tool_call_index=0,
    )
    claimed_job = get_job(db_session, admitted.job_id)
    assert claimed_job is not None
    prepared_state = StepReplayState(
        generation_id=stable_generation_id(run.id, "prepare"),
        dispatch_phase=Completed,
        request_fingerprint=present(step_fingerprint(prepared)),
        terminal_result=present(encode_step_result(prepared)),
    )
    assert update_running_job_payload(
        db_session,
        job_id=admitted.job_id,
        worker_id="worker-red-proof",
        attempt_no=job_context.attempt_no,
        payload=payload_with_step_state(
            claimed_job.payload,
            step_path="prepare",
            state=prepared_state,
        ),
    )
    run.status = "running"
    run.profile_id = "balanced"
    run.model_name = "gpt-5.6-terra"
    run.reasoning_effort = "medium"
    db_session.commit()
    placeholder = GenerationCommand(
        request_id=generation_id,
        operation=ChatOperation(kind="chat", revision=operation_revision, profile="balanced"),
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=intent,
        tool_grant=BearerToolGrant(token=SecretStr("placeholder-chat-grant-" + "x" * 32)),
    )
    command_fingerprint = request_fingerprint(placeholder)
    claims = AgentToolGrantClaims(
        iss=AGENT_TOOL_GRANT_ISSUER,
        aud=AGENT_TOOL_GRANT_AUDIENCE,
        scope=AGENT_TOOL_GRANT_SCOPE,
        sub=str(user_id),
        jti=str(uuid4()),
        run_id=str(run.id),
        job_id=str(admitted.job_id),
        worker_id="worker-red-proof",
        attempt_no=job_context.attempt_no,
        generation_id=str(generation_id),
        tool_plan_revision=str(operation.plan.plan_revision),
        request_fingerprint=command_fingerprint,
        iat=issued_at,
        nbf=issued_at,
        exp=issued_at + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    )

    def signed(changes: dict[str, object] | None = None, *, at: datetime = now) -> str:
        return issue_agent_tool_grant(
            claims.model_copy(update=changes or {}),
            signing_key=_SIGNING_KEY,
            now=at,
        ).get_secret_value()

    bearer = signed()
    command = placeholder.model_copy(
        update={"tool_grant": BearerToolGrant(token=SecretStr(bearer))}
    )
    session_factory = create_session_factory(db_session.get_bind())
    with session_factory() as ledger_db:
        with ledger_db.begin():
            start_generation_in_current_transaction(
                ledger_db,
                GenerationStart(
                    owner=LlmCallOwner(kind="chat_run", id=run.id),
                    command=command,
                    streaming=True,
                ),
            )
    policy_violations: list[str] = []

    async def policy_violation(generation_id: object) -> None:
        policy_violations.append(str(generation_id))

    authority = AgentToolAuthority.from_claimed_chat_attempt(
        session_factory=session_factory,
        run_id=run.id,
        job_id=admitted.job_id,
        attempt_no=job_context.attempt_no,
        resource_class=job_context.resource_class,
        operation=operation,
        worker_id="worker-red-proof",
        generation_id=generation_id,
        admitted_resource_uris=(*admitted_uris, missing_uri),
    )
    app = create_agent_tools_mcp_app(
        authority=authority,
        signing_key=_SIGNING_KEY,
        on_policy_violation=policy_violation,
        mcp_origin="http://mcp.test/internal/agent-tools/mcp",
    )

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=transport, base_url="http://mcp.test") as client,
        ):
            yielded_chunks = 0

            async def oversized_chunks() -> AsyncIterator[bytes]:
                nonlocal yielded_chunks
                for _ in range(4):
                    yielded_chunks += 1
                    yield b"x" * (MAX_MCP_REQUEST_BODY_BYTES // 2)

            oversized_request = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                content=oversized_chunks(),
            )
            assert oversized_request.status_code == 413
            assert oversized_request.content == b""
            assert yielded_chunks == 3, "the authenticated body must stop at the first excess byte"

            initialized = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, initialized=False),
                json=_mcp_request(
                    0,
                    "initialize",
                    {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "nexus-red-proof", "version": "0"},
                    },
                ),
            )
            assert initialized.status_code == 200
            assert initialized.headers["content-type"].split(";", 1)[0] == "application/json"
            assert "Mcp-Session-Id" not in initialized.headers
            assert initialized.json()["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION

            initialize_wire = _mcp_request(
                94,
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "nexus-header-proof", "version": "0"},
                },
            )
            later_wire = _mcp_request(95, "tools/list", {})
            header_near_misses = (
                (
                    "initialize missing Content-Type",
                    initialize_wire,
                    False,
                    "Content-Type",
                    (),
                ),
                (
                    "initialize JSON-only Accept",
                    initialize_wire,
                    False,
                    "Accept",
                    ("application/json",),
                ),
                (
                    "later parameterized Content-Type",
                    later_wire,
                    True,
                    "Content-Type",
                    ("application/json; charset=utf-8",),
                ),
                ("later missing Accept", later_wire, True, "Accept", ()),
                ("later wildcard Accept", later_wire, True, "Accept", ("*/*",)),
                (
                    "later media-range Accept",
                    later_wire,
                    True,
                    "Accept",
                    ("application/*, text/event-stream",),
                ),
                (
                    "later parameterized Accept",
                    later_wire,
                    True,
                    "Accept",
                    ("application/json; q=1, text/event-stream",),
                ),
                (
                    "later malformed Accept pair",
                    later_wire,
                    True,
                    "Accept",
                    ("application/json,text/event-stream",),
                ),
                (
                    "later duplicate Content-Type",
                    later_wire,
                    True,
                    "Content-Type",
                    ("application/json", "application/json"),
                ),
                (
                    "later duplicate Accept",
                    later_wire,
                    True,
                    "Accept",
                    (
                        "application/json, text/event-stream",
                        "application/json, text/event-stream",
                    ),
                ),
            )
            for label, wire, initialized_request, header_name, values in header_near_misses:
                raw_headers = [
                    (name, value)
                    for name, value in _headers(
                        bearer=bearer,
                        initialized=initialized_request,
                    ).items()
                    if name.casefold() != header_name.casefold()
                ]
                raw_headers.extend((header_name, value) for value in values)
                request = client.build_request(
                    "POST",
                    MCP_PATH,
                    headers=raw_headers,
                    content=json.dumps(wire).encode(),
                )
                if not values and header_name in request.headers:
                    del request.headers[header_name]
                rejected = await client.send(request)
                assert (rejected.status_code, rejected.content) == (400, b""), label

            acknowledged = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(None, "notifications/initialized", {}),
            )
            assert acknowledged.status_code == 202
            assert acknowledged.content == b""

            missing_version = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, initialized=False),
                json=_mcp_request(90, "tools/list", {}),
            )
            wrong_version_headers = _headers(bearer=bearer)
            wrong_version_headers["MCP-Protocol-Version"] = "2025-03-26"
            wrong_version = await client.post(
                MCP_PATH,
                headers=wrong_version_headers,
                json=_mcp_request(91, "tools/list", {}),
            )
            session_headers = _headers(bearer=bearer)
            session_headers["Mcp-Session-Id"] = "forbidden-session"
            client_session = await client.post(
                MCP_PATH,
                headers=session_headers,
                json=_mcp_request(92, "tools/list", {}),
            )
            alternate_initialize = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, initialized=False),
                json=_mcp_request(
                    93,
                    "initialize",
                    {
                        "protocolVersion": "2026-07-28",
                        "capabilities": {},
                        "clientInfo": {"name": "nexus-red-proof", "version": "0"},
                    },
                ),
            )
            get_transport = await client.get(
                MCP_PATH,
                headers=_headers(bearer=bearer),
            )
            assert (
                missing_version.status_code,
                wrong_version.status_code,
                client_session.status_code,
                alternate_initialize.status_code,
                get_transport.status_code,
            ) == (400, 400, 400, 400, 405)
            assert get_transport.headers["allow"] == "POST"

            listed = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, method="tools/list"),
                json=_mcp_request(1, "tools/list", {}),
            )
            assert listed.status_code == 200
            assert listed.headers["content-type"].split(";", 1)[0] == "application/json"
            assert "Mcp-Session-Id" not in listed.headers
            listed_tools = listed.json()["result"]["tools"]
            names = tuple(item["name"] for item in listed_tools)
            expected = tuple(entry.spec.id for entry in CHAT_TOOL_DECLARATIONS)
            assert names == expected
            assert tuple(item["inputSchema"] for item in listed_tools) == tuple(
                entry.spec.input_schema.presentation for entry in CHAT_TOOL_DECLARATIONS
            )

            read_args = {"uri": f"media:{media_id}"}
            read = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    1,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            assert read.status_code == 200
            assert read.json()["result"]["isError"] is False
            assert set(read.json()["result"]) == {"content", "isError"}
            first_receipt = read.content

            # Crash-window proof: the ToolExecutor terminal is already durable,
            # but the separate outer MCP receipt disappears before generation
            # fold. The Chat owner must rebuild that exact projection without a
            # second tool execution, row, event, or citation allocation.
            with session_factory() as crash_db:
                crashed_job = get_job(crash_db, admitted.job_id)
                assert crashed_job is not None
                crashed_payload = json.loads(json.dumps(crashed_job.payload))
                journal = crashed_payload.get("_agent_tool_calls")
                assert isinstance(journal, dict) and len(journal) == 1
                admitted_entry = next(iter(journal.values()))
                assert isinstance(admitted_entry, dict)
                original_receipt = admitted_entry.pop("result")
                admitted_entry.pop("next_citation_ordinal")
                assert update_running_job_payload(
                    crash_db,
                    job_id=admitted.job_id,
                    worker_id=job_context.worker_id,
                    attempt_no=job_context.attempt_no,
                    payload=crashed_payload,
                )
                crash_db.commit()
                crashed_job = get_job(crash_db, admitted.job_id)
                assert crashed_job is not None
                ChatStepRuntime(
                    crash_db,
                    run_id=run.id,
                    job=crashed_job,
                    execution_context=job_context,
                    llm_runtime=CodexGenerationClient(get_settings().codex_agent_socket),
                ).assert_no_uncertain_tool_effect()
                repaired_job = get_job(crash_db, admitted.job_id)
                assert repaired_job is not None
                repaired = repaired_job.payload["_agent_tool_calls"]
                assert isinstance(repaired, dict)
                repaired_entry = next(iter(repaired.values()))
                assert isinstance(repaired_entry, dict)
                assert repaired_entry["result"] == original_receipt

            replay = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    1,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            assert replay.content == first_receipt
            changed = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    1,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": {"uri": "media:other"}},
                ),
            )
            assert changed.status_code == 200
            assert changed.json()["result"]["isError"] is True, (
                "changed invocation crossed the generation dispatch boundary"
            )

            exact_read = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    10,
                    "tools/call",
                    {
                        "name": "nexus.resource.read",
                        "arguments": {"uri": f"media:{exact_media_id}"},
                    },
                ),
            )
            exact_result = _model_result(exact_read)
            assert exact_read.json()["result"]["isError"] is False
            assert exact_result["type"] == "Success"
            assert exact_result["value"]["text"] == exact_text

            oversized_read = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    11,
                    "tools/call",
                    {
                        "name": "nexus.resource.read",
                        "arguments": {"uri": f"media:{oversized_media_id}"},
                    },
                ),
            )
            oversized_result = _model_result(oversized_read)
            assert oversized_read.json()["result"]["isError"] is True
            assert oversized_result == {"error": {"type": "TooLarge"}, "type": "Failure"}

            invalid_receipts: list[bytes] = []
            invalid_cases = (
                (12, {}),
                (13, {"uri": f"media:{media_id}", "unexpected": True}),
                (14, {"uri": 7}),
            )
            for request_id, arguments in invalid_cases:
                invalid = await client.post(
                    MCP_PATH,
                    headers=_headers(bearer=bearer),
                    json=_mcp_request(
                        request_id,
                        "tools/call",
                        {"name": "nexus.resource.read", "arguments": arguments},
                    ),
                )
                assert invalid.status_code == 200
                assert invalid.json()["result"]["isError"] is True
                assert _model_result(invalid) == {
                    "error": {"type": "InvalidInput"},
                    "type": "Failure",
                }
                invalid_receipts.append(invalid.content)

            invalid_replay = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    12,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": {}},
                ),
            )
            assert invalid_replay.content == invalid_receipts[0]
            with session_factory() as audit_db:
                invalid_rows = list(
                    audit_db.scalars(
                        select(MessageToolCall)
                        .where(
                            MessageToolCall.assistant_message_id == run.assistant_message_id,
                            MessageToolCall.tool_call_index.in_((4, 5, 6)),
                        )
                        .order_by(MessageToolCall.tool_call_index)
                    )
                )
                assert [
                    (
                        row.tool_call_index,
                        row.record_kind,
                        row.status,
                        row.error_code,
                        row.provider_wire_name,
                    )
                    for row in invalid_rows
                ] == [
                    (index, "current_execution", "error", "InvalidInput", "nexus.resource.read")
                    for index in (4, 5, 6)
                ]
                invalid_events = list(
                    audit_db.scalars(
                        select(ChatRunEvent)
                        .where(ChatRunEvent.run_id == run.id)
                        .order_by(ChatRunEvent.seq)
                    )
                )
                assert {
                    index: [
                        event.event_type
                        for event in invalid_events
                        if event.payload.get("tool_call_index") == index
                    ]
                    for index in (4, 5, 6)
                } == {
                    index: ["tool_call_start", "tool_call_done", "tool_result"]
                    for index in (4, 5, 6)
                }

            race_requests = (
                _mcp_request(
                    20,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
                _mcp_request(
                    "20",
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            raced = await asyncio.gather(
                *(
                    client.post(
                        MCP_PATH,
                        headers=_headers(bearer=bearer),
                        json=request,
                    )
                    for request in race_requests
                )
            )
            assert all(response.status_code == 200 for response in raced)
            assert all(response.json()["result"]["isError"] is False for response in raced)
            race_receipts = tuple(response.content for response in raced)
            replayed_race = await asyncio.gather(
                *(
                    client.post(
                        MCP_PATH,
                        headers=_headers(bearer=bearer),
                        json=request,
                    )
                    for request in race_requests
                )
            )
            assert tuple(response.content for response in replayed_race) == race_receipts
            with session_factory() as race_db:
                race_job = get_job(race_db, admitted.job_id)
                assert race_job is not None
                race_journal = race_job.payload.get("_agent_tool_calls")
                assert isinstance(race_journal, dict)
                race_entries = [
                    entry
                    for entry in race_journal.values()
                    if isinstance(entry, dict)
                    and entry.get("request_id")
                    in (
                        {"kind": "integer", "value": 20},
                        {"kind": "string", "value": "20"},
                    )
                ]
                assert sorted(
                    (
                        entry["tool_index"],
                        entry["citation_ordinal"],
                        entry["next_citation_ordinal"],
                    )
                    for entry in race_entries
                ) == [(7, 3, 4), (8, 4, 5)]
                race_rows = list(
                    race_db.scalars(
                        select(MessageToolCall)
                        .where(
                            MessageToolCall.assistant_message_id == run.assistant_message_id,
                            MessageToolCall.tool_call_index.in_((7, 8)),
                        )
                        .order_by(MessageToolCall.tool_call_index)
                    )
                )
                assert [row.provider_request_ids for row in race_rows] == [[], []]
                assert [row.status for row in race_rows] == ["complete", "complete"]

            typed_string = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    "1",
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            assert typed_string.status_code == 200
            assert typed_string.json()["id"] == "1"

            declared_failure = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    3,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": {"uri": missing_uri}},
                ),
            )
            assert declared_failure.status_code == 200
            assert declared_failure.json()["result"]["isError"] is True
            assert set(declared_failure.json()["result"]) == {"content", "isError"}

            unknown = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    "unknown",
                    "tools/call",
                    {"name": "unknown.tool", "arguments": {}},
                ),
            )
            assert unknown.status_code == 200
            assert unknown.json()["result"]["isError"] is True
            assert _model_result(unknown) == {
                "error": {"type": "UnknownTool"},
                "type": "Failure",
            }
            unknown_receipt = unknown.content
            unknown_replay = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    "unknown",
                    "tools/call",
                    {"name": "unknown.tool", "arguments": {}},
                ),
            )
            assert unknown_replay.content == unknown_receipt
            with session_factory() as unknown_db:
                unknown_rows = list(
                    unknown_db.scalars(
                        select(MessageToolCall).where(
                            MessageToolCall.assistant_message_id == run.assistant_message_id,
                            MessageToolCall.tool_call_index == 11,
                        )
                    )
                )
                assert len(unknown_rows) == 1
                unknown_row = unknown_rows[0]
                assert (
                    unknown_row.record_kind,
                    unknown_row.canonical_tool_id,
                    unknown_row.provider_wire_name,
                    unknown_row.status,
                    unknown_row.error_code,
                ) == (
                    "rejected_provider_call",
                    None,
                    "unknown.tool",
                    "error",
                    "unknown_tool",
                )
                unknown_events = [
                    event
                    for event in unknown_db.scalars(
                        select(ChatRunEvent)
                        .where(ChatRunEvent.run_id == run.id)
                        .order_by(ChatRunEvent.seq)
                    )
                    if event.payload.get("tool_call_index") == 11
                ]
                assert [event.event_type for event in unknown_events] == [
                    "tool_call_start",
                    "tool_call_done",
                    "tool_result",
                ]
                assert all(
                    event.payload["record_kind"] == "rejected_provider_call"
                    and event.payload["canonical_tool_id"] is None
                    and event.payload["provider_wire_name"] == "unknown.tool"
                    for event in unknown_events
                )
                assert unknown_events[-1].payload["status"] == "error"
                assert unknown_events[-1].payload["error_code"] == "unknown_tool"
                unknown_event_count = len(unknown_events)
            changed_unknown_name = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    "unknown",
                    "tools/call",
                    {"name": "another.unknown", "arguments": {}},
                ),
            )
            assert changed_unknown_name.json()["result"]["isError"] is True
            with session_factory() as changed_unknown_db:
                assert (
                    changed_unknown_db.scalar(
                        select(MessageToolCall).where(
                            MessageToolCall.assistant_message_id == run.assistant_message_id,
                            MessageToolCall.tool_call_index == 11,
                        )
                    )
                    is not None
                )
                assert (
                    len(
                        [
                            event
                            for event in changed_unknown_db.scalars(
                                select(ChatRunEvent).where(ChatRunEvent.run_id == run.id)
                            )
                            if event.payload.get("tool_call_index") == 11
                        ]
                    )
                    == unknown_event_count
                )
            for invalid_name in ("", "x" * 129):
                invalid = await client.post(
                    MCP_PATH,
                    headers=_headers(bearer=bearer),
                    json=_mcp_request(
                        f"invalid-name-{len(invalid_name)}",
                        "tools/call",
                        {"name": invalid_name, "arguments": {}},
                    ),
                )
                assert "error" in invalid.json()

            write = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.library.add",
                ),
                json=_mcp_request(
                    2,
                    "tools/call",
                    {
                        "name": "nexus.library.add",
                        "arguments": {
                            "resource_uri": f"media:{media_id}",
                            "library_id": str(filing_library_id),
                            "library_name": None,
                        },
                    },
                ),
            )
            assert write.status_code == 200
            assert write.json()["result"]["isError"] is False
            with session_factory() as write_db:
                write_row = write_db.scalar(
                    select(MessageToolCall).where(
                        MessageToolCall.assistant_message_id == run.assistant_message_id,
                        MessageToolCall.canonical_tool_id == "nexus.library.add",
                    )
                )
                assert write_row is not None
                tool_call_id = write_row.id
                assert write_row.reverted_at is None
                assert (
                    write_db.scalar(
                        select(LibraryEntry).where(
                            LibraryEntry.library_id == filing_library_id,
                            LibraryEntry.media_id == media_id,
                        )
                    )
                    is not None
                )
            undone = authenticated_client.post(
                f"/conversations/{run.conversation_id}/tool-calls/{tool_call_id}/undo",
                headers={"X-Nexus-Tool-Projection": BROWSER_TOOL_PROJECTION_REVISION},
            )
            assert undone.status_code == 200, undone.text
            undone_data = undone.json()["data"]
            assert undone_data["id"] == str(tool_call_id)
            assert undone_data["canonical_tool_id"] == "nexus.library.add"
            assert undone_data["reverted_at"] is not None
            with session_factory() as undone_db:
                reverted = undone_db.get(MessageToolCall, tool_call_id)
                assert reverted is not None and reverted.reverted_at is not None
                assert (
                    undone_db.scalar(
                        select(LibraryEntry).where(
                            LibraryEntry.library_id == filing_library_id,
                            LibraryEntry.media_id == media_id,
                        )
                    )
                    is None
                )

            inspected = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    100,
                    "tools/call",
                    {
                        "name": "nexus.resource.inspect",
                        "arguments": {"uri": f"media:{media_id}"},
                    },
                ),
            )
            inspect_result = _model_result(inspected)
            assert inspect_result["type"] == "Success"
            inspect_value = inspect_result["value"]
            assert isinstance(inspect_value, dict)
            sections = inspect_value["sections"]
            assert isinstance(sections, list) and len(sections) == 1
            section = sections[0]
            assert isinstance(section, dict)
            derived_uri = section["read_uri"]
            assert isinstance(derived_uri, str) and derived_uri.startswith("fragment:")
            derived = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    101,
                    "tools/call",
                    {
                        "name": "nexus.resource.read",
                        "arguments": {"uri": derived_uri},
                    },
                ),
            )
            derived_result = _model_result(derived)
            assert derived_result["type"] == "Success"
            derived_value = derived_result["value"]
            assert isinstance(derived_value, dict)
            assert derived_value["text"] == "bounded content"

            inspected_oversized = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    102,
                    "tools/call",
                    {
                        "name": "nexus.resource.inspect",
                        "arguments": {"uri": f"media:{oversized_media_id}"},
                    },
                ),
            )
            oversized_inspect_result = _model_result(inspected_oversized)
            oversized_inspect_value = oversized_inspect_result["value"]
            assert isinstance(oversized_inspect_value, dict)
            oversized_sections = oversized_inspect_value["sections"]
            assert isinstance(oversized_sections, list) and len(oversized_sections) == 1
            oversized_section = oversized_sections[0]
            assert isinstance(oversized_section, dict)
            oversized_derived_uri = oversized_section["read_uri"]
            assert isinstance(oversized_derived_uri, str)
            oversized_derived = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(
                    103,
                    "tools/call",
                    {
                        "name": "nexus.resource.read",
                        "arguments": {"uri": oversized_derived_uri},
                    },
                ),
            )
            assert _model_result(oversized_derived) == {
                "error": {"type": "TooLarge"},
                "type": "Failure",
            }

            exposed_without_grant = await client.post(
                MCP_PATH,
                headers=_headers(bearer=None, method="tools/call", name="nexus.resource.read"),
                json=_mcp_request(
                    3,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            bad_signature = await client.post(
                MCP_PATH,
                headers=_headers(bearer="invalid", method="tools/call", name="nexus.resource.read"),
                json=_mcp_request(
                    3,
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            hidden_get = await client.get(MCP_PATH, headers=_headers(bearer=None))
            invalid_get = await client.get(MCP_PATH, headers=_headers(bearer="invalid"))
            assert (
                exposed_without_grant.status_code,
                bad_signature.status_code,
                hidden_get.status_code,
                invalid_get.status_code,
            ) == (401, 401, 401, 401)
            assert (
                exposed_without_grant.content
                == bad_signature.content
                == hidden_get.content
                == invalid_get.content
                == b""
            )
            assert policy_violations == []

            stale_generation_initialize_body_reads = 0

            async def stale_generation_initialize_body() -> AsyncIterator[bytes]:
                nonlocal stale_generation_initialize_body_reads
                stale_generation_initialize_body_reads += 1
                yield json.dumps(initialize_wire).encode()

            stale_generation_initialize = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=signed({"generation_id": str(uuid4())}),
                    initialized=False,
                ),
                content=stale_generation_initialize_body(),
            )
            cross_run_list = await client.post(
                MCP_PATH,
                headers=_headers(bearer=signed({"run_id": str(uuid4())})),
                json=later_wire,
            )
            assert (
                stale_generation_initialize.status_code,
                stale_generation_initialize.content,
                cross_run_list.status_code,
                cross_run_list.content,
                stale_generation_initialize_body_reads,
            ) == (401, b"", 401, b"", 0)
            assert policy_violations == [str(generation_id)]

            live_initialize = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, initialized=False),
                json=initialize_wire,
            )
            live_list = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=later_wire,
            )
            live_notification = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(None, "notifications/initialized", {}),
            )
            assert (
                live_initialize.status_code,
                live_list.status_code,
                live_notification.status_code,
            ) == (200, 200, 202)

            unadmitted = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    "unadmitted-resource",
                    "tools/call",
                    {
                        "name": "nexus.resource.read",
                        "arguments": {"uri": "media:other"},
                    },
                ),
            )
            assert unadmitted.status_code == 200
            assert "error" in unadmitted.json()
            assert policy_violations == [str(generation_id)]

            later_auth_failures = (
                ("cross-user", {"sub": str(uuid4())}, read_args),
                ("cross-run", {"run_id": str(uuid4())}, read_args),
                ("cross-generation", {"generation_id": str(uuid4())}, read_args),
                ("wrong-worker", {"worker_id": "other-worker"}, read_args),
                ("wrong-attempt", {"attempt_no": job_context.attempt_no + 1}, read_args),
            )
            for label, changes, arguments in later_auth_failures:
                response = await client.post(
                    MCP_PATH,
                    headers=_headers(
                        bearer=signed(changes),
                        method="tools/call",
                        name="nexus.resource.read",
                    ),
                    json=_mcp_request(
                        label,
                        "tools/call",
                        {"name": "nexus.resource.read", "arguments": arguments},
                    ),
                )
                assert (response.status_code, response.content) == (401, b"")
            assert policy_violations == [str(generation_id)]

            with session_factory() as stale_db:
                expire_job_claim(stale_db, job_id=admitted.job_id)
                stale_db.commit()
            stale_initialize = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer, initialized=False),
                json=initialize_wire,
            )
            stale_list = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=later_wire,
            )
            stale_notification = await client.post(
                MCP_PATH,
                headers=_headers(bearer=bearer),
                json=_mcp_request(None, "notifications/initialized", {}),
            )
            assert (
                stale_initialize.status_code,
                stale_initialize.content,
                stale_list.status_code,
                stale_list.content,
                stale_notification.status_code,
                stale_notification.content,
            ) == (401, b"", 401, b"", 401, b"")
            assert policy_violations == [str(generation_id)]

            with session_factory() as cancel_db:
                cancel_run = cancel_db.get(ChatRun, run.id)
                assert cancel_run is not None
                cancel_run.cancel_requested_at = datetime.now(UTC)
                cancel_db.commit()
            cancelled = await client.post(
                MCP_PATH,
                headers=_headers(
                    bearer=bearer,
                    method="tools/call",
                    name="nexus.resource.read",
                ),
                json=_mcp_request(
                    "cancelled",
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            assert (cancelled.status_code, cancelled.content) == (401, b"")
            assert policy_violations == [str(generation_id)]

            expired_at = now - timedelta(seconds=MAX_AGENT_TOOL_GRANT_TTL_SECONDS + 1)
            expired_claims = claims.model_copy(
                update={
                    "iat": int(expired_at.timestamp()),
                    "nbf": int(expired_at.timestamp()),
                    "exp": int(expired_at.timestamp()) + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
                }
            )
            expired = issue_agent_tool_grant(
                expired_claims,
                signing_key=_SIGNING_KEY,
                now=expired_at,
            ).get_secret_value()
            expired_response = await client.post(
                MCP_PATH,
                headers=_headers(bearer=expired, method="tools/call", name="nexus.resource.read"),
                json=_mcp_request(
                    "expired",
                    "tools/call",
                    {"name": "nexus.resource.read", "arguments": read_args},
                ),
            )
            assert expired_response.status_code == exposed_without_grant.status_code
            assert policy_violations == [str(generation_id)]

            saturated = False
            for index in range(MCP_RATE_BURST + 1):
                throttled = await client.post(
                    MCP_PATH,
                    headers=_headers(bearer=f"invalid-{index}"),
                    json=_mcp_request(index, "tools/list", {}),
                )
                if throttled.status_code == 429:
                    saturated = True
                    break
            assert saturated
            saturated_unauthenticated_probe = await client.post(MCP_PATH, content=b"")
            assert (
                saturated_unauthenticated_probe.status_code,
                saturated_unauthenticated_probe.content,
            ) == (
                429,
                b"",
            )

    asyncio.run(scenario())


def test_cancel_and_in_flight_mcp_write_have_one_run_locked_outcome(
    engine: Engine,
) -> None:
    """Cancel-first has no effect; effect-first commits before Cancel returns;
    both then fold once to Cancelled and admit no later effect."""

    user_id = uuid4()
    email = f"mcp-write-race-{user_id}@example.invalid"
    with Session(engine) as db:
        default_library_id = bootstrap.ensure_user_and_default_library(db, user_id, email)
        db.commit()
    race_user = UserRecord(
        id=user_id,
        email=email,
        default_library_id=default_library_id,
    )

    cancel_first = _prepare_write_race(engine, race_user, label="cancel-first")
    with (
        TestClient(cancel_first.app, base_url="http://mcp.test") as client,
        ThreadPoolExecutor(max_workers=1) as pool,
        Session(engine) as blocker,
    ):
        lock_generation_owner_in_current_transaction(
            blocker,
            LlmCallOwner(kind="chat_run", id=cancel_first.run_id),
        )
        blocker_pid = int(blocker.scalar(text("SELECT pg_backend_pid()")))
        write = pool.submit(
            _library_add,
            client,
            cancel_first,
            request_id="cancel-first",
        )
        _await_backend_blocked_by(
            engine,
            blocking_pid=blocker_pid,
            query_pattern="%pg_advisory_xact_lock%",
        )
        assert not write.done(), "the write crossed its blocked authority boundary"
        assert _cancel_race(engine, cancel_first)
        blocker.commit()
        cancelled_write = write.result(timeout=10)

    assert (cancelled_write.status_code, cancelled_write.content) == (401, b"")
    assert cancel_first.policy_violations == [str(cancel_first.generation_id)]
    with Session(engine) as oracle:
        assert (
            oracle.scalar(
                select(LibraryEntry).where(
                    LibraryEntry.library_id == cancel_first.library_id,
                    LibraryEntry.media_id == cancel_first.media_id,
                )
            )
            is None
        )

    _fold_race_cancelled(engine, cancel_first)
    with TestClient(cancel_first.app, base_url="http://mcp.test") as client:
        denied_after_terminal = _library_add(
            client,
            cancel_first,
            request_id="cancel-first-after-terminal",
        )
    assert (denied_after_terminal.status_code, denied_after_terminal.content) == (401, b"")
    assert cancel_first.policy_violations == [str(cancel_first.generation_id)]
    with Session(engine) as oracle:
        _assert_race_folded_cancelled(oracle, cancel_first)
        assert (
            oracle.scalar(
                select(LibraryEntry).where(
                    LibraryEntry.library_id == cancel_first.library_id,
                    LibraryEntry.media_id == cancel_first.media_id,
                )
            )
            is None
        )
        assert (
            oracle.scalar(
                select(MessageToolCall).where(
                    MessageToolCall.assistant_message_id == cancel_first.assistant_message_id,
                )
            )
            is None
        )
        assert (
            oracle.scalar(
                select(MessageToolCall).where(
                    MessageToolCall.assistant_message_id == cancel_first.assistant_message_id,
                )
            )
            is None
        )

    effect_first = _prepare_write_race(engine, race_user, label="effect-first")
    with (
        TestClient(effect_first.app, base_url="http://mcp.test") as client,
        ThreadPoolExecutor(max_workers=2) as pool,
        Session(engine) as blocker,
    ):
        blocker.execute(
            text("SELECT id FROM libraries WHERE id = :library_id FOR UPDATE"),
            {"library_id": effect_first.library_id},
        )
        blocker_pid = int(blocker.scalar(text("SELECT pg_backend_pid()")))
        write = pool.submit(
            _library_add,
            client,
            effect_first,
            request_id="effect-first",
        )
        write_pid = _await_backend_blocked_by(
            engine,
            blocking_pid=blocker_pid,
            query_pattern="%FROM libraries l%",
        )
        assert not write.done(), "the write did not retain its ChatRun lock through mutation"
        cancel = pool.submit(_cancel_race, engine, effect_first)
        _await_backend_blocked_by(
            engine,
            blocking_pid=write_pid,
            query_pattern="%FROM chat_runs%FOR UPDATE%",
        )
        assert not cancel.done(), "Cancel crossed the write-owned ChatRun lock"
        blocker.commit()
        completed_write = write.result(timeout=10)
        assert cancel.result(timeout=10)

    assert completed_write.status_code == 200
    assert completed_write.json()["result"]["isError"] is False
    assert effect_first.policy_violations == []
    with Session(engine) as oracle:
        assert (
            oracle.scalar(
                select(LibraryEntry).where(
                    LibraryEntry.library_id == effect_first.library_id,
                    LibraryEntry.media_id == effect_first.media_id,
                )
            )
            is not None
        )
        tool_row = oracle.scalar(
            select(MessageToolCall).where(
                MessageToolCall.assistant_message_id == effect_first.assistant_message_id,
                MessageToolCall.canonical_tool_id == "nexus.library.add",
            )
        )
        assert tool_row is not None
        assert (tool_row.status, tool_row.error_code) == ("complete", None)
        run = oracle.get(ChatRun, effect_first.run_id)
        assert run is not None and run.cancel_requested_at is not None

    _fold_race_cancelled(engine, effect_first)
    with TestClient(effect_first.app, base_url="http://mcp.test") as client:
        denied_after_terminal = _library_add(
            client,
            effect_first,
            request_id="effect-first-after-terminal",
        )
    assert (denied_after_terminal.status_code, denied_after_terminal.content) == (401, b"")
    assert effect_first.policy_violations == [str(effect_first.generation_id)]
    with Session(engine) as oracle:
        _assert_race_folded_cancelled(oracle, effect_first)
        assert (
            len(
                oracle.scalars(
                    select(LibraryEntry).where(
                        LibraryEntry.library_id == effect_first.library_id,
                        LibraryEntry.media_id == effect_first.media_id,
                    )
                ).all()
            )
            == 1
        )
        assert (
            len(
                oracle.scalars(
                    select(MessageToolCall).where(
                        MessageToolCall.assistant_message_id == effect_first.assistant_message_id,
                    )
                ).all()
            )
            == 1
        )


def test_admission_algebra_is_typed_total_order_and_closed() -> None:
    assert JsonRpcId.integer(1) != JsonRpcId.string("1")
    assert JsonRpcId.integer(1).position(7, 2) == "generation/7/tool/2"
    assert JsonRpcId.string("1").position(7, 2) == "generation/7/tool/2"

    for invalid in (None, True, 1.5, 2**63, "x" * 257):
        with pytest.raises(ValueError):
            JsonRpcId.from_raw(invalid)
