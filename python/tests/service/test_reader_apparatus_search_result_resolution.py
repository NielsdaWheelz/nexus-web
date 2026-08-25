"""Durable Reader Apparatus search-result resolution behavior."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import (
    Fragment,
    Media,
    MediaKind,
    ProcessingStatus,
    ReaderApparatusItem,
    ReaderApparatusState,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultReaderApparatusItemOut
from nexus.services import bootstrap, library_entries
from nexus.services.search.resolver import get_search_result


@dataclass(frozen=True, slots=True)
class _ApparatusItem:
    media_id: UUID
    fragment_id: UUID
    item_id: UUID
    body_text: str


def _seed_apparatus_item(
    db: Session,
    *,
    viewer_id: UUID,
    label: str,
    state_status: str = "ready",
    locator_status: str = "exact",
    valid_locator: bool = True,
) -> _ApparatusItem:
    source_text = f"Source text for {label}."
    body_text = f"Durable {label} apparatus survives."
    media = Media(
        kind=MediaKind.web_article,
        title=f"{label.title()} apparatus source",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    fragment = Fragment(
        media=media,
        idx=0,
        canonical_text=source_text,
        html_sanitized=f"<p>{source_text}</p>",
    )
    db.add_all([media, fragment])
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
    published = state_status in ("ready", "partial")
    state = ReaderApparatusState(
        media_id=media.id,
        media_kind=MediaKind.web_article.value,
        source_fingerprint=f"apparatus-{label}",
        extractor_version="test",
        status=state_status,
        item_count=1 if published else 0,
        edge_count=0,
        diagnostics={},
    )
    db.add(state)
    db.flush()
    locator: dict[str, object] | None
    if locator_status == "missing":
        locator = None
    elif valid_locator:
        locator = {
            "type": "web_text_offsets",
            "media_id": str(media.id),
            "fragment_id": str(fragment.id),
            "start_offset": 0,
            "end_offset": len(source_text),
            "media_kind": MediaKind.web_article.value,
            "text_quote_selector": {
                "exact": source_text,
                "prefix": "",
                "suffix": "",
            },
        }
    else:
        locator = {"type": "web_text_offsets"}
    item = ReaderApparatusItem(
        media_id=media.id,
        state_id=state.id,
        stable_key=f"item-{label}",
        kind="footnote",
        label=f"{label.title()} footnote",
        body_text=body_text,
        locator=locator,
        locator_status=locator_status,
        confidence="exact",
        extraction_method="test",
        source_ref={"kind": "test"},
        sort_key="0001",
    )
    db.add(item)
    db.flush()
    return _ApparatusItem(
        media_id=media.id,
        fragment_id=fragment.id,
        item_id=item.id,
        body_text=body_text,
    )


def test_reader_apparatus_results_fail_closed_under_one_publication_contract(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"apparatus-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"apparatus-search-foreign-{foreign_id}@example.invalid",
        )
        ready = _seed_apparatus_item(db, viewer_id=owner_id, label="ready")
        partial = _seed_apparatus_item(
            db,
            viewer_id=owner_id,
            label="partial",
            state_status="partial",
        )
        foreign = _seed_apparatus_item(db, viewer_id=foreign_id, label="foreign")
        nonready = _seed_apparatus_item(
            db,
            viewer_id=owner_id,
            label="nonready",
            state_status="failed",
        )
        missing = _seed_apparatus_item(
            db,
            viewer_id=owner_id,
            label="missing",
            locator_status="missing",
        )
        malformed = _seed_apparatus_item(
            db,
            viewer_id=owner_id,
            label="malformed",
            valid_locator=False,
        )
        db.commit()

        ready_result = get_search_result(
            db,
            owner_id,
            "reader_apparatus_item",
            str(ready.item_id),
        )
        partial_result = get_search_result(
            db,
            owner_id,
            "reader_apparatus_item",
            str(partial.item_id),
        )

        assert isinstance(ready_result, SearchResultReaderApparatusItemOut)
        assert ready_result.id == ready.item_id
        assert ready_result.resource_ref == f"reader_apparatus_item:{ready.item_id}"
        assert ready_result.owner_resource_ref == f"media:{ready.media_id}"
        assert ready_result.apparatus_kind == "footnote"
        assert ready_result.snippet == ready.body_text
        assert ready_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "web_text_offsets",
            "media_id": str(ready.media_id),
            "fragment_id": str(ready.fragment_id),
            "start_offset": 0,
            "end_offset": len("Source text for ready."),
            "media_kind": MediaKind.web_article.value,
            "text_quote_selector": {
                "exact": "Source text for ready.",
                "prefix": "",
                "suffix": "",
            },
        }
        assert isinstance(partial_result, SearchResultReaderApparatusItemOut)
        assert partial_result.id == partial.item_id

        hidden_item_ids = (
            foreign.item_id,
            nonready.item_id,
            missing.item_id,
            malformed.item_id,
        )
        for hidden_item_id in hidden_item_ids:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(
                    db,
                    owner_id,
                    "reader_apparatus_item",
                    str(hidden_item_id),
                )
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
