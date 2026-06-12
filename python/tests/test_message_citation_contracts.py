"""Pure-schema contracts for the resource-provenance-graph citation wire shapes.

Chat citations are citation *edges* in the resource provenance graph (§9.5),
built on the backend and rendered directly by the frontend. These tests pin the
wire shapes without a database:

- ``MessageOut.citations`` carries the server-built ``CitationOut`` read-model.
- The ``citation_index`` SSE payload is ``{assistant_message_id, entries}`` where
  each entry is a ``ChatRunCitationIndexEntry`` (``citation_edge_id`` + the ``[n]``
  marker + the chip display fields). It is NOT ``{assistant_message_id, citations}``.
- ``CitationTargetRef.id`` is a UUID (every target is a ``resource_edges`` row);
  web results are snapshotted as ``external_snapshot`` targets, so there is no
  string-id ``web_result`` target type.

The DB-backed read-model producer is exercised in ``test_message_citations.py``
and the end-to-end ``entries`` SSE persistence in
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
    ChatRunCitationIndexEntry,
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


def test_citation_index_payload_carries_entries() -> None:
    """The citation_index payload is ``{assistant_message_id, entries}``.

    Each entry pins one citation edge: ``citation_edge_id`` + the ``[n]`` marker
    + the chip display fields (target_ref/kind/deep_link/snapshot).
    """
    amid = uuid4()
    edge_id = uuid4()
    target_id = uuid4()
    payload = {
        "assistant_message_id": str(amid),
        "entries": [
            ChatRunCitationIndexEntry(
                citation_edge_id=edge_id,
                n=1,
                target_ref=CitationTargetRef(type="content_chunk", id=target_id),
                kind="supports",
                deep_link="/media/x?chunk=1",
                snapshot=CitationSnapshot(
                    title="Doc", section_label="§2", result_type="content_chunk"
                ),
            ).model_dump(mode="json")
        ],
    }

    validated = chat_run_event_payload_json("citation_index", payload)

    assert validated["assistant_message_id"] == str(amid)
    assert [e["n"] for e in validated["entries"]] == [1]
    assert validated["entries"][0]["citation_edge_id"] == str(edge_id)
    assert validated["entries"][0]["kind"] == "supports"
    assert validated["entries"][0]["target_ref"] == {
        "type": "content_chunk",
        "id": str(target_id),
    }
    assert validated["entries"][0]["snapshot"]["section_label"] == "§2"


def test_citation_index_payload_rejects_legacy_citations_shape() -> None:
    """The ``{assistant_message_id, citations:[...]}`` shape is gone (extra=forbid)."""
    media_id = uuid4()
    with pytest.raises(ValidationError):
        ChatRunCitationIndexEventPayload.model_validate(
            {
                "assistant_message_id": str(uuid4()),
                "citations": [
                    CitationOut(
                        ordinal=1,
                        role="context",
                        target_ref=CitationTargetRef(type="media", id=media_id),
                        media_id=media_id,
                    ).model_dump(mode="json")
                ],
            }
        )


def test_chat_run_citation_index_entry_requires_marker_and_snapshot() -> None:
    """``ChatRunCitationIndexEntry`` exists; ``n`` is a 1-based marker, snapshot required."""
    edge_id = uuid4()
    target_id = uuid4()
    entry = ChatRunCitationIndexEntry(
        citation_edge_id=edge_id,
        n=2,
        target_ref=CitationTargetRef(type="note_block", id=target_id),
        kind="context",
        snapshot=CitationSnapshot(title="Note"),
    )
    assert entry.n == 2
    assert entry.deep_link is None

    # n is the [N] marker — 1-based, never 0.
    with pytest.raises(ValidationError):
        ChatRunCitationIndexEntry(
            citation_edge_id=edge_id,
            n=0,
            target_ref=CitationTargetRef(type="note_block", id=target_id),
            kind="context",
            snapshot=CitationSnapshot(title="Note"),
        )

    # snapshot is required (the chip always renders display fields).
    with pytest.raises(ValidationError):
        ChatRunCitationIndexEntry(
            citation_edge_id=edge_id,
            n=1,
            target_ref=CitationTargetRef(type="note_block", id=target_id),
            kind="context",
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
