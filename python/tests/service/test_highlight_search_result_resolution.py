"""Durable Highlight search-result resolution behavior."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentIndexState,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
    MediaKind,
    ProcessingStatus,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultHighlightOut
from nexus.services import bootstrap, library_entries
from nexus.services.search.service import get_search_result


@dataclass(frozen=True, slots=True)
class _FragmentHighlight:
    media_id: UUID
    fragment_id: UUID
    highlight_id: UUID
    text: str


@dataclass(frozen=True, slots=True)
class _PdfHighlight:
    media_id: UUID
    highlight_id: UUID
    text: str


def _seed_fragment_highlight(
    db: Session,
    *,
    viewer_id: UUID,
    label: str,
    ready_index: bool = True,
) -> _FragmentHighlight:
    text = f"Durable {label} highlight survives."
    media = Media(
        kind=MediaKind.web_article,
        title=f"{label.title()} highlight source",
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
    highlight = Highlight(
        user_id=viewer_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media.id,
        color="purple",
        exact=text,
        prefix="",
        suffix="",
    )
    db.add(highlight)
    db.flush()
    db.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment.id,
            start_offset=0,
            end_offset=len(text),
        )
    )
    if ready_index:
        db.add(
            ContentIndexState(
                owner_kind="media",
                owner_id=media.id,
                revision=1,
                status="ready",
            )
        )
    db.flush()
    return _FragmentHighlight(
        media_id=media.id,
        fragment_id=fragment.id,
        highlight_id=highlight.id,
        text=text,
    )


def _seed_pdf_highlight(db: Session, *, viewer_id: UUID) -> _PdfHighlight:
    text = "Durable PDF geometry survives."
    media = Media(
        kind=MediaKind.pdf,
        title="PDF highlight source",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    db.add(media)
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
    highlight = Highlight(
        user_id=viewer_id,
        anchor_kind="pdf_page_geometry",
        anchor_media_id=media.id,
        color="green",
        exact=text,
        prefix="before",
        suffix="after",
    )
    db.add(highlight)
    db.flush()
    db.add_all(
        [
            HighlightPdfAnchor(
                highlight_id=highlight.id,
                media_id=media.id,
                page_number=2,
                sort_top=Decimal("2"),
                sort_left=Decimal("1"),
                plain_text_match_status="unique",
                plain_text_start_offset=10,
                plain_text_end_offset=10 + len(text),
                rect_count=1,
            ),
            HighlightPdfQuad(
                highlight_id=highlight.id,
                quad_idx=0,
                x1=Decimal("1"),
                y1=Decimal("2"),
                x2=Decimal("3"),
                y2=Decimal("2"),
                x3=Decimal("3"),
                y3=Decimal("4"),
                x4=Decimal("1"),
                y4=Decimal("4"),
            ),
            ContentIndexState(
                owner_kind="media",
                owner_id=media.id,
                revision=1,
                status="ready",
            ),
        ]
    )
    db.flush()
    return _PdfHighlight(media_id=media.id, highlight_id=highlight.id, text=text)


def test_highlight_results_reresolve_typed_anchors_under_one_visibility_contract(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"highlight-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"highlight-search-foreign-{foreign_id}@example.invalid",
        )
        fragment = _seed_fragment_highlight(db, viewer_id=owner_id, label="fragment")
        pdf = _seed_pdf_highlight(db, viewer_id=owner_id)
        foreign = _seed_fragment_highlight(db, viewer_id=foreign_id, label="foreign")
        unindexed = _seed_fragment_highlight(
            db,
            viewer_id=owner_id,
            label="unindexed",
            ready_index=False,
        )
        db.commit()

        fragment_result = get_search_result(
            db,
            owner_id,
            "highlight",
            str(fragment.highlight_id),
        )
        pdf_result = get_search_result(
            db,
            owner_id,
            "highlight",
            str(pdf.highlight_id),
        )

        assert isinstance(fragment_result, SearchResultHighlightOut)
        assert fragment_result.resource_ref == f"highlight:{fragment.highlight_id}"
        assert fragment_result.owner_resource_ref == f"media:{fragment.media_id}"
        assert fragment_result.exact == fragment.text
        assert fragment_result.color == "purple"
        assert fragment_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "web_text_offsets",
            "media_id": str(fragment.media_id),
            "fragment_id": str(fragment.fragment_id),
            "start_offset": 0,
            "end_offset": len(fragment.text),
            "media_kind": MediaKind.web_article.value,
            "text_quote_selector": {
                "exact": fragment.text,
                "prefix": "",
                "suffix": "",
            },
        }
        assert isinstance(pdf_result, SearchResultHighlightOut)
        assert pdf_result.owner_resource_ref == f"media:{pdf.media_id}"
        assert pdf_result.exact == pdf.text
        assert pdf_result.color == "green"
        assert pdf_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "pdf_page_geometry",
            "media_id": str(pdf.media_id),
            "page_number": 2,
            "quads": [
                {
                    "x1": 1.0,
                    "y1": 2.0,
                    "x2": 3.0,
                    "y2": 2.0,
                    "x3": 3.0,
                    "y3": 4.0,
                    "x4": 1.0,
                    "y4": 4.0,
                }
            ],
            "exact": pdf.text,
            "prefix": "before",
            "suffix": "after",
            "text_quote_selector": {
                "exact": pdf.text,
                "prefix": "before",
                "suffix": "after",
            },
        }

        for hidden_highlight_id in (foreign.highlight_id, unindexed.highlight_id):
            with pytest.raises(NotFoundError) as denied:
                get_search_result(
                    db,
                    owner_id,
                    "highlight",
                    str(hidden_highlight_id),
                )
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
