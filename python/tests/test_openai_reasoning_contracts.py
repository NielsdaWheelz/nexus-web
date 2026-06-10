"""Backend contract tests for OpenAI reasoning behavior."""

from uuid import UUID, uuid4

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.types import LLMChunk, LLMRequest, LLMUsage, ToolCall
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import Model
from nexus.llm_catalog import model_catalog_entry
from nexus.schemas.conversation import ChatRunCreateRequest, ReaderSelectionRequest
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.chat_runs import (
    ERROR_CODE_TO_MESSAGE,
    _max_output_tokens_for_reasoning,
    execute_chat_run,
)
from nexus.services.conversation_references import insert_reference_if_absent
from tests.factories import (
    create_searchable_media,
    create_test_highlight,
    create_test_model,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.test_resource_resolver import _make_pdf
from tests.utils.db import DirectSessionManager


class _CapturingRouter:
    def __init__(self, terminal_chunk):
        self.terminal_chunk = terminal_chunk
        self.request: LLMRequest | None = None

    async def generate_stream(self, provider, req, api_key, timeout_s):
        self.request = req
        yield self.terminal_chunk


class _IncompleteChunk:
    delta_text = ""
    done = True
    usage = LLMUsage(input_tokens=10, output_tokens=25000, total_tokens=25010)
    provider_request_id = "resp_incomplete"
    status = "incomplete"
    incomplete_details = {"reason": "max_output_tokens"}


class _ToolLoopRouter:
    """Two-iteration fake: reasoning items + a tool call, then the final answer."""

    def __init__(self) -> None:
        self.requests: list[LLMRequest] = []

    async def generate_stream(self, provider, req, api_key, timeout_s):
        self.requests.append(req)
        if len(self.requests) == 1:
            yield LLMChunk(provider_item={"type": "reasoning", "id": "rs_1"})
            yield LLMChunk(tool_call=ToolCall(id="call-1", name="mystery_tool", arguments={}))
            yield LLMChunk(provider_item={"type": "reasoning", "id": "rs_2"})
            yield LLMChunk(
                done=True,
                usage=LLMUsage(input_tokens=10, output_tokens=5, total_tokens=15),
                provider_request_id="resp_iter_1",
            )
            return
        yield LLMChunk(delta_text="Final answer.")
        yield LLMChunk(
            done=True,
            usage=LLMUsage(input_tokens=20, output_tokens=3, total_tokens=23),
            provider_request_id="resp_iter_2",
        )


class _RaisingStreamRouter:
    """Provider stream that raises before any terminal chunk."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    async def generate_stream(self, provider, req, api_key, timeout_s):
        raise self.error
        yield  # pragma: no cover - makes this an async generator


class _DocumentStackRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.request_count = 0

    async def generate_stream(self, provider, req, api_key, timeout_s):
        self.request_count += 1
        if self.request_count == 1:
            yield LLMChunk(
                tool_call=ToolCall(
                    id="inspect-call",
                    name="inspect_resource",
                    arguments={"uri": f"media:{self.media_id}"},
                )
            )
            yield LLMChunk(done=True)
            return
        if self.request_count == 2:
            yield LLMChunk(
                tool_call=ToolCall(
                    id="read-call",
                    name="read_resource",
                    arguments={"uri": f"page_range:{self.media_id}:1-1"},
                )
            )
            yield LLMChunk(done=True)
            return
        yield LLMChunk(delta_text="Summary [1].")
        yield LLMChunk(
            done=True,
            usage=LLMUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_doc_stack",
        )


def test_openai_catalog_exposes_default_separate_from_none():
    metadata = model_catalog_entry("openai", "gpt-5.5")

    assert metadata is not None
    assert list(metadata.reasoning_modes) == ["default", "none", "low", "medium", "high", "max"]


def test_chat_run_request_defaults_reasoning_to_default():
    request = ChatRunCreateRequest(
        conversation_id=uuid4(),
        content="Summarize this.",
        model_id=uuid4(),
    )

    assert request.reasoning == "default"


def test_output_token_budget_is_reasoning_aware():
    model = Model(
        provider="openai",
        model_name="gpt-5.5",
        max_context_tokens=400000,
        is_available=True,
    )

    assert _max_output_tokens_for_reasoning(model, "none") == 4096
    assert _max_output_tokens_for_reasoning(model, "default") == 25000
    assert _max_output_tokens_for_reasoning(model, "high") == 25000


def test_incomplete_error_message_is_actionable():
    message = ERROR_CODE_TO_MESSAGE["E_LLM_INCOMPLETE"]

    assert "less context" in message
    assert "lower reasoning" in message


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.skip(f"chat-runs schema not present yet: {', '.join(sorted(missing))}")


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="reasoning test access",
            actor_label="test",
        )


def _post_chat_run(
    auth_client,
    user_id: UUID,
    model_id: UUID,
    reasoning: str | None,
    conversation_id: UUID,
    extra: dict | None = None,
):
    payload = {
        "conversation_id": str(conversation_id),
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "key_mode": "auto",
    }
    if reasoning is not None:
        payload["reasoning"] = reasoning
    if extra:
        payload.update(extra)

    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": f"reasoning-{uuid4()}"},
        json=payload,
    )


def _register_run_cleanup(direct_db: DirectSessionManager, conversation_id: UUID) -> None:
    # The "conversations"/"id" and "messages"/"conversation_id" cleanup branches
    # both cascade-delete every chat_runs child (chat_run_events,
    # source_manifests, chat_prompt_assemblies, assistant_message_* ledgers,
    # retrieval/rerank ledgers) keyed on the
    # conversation, then delete chat_runs itself. Registering a bare
    # "chat_runs"/"id" item instead deletes that row before those cascades run
    # (cleanup is LIFO), which trips chat_prompt_assemblies_chat_run_id_fkey.
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)


@pytest.mark.integration
def _create_conversation(auth_client, user_id: UUID) -> UUID:
    resp = auth_client.post("/conversations", headers=auth_headers(user_id))
    assert resp.status_code == 201, resp.text
    return UUID(resp.json()["data"]["id"])


def test_omitted_reasoning_stores_explicit_default(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client, user_id, model_id, reasoning=None, conversation_id=conversation_id
    )

    assert response.status_code == 200, (
        f"Expected omitted reasoning to default, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["run"]["reasoning"] == "default"

    _register_run_cleanup(direct_db, conversation_id)


@pytest.mark.integration
def test_unsupported_reasoning_mode_returns_actionable_400(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="minimal",
        conversation_id=conversation_id,
    )

    assert response.status_code == 400, (
        f"Expected unsupported reasoning to fail, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
    assert "minimal" in response.json()["error"]["message"]
    assert "openai/gpt-5.4-mini" in response.json()["error"]["message"]


@pytest.mark.integration
async def test_default_reasoning_uses_reasoning_aware_output_budget(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)

    router = _CapturingRouter(
        LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(input_tokens=10, output_tokens=1, total_tokens=11),
            provider_request_id="resp_ok",
        )
    )
    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
        )

    assert result == {"status": "complete"}
    assert router.request is not None, "Expected chat run to call the LLM router"
    assert router.request.reasoning_effort == "default"
    assert router.request.max_tokens == 25000
    # The usage ledger moved to llm_calls (written by llm_ledger at the call
    # sites, wired in the harness slice); only the prompt assembly pin remains.
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT prompt_block_manifest
                FROM chat_prompt_assemblies
                WHERE assistant_message_id = :message_id
                """
            ),
            {"message_id": UUID(data["assistant_message"]["id"])},
        ).first()

    assert row is not None, "Expected a prompt assembly row"
    assert "Summarize the current notes." not in str(row.prompt_block_manifest)


@pytest.mark.integration
async def test_attached_highlight_public_run_persists_citation_index_and_reader_selection(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
        media_id = create_searchable_media(session, user_id, title="Attached Source")
        fragment_id = session.execute(
            text("SELECT id FROM fragments WHERE media_id = :media_id ORDER BY idx LIMIT 1"),
            {"media_id": media_id},
        ).scalar_one()
        highlight_id = create_test_highlight(session, user_id, fragment_id, exact="selected words")
    conversation_id = _create_conversation(auth_client, user_id)
    with direct_db.session() as session:
        insert_reference_if_absent(session, conversation_id, f"highlight:{highlight_id}")
        session.commit()
    selection_payload = {
        "media_id": str(media_id),
        "highlight_id": str(highlight_id),
        "exact": "selected words",
    }

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
        extra={"reader_selection": selection_payload},
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    assistant_message_id = UUID(data["assistant_message"]["id"])
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversation_references", "conversation_id", conversation_id)

    with direct_db.session() as session:
        job_payload = session.execute(
            text(
                """
                SELECT payload
                FROM background_jobs
                WHERE payload->>'run_id' = :run_id
                """
            ),
            {"run_id": str(run_id)},
        ).scalar_one()
    assert job_payload["reader_selection"] == {
        **selection_payload,
        "prefix": None,
        "suffix": None,
    }

    router = _CapturingRouter(
        LLMChunk(
            delta_text="Attached quote [1].",
            done=True,
            usage=LLMUsage(input_tokens=12, output_tokens=4, total_tokens=16),
            provider_request_id="resp_attached_quote",
        )
    )
    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
            reader_selection=ReaderSelectionRequest(**selection_payload),
        )

    assert result == {"status": "complete"}
    assert router.request is not None
    rendered_prompt = "\n".join(turn.content for turn in router.request.messages)
    assert "<reader_selection" in rendered_prompt
    assert "<exact>selected words</exact>" in rendered_prompt
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT mtc.tool_name, mtc.tool_call_index, mr.citation_ordinal, mr.result_ref
                FROM message_tool_calls mtc
                JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'attached_resources'
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).first()
        citation_event = session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'citation_index'
                LIMIT 1
                """
            ),
            {"run_id": run_id},
        ).scalar_one_or_none()

    assert row is not None
    assert row.tool_name == "attached_resources"
    assert row.tool_call_index == 0
    assert row.citation_ordinal == 1
    assert row.result_ref["result_type"] == "highlight"
    assert isinstance(citation_event, dict)
    assert citation_event["citations"][0]["ordinal"] == 1
    assert citation_event["citations"][0]["snapshot"]["result_type"] == "highlight"


@pytest.mark.integration
async def test_document_summary_trace_inspects_then_reads_map_pointer(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = _make_pdf(session, library_id, pages=["PDF evidence page. "], title="Trace PDF")
    conversation_id = _create_conversation(auth_client, user_id)
    with direct_db.session() as session:
        insert_reference_if_absent(session, conversation_id, f"media:{media_id}")
        session.commit()

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    assistant_message_id = UUID(data["assistant_message"]["id"])
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)

    router = _DocumentStackRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert router.request_count == 3
    with direct_db.session() as session:
        tool_rows = session.execute(
            text(
                """
                SELECT id, tool_name, tool_call_index, result_refs
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index ASC
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).fetchall()
        retrieval_row = session.execute(
            text(
                """
                SELECT mr.result_type, mr.citation_ordinal, mr.result_ref
                FROM message_retrievals mr
                JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'read_resource'
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).first()
        citation_event = session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'citation_index'
                LIMIT 1
                """
            ),
            {"run_id": run_id},
        ).scalar_one_or_none()

    assert [(row[1], row[2]) for row in tool_rows] == [
        ("inspect_resource", 1),
        ("read_resource", 2),
    ]
    assert tool_rows[0][3][0]["uri"] == f"media:{media_id}"
    assert tool_rows[1][3][0]["uri"] == f"page_range:{media_id}:1-1"
    assert retrieval_row is not None
    assert retrieval_row[0] == "media"
    assert retrieval_row[1] == 1
    assert retrieval_row[2]["result_type"] == "media"
    assert isinstance(citation_event, dict)
    assert citation_event["citations"][0]["ordinal"] == 1
    assert citation_event["citations"][0]["snapshot"]["result_type"] == "media"


@pytest.mark.integration
async def test_incomplete_llm_result_finalizes_error_not_success(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="medium",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=_CapturingRouter(_IncompleteChunk()),
        )

    assert result == {"status": "error", "error_code": "E_LLM_INCOMPLETE"}
    fetched = auth_client.get(f"/chat-runs/{run_id}", headers=auth_headers(user_id))
    assert fetched.status_code == 200, (
        f"Expected chat run fetch to succeed, got {fetched.status_code}: {fetched.text}"
    )
    fetched_data = fetched.json()["data"]
    assert fetched_data["run"]["status"] == "error"
    assert fetched_data["run"]["error_code"] == "E_LLM_INCOMPLETE"
    assert fetched_data["assistant_message"]["status"] == "error"
    assert fetched_data["assistant_message"]["error_code"] == "E_LLM_INCOMPLETE"
    assert (
        "output tokens"
        in fetched_data["assistant_message"]["message_document"]["blocks"][0]["text"]
    )


def _create_run_for_executor(
    auth_client, direct_db: DirectSessionManager, *, reasoning: str = "default"
) -> UUID:
    """Create a run via the API and register cleanups (incl. its llm_calls rows)."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client, user_id, model_id, reasoning=reasoning, conversation_id=conversation_id
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    run_id = UUID(response.json()["data"]["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)
    direct_db.register_cleanup("llm_calls", "owner_id", run_id)
    return run_id


def _fetch_run_error(direct_db: DirectSessionManager, run_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text("SELECT error_code, error_detail FROM chat_runs WHERE id = :run_id"),
            {"run_id": run_id},
        ).one()


def _fetch_llm_calls(direct_db: DirectSessionManager, run_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT call_seq, streaming, llm_operation, provider_request_id,
                       key_mode_requested, key_mode_used, error_class, error_detail
                FROM llm_calls
                WHERE owner_kind = 'chat_run' AND owner_id = :run_id
                ORDER BY call_seq ASC
                """
            ),
            {"run_id": run_id},
        ).fetchall()


@pytest.mark.integration
async def test_tool_loop_replays_provider_items_and_ledgers_each_iteration(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _ToolLoopRouter()
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2

    # S0: the captured provider items ride the assistant turn, in capture order,
    # ahead of the tool-results turn on the continuation request.
    assistant_turn, tool_turn = router.requests[1].messages[-2:]
    assert assistant_turn.role == "assistant"
    assert assistant_turn.provider_items == (
        {"type": "reasoning", "id": "rs_1"},
        {"type": "reasoning", "id": "rs_2"},
    )
    assert [tc.id for tc in assistant_turn.tool_calls] == ["call-1"]
    assert tool_turn.role == "tool"

    # AC-3: a run with N tool iterations leaves N llm_calls rows, call_seq 1..N.
    rows = _fetch_llm_calls(direct_db, run_id)
    assert [(row.call_seq, row.provider_request_id) for row in rows] == [
        (1, "resp_iter_1"),
        (2, "resp_iter_2"),
    ]
    assert all(row.streaming for row in rows)
    assert all(row.llm_operation == "chat_send" for row in rows)
    assert all(row.key_mode_requested == "auto" for row in rows)
    assert all(row.key_mode_used == "platform" for row in rows)
    assert all(row.error_class is None for row in rows)


@pytest.mark.integration
async def test_llm_error_stamps_run_error_code_and_detail(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _RaisingStreamRouter(LLMError(LLMErrorCode.RATE_LIMIT, "slow down", provider="openai"))
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_RATE_LIMIT"}
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.error_code == "E_LLM_RATE_LIMIT"
    assert run_row.error_detail == "LLMError: slow down"

    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "E_LLM_RATE_LIMIT"
    assert call_row.error_detail == "LLMError: slow down"


@pytest.mark.integration
async def test_boundary_exception_finalizes_internal_with_detail_and_ledger_row(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _RaisingStreamRouter(RuntimeError("stream socket exploded"))
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_INTERNAL"}
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.error_code == "E_INTERNAL"
    assert run_row.error_detail == "RuntimeError: stream socket exploded"

    # The stream wrapper ledgered the failed provider call before the boundary ran.
    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "RuntimeError"
    assert call_row.error_detail == "RuntimeError: stream socket exploded"
