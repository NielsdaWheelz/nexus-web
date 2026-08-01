"""Priority proof: provider refs remain telemetry behind one Nexus identity."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message, User
from nexus.schemas.retrieval import ProviderResultRef
from nexus.services.agent_tools import web_search


def test_web_search_provider_ref_remains_telemetry_behind_one_snapshot_identity(
    engine: Engine,
) -> None:
    """Provider identifiers never become Nexus resource identity or commit early."""
    user_id = uuid4()
    conversation_id = uuid4()
    user_message_id = uuid4()
    assistant_message_id = uuid4()
    with Session(engine) as setup:
        setup.add_all(
            [
                User(id=user_id, email=f"web-identity-{user_id}@example.invalid"),
                Conversation(id=conversation_id, owner_user_id=user_id),
                Message(
                    id=user_message_id,
                    conversation_id=conversation_id,
                    seq=1,
                    role="user",
                    content="Search the public web.",
                ),
                Message(
                    id=assistant_message_id,
                    conversation_id=conversation_id,
                    seq=2,
                    role="assistant",
                    content="",
                    status="pending",
                    parent_message_id=user_message_id,
                ),
            ]
        )
        setup.commit()

    provider_ref = "brave-result:not-a-nexus-uuid"
    citation = web_search.WebSearchCitation(
        result_ref=ProviderResultRef(provider_ref),
        title="Independent identity oracle",
        url="https://example.test/identity",
        display_url="example.test/identity",
        snippet="Provider identity is telemetry.",
        extra_snippets=("Persist behind a Nexus identity.",),
        published_at="2026-07-30",
        source_name="Example",
        rank=1,
        provider="brave",
        provider_request_id="provider-item-request",
        selected=True,
    )
    run = web_search.WebSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash="identity-proof-query",
        result_type="mixed",
        requested_freshness_days=None,
        requested_domains={"allowed": [], "blocked": []},
        citations=[citation],
        selected_citations=[citation],
        latency_ms=5,
        status="complete",
        provider_request_ids=["provider-response-request"],
        tool_call_index=2,
    )

    with Session(engine) as transaction:
        persisted = web_search.persist_web_search_run(
            transaction,
            run,
            start_citation_ordinal=7,
        )
        snapshot_id = persisted.citations[0].external_snapshot_id
        event = persisted.result_event.model_dump(mode="json")
        result = event["results"][0]

        assert isinstance(snapshot_id, UUID)
        assert str(snapshot_id) != provider_ref
        assert persisted.citations[0].provider_result_ref == provider_ref
        assert result["id"] == result["source_id"] == str(snapshot_id)
        assert result["context_ref"]["id"] == str(snapshot_id)
        assert result["result_ref"] == provider_ref
        assert json.loads(persisted.model_output)["results"][0]["n"] == 7

        with Session(engine) as observer:
            assert (
                observer.execute(
                    text(
                        "SELECT count(*) FROM resource_external_snapshots WHERE id = :snapshot_id"
                    ),
                    {"snapshot_id": snapshot_id},
                ).scalar_one()
                == 0
            ), "web-search persistence committed outside its caller"
        transaction.commit()

    with Session(engine) as oracle:
        stored = oracle.execute(
            text(
                """
                SELECT snapshot.id,
                       retrieval.source_id,
                       retrieval.result_ref->>'result_ref' AS provider_ref,
                       retrieval.citation_candidate_ordinal,
                       tool.result_refs,
                       tool.selected_context_refs
                FROM resource_external_snapshots AS snapshot
                JOIN message_retrievals AS retrieval
                  ON retrieval.source_id = CAST(snapshot.id AS text)
                JOIN message_tool_calls AS tool
                  ON tool.id = retrieval.tool_call_id
                WHERE snapshot.id = :snapshot_id
                """
            ),
            {"snapshot_id": snapshot_id},
        ).one()

    assert stored.id == snapshot_id
    assert stored.source_id == str(snapshot_id), (
        "provider result ref replaced the Nexus snapshot identity"
    )
    assert stored.provider_ref == provider_ref
    assert stored.citation_candidate_ordinal == 7
    assert stored.selected_context_refs == [{"type": "web_result", "id": str(snapshot_id)}]
    assert stored.result_refs[0]["id"] == str(snapshot_id)
    assert stored.result_refs[0]["result_ref"] == provider_ref
