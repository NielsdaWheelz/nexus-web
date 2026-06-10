"""Pure-schema contracts for the server-built chat citation read-model (S7).

Chat citations are now built on the backend (``MessageOut.citations`` on the wire
and a reshaped ``citation_index`` SSE payload). These tests pin the wire shapes
without a database; the DB-backed read-model producer is exercised in
``test_message_citations.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.citation import CitationOut, CitationSnapshot, CitationTargetRef
from nexus.schemas.conversation import (
    ChatRunCitationIndexEventPayload,
    MessageOut,
    chat_run_event_payload_json,
)
from nexus.schemas.retrieval import retrieval_result_ref_json
from nexus.services.agent_tools.web_search import WebSearchCitation
from nexus.services.retrieval_citation import RetrievalCitation


def _web_citation(rank: int = 1) -> WebSearchCitation:
    return WebSearchCitation(
        result_ref="web:example",
        title="External source",
        url="https://example.test/source",
        display_url="example.test/source",
        snippet="External source snippet",
        extra_snippets=("more context",),
        published_at="2026-01-01",
        source_name="Example",
        rank=rank,
        provider="brave",
        provider_request_id="req-1",
    )


def test_web_result_result_ref_json_round_trips_through_validator() -> None:
    """The ``web_result`` branch of ``result_ref_json`` passes the strict validator.

    The compact ``RetrievalCitation`` does not carry web-only fields
    (extra_snippets/published_at/source_name/...); the branch passes the full
    ``WebSearchCitation.to_json()`` shape straight through so the validated
    ``WebRetrievalResultRef`` keeps them.
    """
    cit = _web_citation(rank=3)
    citation = RetrievalCitation(
        result_type="web_result",
        source_id=cit.result_ref,
        title=cit.title,
        source_label=None,
        snippet=cit.snippet,
        deep_link=cit.url,
        citation_label=None,
        locator=cit.locator_json(),
        context_ref={"type": "web_result", "id": cit.result_ref},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0 / 3,
        result_ref=cit.to_json(),
        selected=True,
    )

    serialized = retrieval_result_ref_json(citation.result_ref_json())

    assert serialized["type"] == "web_result"
    assert serialized["result_ref"] == "web:example"
    assert serialized["url"] == "https://example.test/source"
    assert serialized["deep_link"] == "https://example.test/source"
    assert serialized["extra_snippets"] == ["more context"]
    assert serialized["published_at"] == "2026-01-01"
    assert serialized["locator"]["type"] == "external_url"
    assert serialized["context_ref"] == {"type": "web_result", "id": "web:example"}


def test_citation_index_payload_carries_citation_outs() -> None:
    """The reshaped citation_index payload is ``{assistant_message_id, citations}``."""
    amid = uuid4()
    media_id = uuid4()
    payload = {
        "assistant_message_id": str(amid),
        "citations": [
            CitationOut(
                ordinal=1,
                role="context",
                target_ref=CitationTargetRef(type="media", id=media_id),
                media_id=media_id,
                deep_link="/media/x",
                snapshot=CitationSnapshot(title="Doc", result_type="media", summary_md="**S**"),
            ).model_dump(mode="json")
        ],
    }

    validated = chat_run_event_payload_json("citation_index", payload)

    assert validated["assistant_message_id"] == str(amid)
    assert [c["ordinal"] for c in validated["citations"]] == [1]
    assert validated["citations"][0]["snapshot"]["summary_md"] == "**S**"
    assert validated["citations"][0]["target_ref"] == {"type": "media", "id": str(media_id)}


def test_citation_index_payload_rejects_legacy_entries_shape() -> None:
    """The old ``entries`` mapping is gone — ``extra=forbid`` rejects it."""
    with pytest.raises(ValidationError):
        ChatRunCitationIndexEventPayload.model_validate(
            {
                "assistant_message_id": str(uuid4()),
                "entries": [
                    {
                        "n": 1,
                        "retrieval_id": str(uuid4()),
                        "tool_call_id": str(uuid4()),
                        "ordinal": 0,
                    }
                ],
            }
        )


def test_chat_run_citation_index_entry_model_is_removed() -> None:
    """``ChatRunCitationIndexEntry`` no longer exists in the schema module."""
    import nexus.schemas.conversation as conversation_schema

    assert not hasattr(conversation_schema, "ChatRunCitationIndexEntry")


def test_message_out_citations_defaults_empty_and_accepts_outs() -> None:
    """``MessageOut`` carries the server-built citation read-model (empty by default)."""
    now = datetime.now(UTC)
    user_message = MessageOut(
        id=uuid4(), seq=1, role="user", status="complete", created_at=now, updated_at=now
    )
    assert user_message.citations == []

    media_id = uuid4()
    assistant_message = MessageOut(
        id=uuid4(),
        seq=2,
        role="assistant",
        status="complete",
        created_at=now,
        updated_at=now,
        citations=[
            CitationOut(
                ordinal=1,
                role="context",
                target_ref=CitationTargetRef(type="media", id=media_id),
                media_id=media_id,
            )
        ],
    )
    assert [c.ordinal for c in assistant_message.citations] == [1]


def test_web_result_target_ref_accepts_string_id() -> None:
    """``web_result`` targets key on the string retrieval ref, not a UUID."""
    ref = CitationTargetRef(type="web_result", id="web:example")
    assert ref.id == "web:example"
    assert ref.model_dump(mode="json") == {"type": "web_result", "id": "web:example"}
