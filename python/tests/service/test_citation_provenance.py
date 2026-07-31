"""Priority proof: published citations resolve position from canonical targets."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    Conversation,
    EvidenceSpan,
    Fragment,
    Media,
    MediaKind,
    Message,
    ProcessingStatus,
    ResourceEdge,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.resource_graph.citations import build_citation_outs, record_citation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot
from tests.testkit.auth import UserRecord


def test_published_citation_reconstructs_locator_from_canonical_evidence(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = uuid4()
    fragment_id = uuid4()
    block_id = uuid4()
    evidence_id = uuid4()
    conversation_id = uuid4()
    user_message_id = uuid4()
    assistant_message_id = uuid4()
    exact = "Evidence"
    selector = {
        "kind": "web_text",
        "fragment_id": str(fragment_id),
        "start_offset": 0,
        "end_offset": len(exact),
        "text_quote": {"exact": exact, "prefix": "", "suffix": " survives."},
    }
    db_session.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Canonical source",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=test_user.id,
            ),
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Evidence survives.",
                html_sanitized="<p>Evidence survives.</p>",
            ),
            Conversation(id=conversation_id, owner_user_id=test_user.id),
            Message(
                id=user_message_id,
                conversation_id=conversation_id,
                seq=1,
                role="user",
                content="Find the evidence.",
            ),
            Message(
                id=assistant_message_id,
                conversation_id=conversation_id,
                seq=2,
                role="assistant",
                content="Citing output [1]",
                parent_message_id=user_message_id,
            ),
        ]
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    db_session.add(
        ContentBlock(
            id=block_id,
            owner_kind="media",
            owner_id=media_id,
            block_idx=0,
            block_kind="paragraph",
            canonical_text="Evidence survives.",
            extraction_confidence=1.0,
            source_start_offset=0,
            source_end_offset=len("Evidence survives."),
            parent_block_id=None,
            heading_path=[],
            locator=selector,
            selector=selector,
            metadata_json={},
        )
    )
    db_session.flush()
    db_session.add(
        EvidenceSpan(
            id=evidence_id,
            owner_kind="media",
            owner_id=media_id,
            start_block_id=block_id,
            end_block_id=block_id,
            start_block_offset=0,
            end_block_offset=len(exact),
            span_text=exact,
            selector=selector,
            citation_label="paragraph 1",
            resolver_kind="web",
        )
    )
    db_session.flush()

    source = ResourceRef("message", assistant_message_id)
    target = ResourceRef("evidence_span", evidence_id)
    edge = record_citation(
        db_session,
        viewer_id=test_user.id,
        source=source,
        target=target,
        ordinal=1,
        kind="supports",
        snapshot=CitationSnapshot(
            title="Frozen display title",
            excerpt="Frozen display excerpt",
            deep_link="/display-only-snapshot",
        ),
    )

    citation = build_citation_outs(
        db_session,
        viewer_id=test_user.id,
        source=source,
    )[0]
    persisted_edge = db_session.get(ResourceEdge, edge.id)
    assert persisted_edge is not None, f"citation edge {edge.id} was not persisted"
    persisted = persisted_edge.snapshot

    assert "locator" not in persisted, f"citation edge duplicated target position: {persisted!r}"
    assert citation.media_id == media_id
    assert citation.locator is not None
    assert citation.locator.model_dump(mode="json") == {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 0,
        "end_offset": len(exact),
        "media_kind": MediaKind.web_article.value,
        "text_quote_selector": {
            "exact": exact,
            "prefix": "",
            "suffix": " survives.",
        },
    }, f"citation did not publish the canonical evidence locator: {citation.locator!r}"
    assert citation.deep_link == "/display-only-snapshot"
