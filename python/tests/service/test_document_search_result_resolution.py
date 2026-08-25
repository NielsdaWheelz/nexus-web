"""Priority proof for durable document-evidence search-result resolution."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    ContentChunk,
    ContentIndexState,
    EvidenceSpan,
    Fragment,
    Media,
    MediaKind,
    NoteBlock,
    ProcessingStatus,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import (
    SearchResultContentChunkOut,
    SearchResultEvidenceSpanOut,
    SearchResultFragmentOut,
)
from nexus.services import bootstrap, library_entries
from nexus.services.search.service import get_search_result


@dataclass(frozen=True, slots=True)
class _DocumentEvidence:
    media_id: UUID
    fragment_id: UUID
    evidence_span_id: UUID
    content_chunk_id: UUID
    text: str


def _seed_document_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    label: str,
) -> _DocumentEvidence:
    text = f"Durable {label} evidence survives."
    media = Media(
        kind=MediaKind.web_article,
        title=f"{label.title()} evidence source",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    fragment = Fragment(
        media=media,
        idx=0,
        canonical_text=text,
        html_sanitized=f"<p>{text}</p>",
    )
    db.add_all([media, fragment])
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
    selector = {
        "kind": "web_text",
        "fragment_id": str(fragment.id),
        "start_offset": 0,
        "end_offset": len(text),
        "text_quote": {"exact": text, "prefix": "", "suffix": ""},
    }
    block = ContentBlock(
        owner_kind="media",
        owner_id=media.id,
        block_idx=0,
        block_kind="paragraph",
        canonical_text=text,
        extraction_confidence=1.0,
        source_start_offset=0,
        source_end_offset=len(text),
        heading_path=[],
        locator=selector,
        selector=selector,
        metadata_json={},
    )
    db.add(block)
    db.flush()
    span = EvidenceSpan(
        owner_kind="media",
        owner_id=media.id,
        start_block_id=block.id,
        end_block_id=block.id,
        start_block_offset=0,
        end_block_offset=len(text),
        span_text=text,
        selector=selector,
        citation_label="paragraph 1",
        resolver_kind="web",
    )
    db.add(span)
    db.flush()
    chunk = ContentChunk(
        owner_kind="media",
        owner_id=media.id,
        primary_evidence_span_id=span.id,
        chunk_idx=0,
        source_kind="web_article",
        chunk_text=text,
        token_count=8,
        heading_path=[],
        summary_locator=selector,
    )
    db.add_all(
        [
            chunk,
            ContentIndexState(
                owner_kind="media",
                owner_id=media.id,
                revision=1,
                status="ready",
            ),
        ]
    )
    db.flush()
    return _DocumentEvidence(
        media_id=media.id,
        fragment_id=fragment.id,
        evidence_span_id=span.id,
        content_chunk_id=chunk.id,
        text=text,
    )


def _seed_note_evidence(db: Session, *, viewer_id: UUID) -> tuple[UUID, UUID, str]:
    text = "Durable note-owned evidence survives."
    note = NoteBlock(
        user_id=viewer_id,
        body_pm_json={"type": "doc", "content": []},
        body_text=text,
    )
    db.add(note)
    db.flush()
    selector = {
        "kind": "note_text",
        "note_block_id": str(note.id),
        "start_offset": 0,
        "end_offset": len(text),
        "text_quote": {"exact": text, "prefix": "", "suffix": ""},
    }
    block = ContentBlock(
        owner_kind="note_block",
        owner_id=note.id,
        block_idx=0,
        block_kind="paragraph",
        canonical_text=text,
        extraction_confidence=1.0,
        source_start_offset=0,
        source_end_offset=len(text),
        heading_path=[],
        locator=selector,
        selector=selector,
        metadata_json={},
    )
    db.add(block)
    db.flush()
    span = EvidenceSpan(
        owner_kind="note_block",
        owner_id=note.id,
        start_block_id=block.id,
        end_block_id=block.id,
        start_block_offset=0,
        end_block_offset=len(text),
        span_text=text,
        selector=selector,
        citation_label="note",
        resolver_kind="note",
    )
    db.add_all(
        [
            span,
            ContentIndexState(
                owner_kind="note_block",
                owner_id=note.id,
                revision=1,
                status="ready",
            ),
        ]
    )
    db.flush()
    return note.id, span.id, text


def test_document_results_reresolve_with_exact_evidence_and_owner_identity(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"document-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"document-search-foreign-{foreign_id}@example.invalid",
        )
        owned = _seed_document_evidence(db, viewer_id=owner_id, label="owned")
        foreign = _seed_document_evidence(db, viewer_id=foreign_id, label="foreign")
        note_id, note_span_id, note_text = _seed_note_evidence(db, viewer_id=owner_id)
        db.commit()

        chunk_result = get_search_result(
            db,
            owner_id,
            "content_chunk",
            str(owned.content_chunk_id),
            evidence_span_ids=[owned.evidence_span_id],
        )
        fragment_result = get_search_result(db, owner_id, "fragment", str(owned.fragment_id))
        span_result = get_search_result(
            db,
            owner_id,
            "evidence_span",
            str(owned.evidence_span_id),
        )
        note_span_result = get_search_result(
            db,
            owner_id,
            "evidence_span",
            str(note_span_id),
        )

        assert isinstance(chunk_result, SearchResultContentChunkOut)
        assert chunk_result.id == owned.content_chunk_id
        assert chunk_result.evidence_span_ids == [owned.evidence_span_id]
        assert chunk_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "web_text_offsets",
            "media_id": str(owned.media_id),
            "fragment_id": str(owned.fragment_id),
            "start_offset": 0,
            "end_offset": len(owned.text),
            "media_kind": MediaKind.web_article.value,
            "text_quote_selector": {"exact": owned.text, "prefix": "", "suffix": ""},
        }
        assert isinstance(fragment_result, SearchResultFragmentOut)
        assert fragment_result.id == owned.fragment_id
        assert fragment_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "web_text_offsets",
            "media_id": str(owned.media_id),
            "fragment_id": str(owned.fragment_id),
            "start_offset": 0,
            "end_offset": len(owned.text),
            "media_kind": MediaKind.web_article.value,
            "text_quote_selector": {"exact": owned.text, "prefix": "", "suffix": ""},
        }
        assert isinstance(span_result, SearchResultEvidenceSpanOut)
        assert span_result.id == owned.evidence_span_id
        assert span_result.owner_resource_ref == f"media:{owned.media_id}"
        assert isinstance(note_span_result, SearchResultEvidenceSpanOut)
        assert note_span_result.id == note_span_id
        assert note_span_result.owner_resource_ref == f"note_block:{note_id}"
        assert note_span_result.snippet == note_text
        assert note_span_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "note_block_offsets",
            "block_id": str(note_id),
            "start_offset": 0,
            "end_offset": len(note_text),
        }

        hidden_or_mismatched_refs = (
            ("content_chunk", foreign.content_chunk_id),
            ("fragment", foreign.fragment_id),
            ("evidence_span", foreign.evidence_span_id),
        )
        for result_type, result_id in hidden_or_mismatched_refs:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(db, owner_id, result_type, str(result_id))
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND

        with pytest.raises(NotFoundError) as mismatched_evidence:
            get_search_result(
                db,
                owner_id,
                "content_chunk",
                str(owned.content_chunk_id),
                evidence_span_ids=[uuid4()],
            )
        assert mismatched_evidence.value.code is ApiErrorCode.E_NOT_FOUND
