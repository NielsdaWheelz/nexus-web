"""Priority proof for durable Notes-domain search-result resolution."""

from __future__ import annotations

from importlib import import_module
from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import ContentIndexState, NoteBlock, Page
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultNoteBlockOut, SearchResultPageOut
from nexus.services import bootstrap
from nexus.services.search.service import get_search_result


def test_notes_result_resolution_has_one_domain_owner() -> None:
    owner = import_module("nexus.services.search.retrievers.notes")
    resolver = getattr(owner, "resolve_notes_search_result", None)

    assert resolver is not None
    assert resolver.__module__ == owner.__name__


def test_page_and_note_block_results_reresolve_under_one_owner_contract(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"notes-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"notes-search-foreign-{foreign_id}@example.invalid",
        )
        page = Page(user_id=owner_id, title="Durable page result")
        foreign_page = Page(user_id=foreign_id, title="Foreign page result")
        note = NoteBlock(
            user_id=owner_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Durable note block result",
        )
        foreign_note = NoteBlock(
            user_id=foreign_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Foreign note block result",
        )
        unready_note = NoteBlock(
            user_id=owner_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Unready note block result",
        )
        db.add_all([page, foreign_page, note, foreign_note, unready_note])
        db.flush()
        db.add_all(
            [
                ContentIndexState(
                    owner_kind="note_block",
                    owner_id=note.id,
                    revision=1,
                    status="ready",
                ),
                ContentIndexState(
                    owner_kind="note_block",
                    owner_id=foreign_note.id,
                    revision=1,
                    status="ready",
                ),
            ]
        )
        db.commit()

        page_result = get_search_result(db, owner_id, "page", str(page.id))
        note_result = get_search_result(db, owner_id, "note_block", str(note.id))

        assert isinstance(page_result, SearchResultPageOut)
        assert page_result.id == page.id
        assert page_result.title == page.title
        assert page_result.snippet == page.title

        assert isinstance(note_result, SearchResultNoteBlockOut)
        assert note_result.id == note.id
        assert note_result.body_text == note.body_text
        assert note_result.snippet == note.body_text
        assert note_result.note_origin == "note"
        assert note_result.highlight_excerpt is None
        assert note_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "note_block_offsets",
            "block_id": str(note.id),
            "start_offset": 0,
            "end_offset": len(note.body_text),
        }

        hidden_refs = (
            (owner_id, "page", foreign_page.id),
            (owner_id, "note_block", foreign_note.id),
            (owner_id, "note_block", unready_note.id),
        )
        for viewer_id, result_type, result_id in hidden_refs:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(db, viewer_id, result_type, str(result_id))
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
