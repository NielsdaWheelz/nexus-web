"""Priority proof: provider refs remain telemetry behind one Nexus identity."""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Sequence
from uuid import UUID, uuid4

from llm_tools import WebSearchRequest, WebSearchResponse, WebSearchResultItem
from provider_runtime import (
    Absent,
    CallMeta,
    Present,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    ToolCallDone,
    ToolCallStart,
)
from provider_runtime.testing import ScriptedRuntime
from provider_runtime.types import PossiblyBillable, ResponsePayload, ToolCall
from pydantic import BaseModel, Field
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ChatRun
from nexus.db.session import create_session_factory
from nexus.jobs.queue import JobExecutionContext, JobRow, claim_job
from nexus.services.chat_runs import execute_chat_run
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.chat import create_entitled_chat


class _RecordingWebSearchProvider(BaseModel):
    requests: list[WebSearchRequest] = Field(default_factory=list)

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        return WebSearchResponse(
            results=(
                WebSearchResultItem(
                    result_ref="brave-provider-result-91",
                    title="Independent identity oracle",
                    url="https://example.test/identity",
                    display_url="example.test/identity",
                    snippet="Provider identity is telemetry.",
                    extra_snippets=("Persist behind a Nexus identity.",),
                    published_at="2026-08-17T09:00:00Z",
                    source_name="Example",
                    rank=1,
                    provider="brave",
                    provider_request_id="brave-item-request-91",
                ),
            ),
            provider="brave",
            provider_request_id="brave-response-request-91",
            retrieved_at="2026-08-17T09:00:01Z",
            attempts=1,
        )


def _success(text: str, tool_calls: Sequence[ToolCall] = ()) -> Succeeded:
    return Succeeded(
        meta=CallMeta(
            provider="openai",
            model="gpt-5-mini",
            provider_request_id=Present(f"chat-provider-{uuid4()}"),
            upstream_provider=Absent(),
            usage=Absent(),
            attempt_trace=(),
            billability=PossiblyBillable(),
            native_reasoning=Present("medium"),
            registry_revision="web-identity-proof-v1",
        ),
        response=ResponsePayload(
            content=TextContent(text=text, tool_calls=tuple(tool_calls)),
            continuation=Absent(),
        ),
    )


def _claim_chat(db: Session, *, job_id: UUID) -> tuple[JobRow, JobExecutionContext]:
    worker_id = f"web-identity-{uuid4()}"
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=(),
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None
    context = JobExecutionContext(
        job_id=claimed.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Light",
    )
    db.commit()
    return claimed, context


def test_web_search_provider_ref_remains_telemetry_behind_one_snapshot_identity(
    engine: Engine,
) -> None:
    """Canonical execution discloses one bounded query and mints Nexus identity."""
    query = "bounded public evidence"
    private_marker = f"private-context-{uuid4()}"
    provider_ref = "brave-provider-result-91"
    provider = _RecordingWebSearchProvider()
    tool_call = ToolCall(
        id="provider-tool-call-91",
        name="web__search",
        arguments={"query": query, "freshness_days": 14},
    )
    model = ScriptedRuntime(
        stream_scripts=(
            (
                StreamStart(),
                ToolCallStart(call_id=tool_call.id, name=tool_call.name),
                ToolCallDone(tool_call=tool_call),
                TerminalEvent(outcome=_success("", (tool_call,))),
            ),
            (
                StreamStart(),
                TextDelta(text="The public evidence is recorded."),
                TerminalEvent(outcome=_success("The public evidence is recorded.")),
            ),
        )
    )
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            chat = create_entitled_chat(
                db,
                content=(
                    "Use the public query supplied by the tool call. Private material: "
                    f"{private_marker}"
                ),
            )
            job, context = _claim_chat(db, job_id=chat.job_id)
            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            assistant_message_id = run.assistant_message_id
            outcome = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=model,
                    settings=get_settings(),
                    web_search_provider=provider,
                )
            )
            assert outcome.kind == "Published"
    finally:
        set_rate_limiter(previous_limiter)

    assert provider.requests == [
        WebSearchRequest(
            query=query,
            limit=6,
            freshness_days=14,
            country="US",
            search_lang="en",
            safe_search="moderate",
            max_attempts=2,
        )
    ]
    assert private_marker not in repr(provider.requests)
    assert "credential" not in repr(provider.requests).lower()
    assert [call.operation for call in model.calls] == ["stream", "stream"]

    with Session(engine) as oracle:
        stored = oracle.execute(
            text(
                """
                SELECT snapshot.id,
                       snapshot.provider,
                       snapshot.source_snapshot,
                       retrieval.source_id,
                       retrieval.result_ref->>'result_ref' AS provider_ref,
                       retrieval.context_ref,
                       retrieval.citation_candidate_ordinal,
                       tool.canonical_tool_id,
                       tool.record_kind,
                       tool.provider_wire_name,
                       tool.canonical_input_sha256,
                       tool.tool_contract_revision,
                       tool.binding_policy_revision,
                       tool.search_query_fingerprint,
                       tool.result_refs AS tool_result_refs,
                       tool.selected_context_refs,
                       tool.provider_request_ids
                FROM resource_external_snapshots AS snapshot
                JOIN message_retrievals AS retrieval
                  ON retrieval.source_id = CAST(snapshot.id AS text)
                JOIN message_tool_calls AS tool
                  ON tool.id = retrieval.tool_call_id
                WHERE tool.assistant_message_id = :assistant_message_id
                  AND tool.canonical_tool_id = 'web.search'
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).one()

    assert isinstance(stored.id, UUID)
    assert str(stored.id) != provider_ref
    assert stored.source_id == str(stored.id), (
        "provider result ref replaced the Nexus snapshot identity"
    )
    assert stored.provider_ref == provider_ref
    assert stored.context_ref == {"type": "web_result", "id": str(stored.id)}
    assert stored.citation_candidate_ordinal == 1
    assert stored.canonical_tool_id == "web.search"
    assert stored.record_kind == "current_execution"
    assert stored.provider_wire_name is None
    assert re.fullmatch(r"[0-9a-f]{64}", stored.canonical_input_sha256)
    assert re.fullmatch(r"[0-9a-f]{64}", stored.tool_contract_revision)
    assert re.fullmatch(r"[0-9a-f]{64}", stored.binding_policy_revision)
    assert stored.search_query_fingerprint == hashlib.sha256(query.encode()).hexdigest()
    assert stored.provider == "brave"
    assert stored.provider_request_ids == ["brave-response-request-91"]
    assert stored.selected_context_refs == [{"type": "web_result", "id": str(stored.id)}]
    assert stored.tool_result_refs[0]["id"] == str(stored.id), (
        "provider result ref replaced the Nexus snapshot identity"
    )
    assert stored.tool_result_refs[0]["source_id"] == str(stored.id)
    assert stored.tool_result_refs[0]["result_ref"] == provider_ref
    assert stored.source_snapshot["id"] == str(stored.id)
    assert stored.source_snapshot["source_id"] == str(stored.id)
    assert stored.source_snapshot["result_ref"] == provider_ref
