"""Pure-schema contracts for the resource-provenance-graph citation wire shapes.

Chat citations are citation *edges* in the resource provenance graph (§9.5),
built on the backend and rendered directly by the frontend. These tests pin the
wire shapes without a database:

- ``MessageOut.citations`` carries the server-built ``CitationOut`` read-model.
- The ``citation_index`` SSE payload is ``{assistant_message_id, citations}`` where
  each item is ``citation_edge_id`` + a backend-built ``CitationOut``. It is not
  the old reduced ``entries`` shape.
- ``CitationTargetRef.id`` is a UUID (every target is a ``resource_edges`` row);
  web results are snapshotted as ``external_snapshot`` targets, so there is no
  string-id ``web_result`` target type.

The DB-backed read-model producer is exercised in ``test_message_citations.py``
and the end-to-end ``citations`` SSE persistence in
``test_openai_reasoning_contracts.py``; these stay focused pure-schema contracts.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.citation import CitationOut, CitationSnapshot, CitationTargetRef
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatRunCitationIndexEventPayload,
    ChatRunCitationIndexItem,
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

    Web results remain a *telemetry* result_type (``message_retrievals``); the
    compact ``RetrievalCitation`` does not carry web-only fields
    (extra_snippets/published_at/source_name/...), so the branch passes the full
    ``WebSearchCitation.to_json()`` shape straight through and the validated
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


def test_citation_index_payload_carries_backend_built_citations() -> None:
    """The citation_index payload wraps backend-built CitationOut objects."""
    amid = uuid4()
    edge_id = uuid4()
    block_id = uuid4()
    citation = CitationOut(
        ordinal=1,
        role="supports",
        target_ref=CitationTargetRef(type="note_block", id=block_id),
        media_id=None,
        locator={
            "type": "note_block_offsets",
            "block_id": str(block_id),
            "start_offset": 0,
            "end_offset": 12,
        },
        deep_link="/notes/example",
        snapshot=CitationSnapshot(title="Research note", result_type="note_block"),
    )
    payload = {
        "assistant_message_id": str(amid),
        "citations": [
            ChatRunCitationIndexItem(
                citation_edge_id=edge_id,
                citation=citation,
            ).model_dump(mode="json")
        ],
    }

    validated = chat_run_event_payload_json("citation_index", payload)

    assert validated["assistant_message_id"] == str(amid)
    assert "entries" not in validated
    item = validated["citations"][0]
    assert item["citation_edge_id"] == str(edge_id)
    assert item["citation"]["ordinal"] == 1
    assert item["citation"]["role"] == "supports"
    assert item["citation"]["target_ref"] == {"type": "note_block", "id": str(block_id)}
    assert item["citation"]["media_id"] is None
    assert item["citation"]["locator"] == {
        "type": "note_block_offsets",
        "block_id": str(block_id),
        "start_offset": 0,
        "end_offset": 12,
    }
    assert item["citation"]["snapshot"]["title"] == "Research note"


def test_citation_index_payload_rejects_legacy_entries_shape() -> None:
    """The reduced ``{assistant_message_id, entries:[...]}`` shape is gone."""
    with pytest.raises(ValidationError):
        ChatRunCitationIndexEventPayload.model_validate(
            {
                "assistant_message_id": str(uuid4()),
                "entries": [
                    {
                        "citation_edge_id": str(uuid4()),
                        "n": 1,
                        "target_ref": {"type": "note_block", "id": str(uuid4())},
                        "kind": "context",
                        "snapshot": {"title": "Note"},
                    }
                ],
            }
        )


def test_chat_run_citation_index_item_requires_citation_read_model() -> None:
    """Citation index items require a nested CitationOut, not flattened chip fields."""
    edge_id = uuid4()
    target_id = uuid4()
    item = ChatRunCitationIndexItem(
        citation_edge_id=edge_id,
        citation=CitationOut(
            ordinal=2,
            role="context",
            target_ref=CitationTargetRef(type="note_block", id=target_id),
            snapshot=CitationSnapshot(title="Note"),
        ),
    )
    assert item.citation.ordinal == 2
    assert item.citation.snapshot is not None
    assert item.citation.snapshot.title == "Note"

    with pytest.raises(ValidationError):
        ChatRunCitationIndexItem(
            citation_edge_id=edge_id,
            n=0,
            target_ref=CitationTargetRef(type="note_block", id=target_id),
            kind="context",
            snapshot=CitationSnapshot(title="Note"),
        )

    with pytest.raises(ValidationError):
        ChatRunCitationIndexItem(
            citation_edge_id=edge_id,
        )


def test_message_out_citations_defaults_empty_and_accepts_outs() -> None:
    """``MessageOut`` carries the server-built citation read-model (empty by default)."""
    now = datetime.now(UTC)
    user_message = MessageOut(
        id=uuid4(), seq=1, role="user", status="complete", created_at=now, updated_at=now
    )
    assert user_message.citations == []

    media_id = uuid4()
    assistant_message_id = uuid4()
    assistant_message = MessageOut(
        id=assistant_message_id,
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
        trust_trail=AssistantTrustTrailOut(
            assistant_message_id=assistant_message_id,
            conversation_id=uuid4(),
            status="complete",
            created_at=now,
            updated_at=now,
        ),
    )
    assert [c.ordinal for c in assistant_message.citations] == [1]


def test_citation_target_ref_requires_uuid_id_and_rejects_web_result() -> None:
    """Every citation target keys on a UUID; web results are ``external_snapshot``.

    The cutover narrowed ``CitationTargetRef.id`` to a UUID (every target is a
    ``resource_edges`` row), and dropped the string-id ``web_result`` target type
    in favour of snapshotting web results as ``external_snapshot`` rows.
    """
    snapshot_id = uuid4()
    ref = CitationTargetRef(type="external_snapshot", id=snapshot_id)
    assert ref.id == snapshot_id
    assert ref.model_dump(mode="json") == {
        "type": "external_snapshot",
        "id": str(snapshot_id),
    }

    # web_result is no longer a citation target scheme.
    with pytest.raises(ValidationError):
        CitationTargetRef(type="web_result", id=snapshot_id)

    # A string id (the old web retrieval ref) is rejected — id must be a UUID.
    with pytest.raises(ValidationError):
        CitationTargetRef(type="external_snapshot", id="web:example")
