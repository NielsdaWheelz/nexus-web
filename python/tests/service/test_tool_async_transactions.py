"""Real PostgreSQL proof for async tool network and effect transaction boundaries."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any
from uuid import uuid4

import httpx
import pytest
from llm_tools import ToolId
from sqlalchemy import Engine, event, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, LLMToolPosition, NoteBlock
from nexus.services import bootstrap, conversations
from nexus.services.resource_graph.context import add_context_ref_without_commit
from nexus.services.resource_graph.refs import ResourceRef
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.llm_tool_scenarios import (
    claim_running_chat_tool_job,
    compose_available_product_tool_runtime,
    compose_chat_tool_generation,
    create_readable_media,
    create_scoped_entitled_chat,
)


def test_network_releases_database_and_cancelled_write_preserves_atomic_receipt(
    engine: Engine,
    committed_chat_state_isolation: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Network yields without locks; cancellation cannot publish an orphaned effect."""
    del committed_chat_state_isolation
    owner_id = uuid4()
    marker = f"async-tool-proof-{uuid4()}"
    runtime = compose_available_product_tool_runtime()
    catalog = configured_chat_catalog_service()
    catalog_snapshot = asyncio.run(catalog.read_chat())
    with Session(engine, expire_on_commit=False) as db:
        default_library = bootstrap.ensure_user_and_default_library(
            db, owner_id, f"{marker}@example.invalid"
        )
        conversation = conversations.create_conversation(db, owner_id)
        media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=default_library,
            title="Singular nebula",
            canonical_text="A singular nebula in the local evidence.",
        )
        add_context_ref_without_commit(
            db,
            viewer_id=owner_id,
            conversation_id=conversation.id,
            target=ResourceRef(scheme="media", id=media_id),
            origin="user",
        )
        db.commit()
        chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=conversation.id,
                content="Find this source and save a note.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="AdditiveWrites",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        claim = claim_running_chat_tool_job(db, job_id=chat.job_id, run=run, worker_id=marker)
        generation = compose_chat_tool_generation(
            db,
            operation=runtime.operations["ChatReadAdditiveWrite"],
            run=run,
            job_context=claim,
        )

    # Control only the external HTTP boundary. Real provider normalization,
    # credentials, hybrid retrieval, authority, domain writes and SQL all run.
    from nexus.config import get_settings

    monkeypatch.setattr(get_settings(), "openai_api_key", "proof-embedding-credential")
    client_type = httpx.AsyncClient
    loop_thread = threading.get_ident()
    observed_embedding = False
    embedding_threads: list[int] = []

    async def embedding(request: httpx.Request) -> httpx.Response:
        nonlocal observed_embedding
        embedding_threads.append(threading.get_ident())
        assert request.url.path.endswith("/embeddings")
        payload = json.loads(request.content)
        # All connections owned by the tool invocation must be returned before
        # external dispatch. The fixture's independent observer owns its session.
        with Session(engine) as observer:
            active_tool_transactions = observer.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND pid <> pg_backend_pid() "
                    "AND state = 'idle in transaction'"
                )
            )
        assert active_tool_transactions == 0, "tool held a PostgreSQL transaction across HTTP"
        yielded = asyncio.Event()
        asyncio.get_running_loop().call_soon(yielded.set)
        await yielded.wait()
        observed_embedding = True
        return httpx.Response(
            200,
            json={
                "object": "list",
                "model": payload["model"],
                "data": [
                    {
                        "object": "embedding",
                        "index": 0,
                        "embedding": [0.0] * payload["dimensions"],
                    }
                ],
                "usage": {"prompt_tokens": 3, "total_tokens": 3},
            },
        )

    class EmbeddingClient(client_type):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs, transport=httpx.MockTransport(embedding))

    monkeypatch.setattr(httpx, "AsyncClient", EmbeddingClient)

    async def prove() -> None:
        result = await generation.executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=1,
            transport_call_id="search-network-boundary",
            provider_wire_name="nexus.search",
            tool_id=ToolId("nexus.search"),
            arguments={
                "query": "singular nebula",
                "kinds": ["documents"],
                "formats": None,
                "authors": None,
                "roles": None,
                "scopes": [f"media:{media_id}"],
                "limit": 2,
            },
        )
        assert observed_embedding, "hybrid query skipped its external semantic preparation"
        assert embedding_threads == [loop_thread], (
            "tool embedding moved to a blocking helper thread instead of yielding the provider loop"
        )
        assert not result.model_output.is_error
        assert f"media:{media_id}" in result.model_output.output

        cancellation_observed = False

        def cancel_before_receipt_commit(
            connection: Any,
            cursor: Any,
            statement: str,
            parameters: Any,
            context: Any,
            executemany: bool,
        ) -> None:
            del connection, cursor, parameters, context, executemany
            nonlocal cancellation_observed
            if (
                statement.startswith("UPDATE llm_tool_positions SET")
                and "result_evidence" in statement
            ):
                cancellation_observed = True
                task = asyncio.current_task()
                assert task is not None
                task.cancel()

        # Observe the real driver's completion of the terminal receipt UPDATE,
        # before PostgreSQL commits it with the real note mutation.
        event.listen(Engine, "after_cursor_execute", cancel_before_receipt_commit)
        try:
            with pytest.raises(asyncio.CancelledError):
                await generation.executor.execute_canonical(
                    transport_kind="ProviderApi",
                    model_turn_seq=1,
                    transport_call_id="cancel-before-commit",
                    provider_wire_name="nexus.note.create",
                    tool_id=ToolId("nexus.note.create"),
                    arguments={"markdown": marker, "page_uri": None},
                )
        finally:
            event.remove(Engine, "after_cursor_execute", cancel_before_receipt_commit)
        assert cancellation_observed, "proof did not reach the real write receipt transaction"

    asyncio.run(prove())
    with Session(engine) as observer:
        assert (
            observer.scalar(
                select(func.count()).select_from(NoteBlock).where(NoteBlock.user_id == owner_id)
            )
            == 0
        ), "cancelled tool published a domain effect without its terminal receipt"
        position = observer.scalars(
            select(LLMToolPosition).where(
                LLMToolPosition.generation_id == generation.generation_id,
                LLMToolPosition.transport_call_id == "cancel-before-commit",
            )
        ).one()
        assert position.replay_status == "Uncertain"
        assert position.result_evidence is None
        assert position.settlement is None
        # Only the completed search may publish a model-visible tool result.
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ChatRunEvent)
                .where(ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "tool_result")
            )
            == 1
        )
