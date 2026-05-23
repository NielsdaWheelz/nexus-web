"""Unit tests for PDF quote helper branches in context_rendering."""

from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from nexus.db.models import (
    NoteBlock,
    Page,
)
from nexus.schemas.conversation import ReaderSelectionContext
from nexus.schemas.notes import ObjectRef
from nexus.services import context_rendering, object_refs

pytestmark = pytest.mark.unit


class TestTypedAnchorRendering:
    def test_render_note_block_context(self):
        page_id = uuid4()
        block = NoteBlock(
            id=uuid4(),
            user_id=uuid4(),
            page_id=page_id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="note",
            body_text="note",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=block.user_id,
            page_id=page_id,
            parent_block_id=block.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = block
        db.scalars.return_value = [block, child]

        rendered = context_rendering._render_note_context(db, "note_block", block.id)

        assert rendered is not None
        assert "<note_block>" in rendered
        assert "<content>- note\n  - child</content>" in rendered

    def test_render_page_context_preserves_outline_hierarchy(self):
        page_id = uuid4()
        user_id = uuid4()
        page = Page(id=page_id, user_id=user_id, title="Outline Page")
        parent = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="parent",
            body_text="parent",
            collapsed=False,
        )
        sibling = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000002",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="sibling",
            body_text="sibling",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            parent_block_id=parent.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = page
        db.scalars.return_value = [parent, sibling, child]

        rendered = context_rendering._render_note_context(db, "page", page_id)

        assert rendered is not None
        assert "<content>- parent\n  - child\n- sibling</content>" in rendered

    def test_object_ref_page_context_preserves_outline_hierarchy(self):
        page_id = uuid4()
        user_id = uuid4()
        page = Page(id=page_id, user_id=user_id, title="Lookup Page")
        parent = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000001",
            block_kind="heading",
            body_pm_json={"type": "paragraph"},
            body_markdown="Section",
            body_text="Section",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            parent_block_id=parent.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = page
        db.scalars.return_value = [parent, child]

        rendered = object_refs.render_object_context(
            db,
            user_id,
            ObjectRef(object_type="page", object_id=page_id),
        )

        assert '<context_lookup_result type="page">' in rendered
        assert "<content># Section\n  - child</content>" in rendered

    def test_render_reader_selection_context_includes_quote_surrounding_and_locator(self):
        media_id = uuid4()
        fragment_id = uuid4()
        source_version = "content-index:v1"
        rendered, total_chars = context_rendering.render_context_blocks(
            MagicMock(),
            [
                ReaderSelectionContext(
                    kind="reader_selection",
                    client_context_id=uuid4(),
                    media_id=media_id,
                    media_kind="web_article",
                    media_title="Reader Source",
                    exact="selected quote",
                    prefix="before ",
                    suffix=" after",
                    source_version=source_version,
                    locator={
                        "type": "web_text_offsets",
                        "media_id": str(media_id),
                        "fragment_id": str(fragment_id),
                        "start_offset": 7,
                        "end_offset": 21,
                    },
                )
            ],
        )

        assert total_chars > 0
        assert "<reader_selection>" in rendered
        assert "<source>Reader Source</source>" in rendered
        assert "<quote>selected quote</quote>" in rendered
        assert "<surrounding>before selected quote after</surrounding>" in rendered
        assert "<source_locator>" in rendered
        assert '"type":"web_text_offsets"' in rendered
        assert f"<source_version>{source_version}</source_version>" in rendered
