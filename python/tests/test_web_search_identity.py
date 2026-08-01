"""Web-search provider refs never become Nexus resource identities."""

from __future__ import annotations

import json
from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.schemas.retrieval import ProviderResultRef
from nexus.services.agent_tools import web_search
from tests.factories import create_test_conversation, create_test_message
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_persistence_mints_canonical_snapshot_identity_without_committing(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-UUID provider ref stays telemetry; one caller commit publishes the UUID facts."""
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.commit()
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(session, conversation_id, 1, "user", "Search")
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "",
            status="pending",
            parent_message_id=user_message_id,
        )

    provider_ref = "brave-result:not-a-uuid"
    expected_snapshot_id = UUID("11111111-1111-7111-8111-111111111111")
    monkeypatch.setattr(web_search, "new_uuid7", lambda: expected_snapshot_id, raising=False)
    citation = web_search.WebSearchCitation(
        result_ref=ProviderResultRef(provider_ref),
        title="Independent identity oracle",
        url="https://example.test/identity",
        display_url="example.test/identity",
        snippet="Provider identity is not resource identity.",
        extra_snippets=("Persist first.",),
        published_at="2026-07-30",
        source_name="Example",
        rank=1,
        provider="brave",
        provider_request_id="item-request",
        selected=True,
    )
    run = web_search.WebSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash="query-hash",
        result_type="mixed",
        requested_freshness_days=None,
        requested_domains={"allowed": [], "blocked": []},
        citations=[citation],
        selected_citations=[citation],
        latency_ms=5,
        status="complete",
        provider_request_ids=["response-request"],
        tool_call_index=2,
    )

    with direct_db.session() as session:
        persisted = web_search.persist_web_search_run(
            session,
            run,
            start_citation_ordinal=7,
        )

        assert persisted.citations[0].external_snapshot_id == expected_snapshot_id
        assert persisted.citations[0].provider_result_ref == provider_ref
        assert persisted.selected_citations == persisted.citations
        assert persisted.next_citation_ordinal == 8
        assert json.loads(persisted.model_output) == {
            "results": [
                {
                    "n": 7,
                    "title": "Independent identity oracle",
                    "url": "https://example.test/identity",
                    "snippet": "Provider identity is not resource identity.",
                    "source": "Example",
                    "published_at": "2026-07-30",
                }
            ],
            "total_candidates": 1,
            "status": "complete",
            "error_code": None,
        }

        event = persisted.result_event.model_dump(mode="json")
        assert event == {
            "tool_call_id": str(persisted.tool_call_id),
            "assistant_message_id": str(assistant_message_id),
            "tool_name": "web_search",
            "tool_call_index": 2,
            "status": "complete",
            "scope": "public_web",
            "types": ["mixed"],
            "filters": {
                "freshness_days": None,
                "allowed_domains": [],
                "blocked_domains": [],
            },
            "error_code": None,
            "result_count": 1,
            "selected_count": 1,
            "latency_ms": 5,
            "provider_request_ids": ["response-request"],
            "results": [
                {
                    "type": "web_result",
                    "id": str(expected_snapshot_id),
                    "result_type": "web_result",
                    "result_ref": provider_ref,
                    "source_id": str(expected_snapshot_id),
                    "title": "Independent identity oracle",
                    "url": "https://example.test/identity",
                    "display_url": "example.test/identity",
                    "deep_link": "https://example.test/identity",
                    "citation_target": f"external_snapshot:{expected_snapshot_id}",
                    "snippet": "Provider identity is not resource identity.",
                    "extra_snippets": ["Persist first."],
                    "published_at": "2026-07-30",
                    "source_name": "Example",
                    "rank": 1,
                    "provider": "brave",
                    "provider_request_id": "item-request",
                    "locator": {
                        "type": "external_url",
                        "url": "https://example.test/identity",
                        "title": "Independent identity oracle",
                        "display_url": "example.test/identity",
                        "accessed_at": None,
                    },
                    "context_ref": {
                        "type": "web_result",
                        "id": str(expected_snapshot_id),
                        "evidence_span_ids": [],
                    },
                    "media_id": None,
                    "media_kind": None,
                    "score": 1.0,
                    "selected": True,
                }
            ],
        }
        assert provider_ref not in {
            event["results"][0]["id"],
            event["results"][0]["source_id"],
            event["results"][0]["context_ref"]["id"],
        }

        with direct_db.session() as observer:
            assert (
                observer.scalar(
                    text(
                        "SELECT COUNT(*) FROM resource_external_snapshots WHERE id = :snapshot_id"
                    ),
                    {"snapshot_id": expected_snapshot_id},
                )
                == 0
            ), "persistence must leave the atomic publication transaction to its caller"

        session.commit()

    with direct_db.session() as observer:
        stored = (
            observer.execute(
                text(
                    """
                SELECT snapshot.id AS snapshot_id,
                       snapshot.source_snapshot,
                       retrieval.source_id,
                       retrieval.result_ref->>'result_ref' AS provider_result_ref,
                       retrieval.result_ref AS retrieval_result_ref,
                       retrieval.citation_candidate_ordinal,
                       tool.result_refs AS tool_result_refs,
                       tool.selected_context_refs
                FROM resource_external_snapshots AS snapshot
                JOIN message_retrievals AS retrieval
                  ON retrieval.source_id = CAST(snapshot.id AS text)
                JOIN message_tool_calls AS tool
                  ON tool.id = retrieval.tool_call_id
                WHERE snapshot.id = :snapshot_id
                """
                ),
                {"snapshot_id": expected_snapshot_id},
            )
            .mappings()
            .one()
        )
        assert stored["snapshot_id"] == expected_snapshot_id
        assert stored["source_id"] == str(expected_snapshot_id)
        assert stored["provider_result_ref"] == provider_ref
        assert stored["citation_candidate_ordinal"] == 7
        assert stored["selected_context_refs"] == [
            {"type": "web_result", "id": str(expected_snapshot_id)}
        ]
        for identity_payload in (
            stored["source_snapshot"],
            stored["retrieval_result_ref"],
            stored["tool_result_refs"][0],
        ):
            assert identity_payload["id"] == str(expected_snapshot_id)
            assert identity_payload["source_id"] == str(expected_snapshot_id)
            assert identity_payload["context_ref"]["id"] == str(expected_snapshot_id)
            assert identity_payload["citation_target"] == (
                f"external_snapshot:{expected_snapshot_id}"
            )
            assert identity_payload["result_ref"] == provider_ref
