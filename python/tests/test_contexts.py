"""Service-layer tests for message context management.

Tests cover the helpers in services/contexts.py:
- Insert message context items with ordinal ordering
- Compute media_id from context targets (media, highlight, note_block)
- Transactionally upsert conversation_media
"""

import json
from uuid import UUID, uuid4

import pytest
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import ChatContextInput, MessageContextRef, ReaderSelectionContext
from nexus.services import contexts as contexts_service
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.context_assembler import load_message_context_refs
from nexus.services.conversations import load_message_context_snapshots_for_message_ids
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.message_context_snapshots import object_ref_context_snapshot
from tests.factories import activate_replacement_content_index_run, create_searchable_media

pytestmark = pytest.mark.integration

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def user_with_library(db_session: Session) -> tuple:
    """Create a user with their default library.

    Returns:
        Tuple of (user_id, default_library_id)
    """
    user_id = uuid4()
    default_library_id = ensure_user_and_default_library(db_session, user_id)
    return user_id, default_library_id


@pytest.fixture
def conversation_with_message(db_session: Session, user_with_library: tuple) -> tuple:
    """Create a conversation with a message.

    Returns:
        Tuple of (conversation_id, message_id, user_id, default_library_id)
    """
    user_id, default_library_id = user_with_library

    conversation_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, 'private', 2)
        """),
        {"id": conversation_id, "owner_user_id": user_id},
    )

    message_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :conversation_id, 1, 'user', 'Test message', 'complete')
        """),
        {"id": message_id, "conversation_id": conversation_id},
    )
    db_session.flush()

    return conversation_id, message_id, user_id, default_library_id


@pytest.fixture
def media_with_highlight(db_session: Session, user_with_library: tuple) -> tuple:
    """Create a media item with a fragment and highlight.

    Returns:
        Tuple of (media_id, fragment_id, highlight_id, note_block_id)
    """
    user_id, default_library_id = user_with_library

    # Create media
    media_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading')
        """),
        {"id": media_id},
    )
    db_session.execute(
        text("""
            INSERT INTO library_entries (library_id, media_id, position)
            VALUES (:library_id, :media_id, 0)
        """),
        {"library_id": default_library_id, "media_id": media_id},
    )
    db_session.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            VALUES (:library_id, :media_id)
        """),
        {"library_id": default_library_id, "media_id": media_id},
    )

    # Create fragment
    fragment_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
            VALUES (:id, :media_id, 0, 'Test canonical text', '<p>Test</p>')
        """),
        {"id": fragment_id, "media_id": media_id},
    )
    db_session.flush()
    fragment = db_session.get(Fragment, fragment_id)
    assert fragment is not None
    insert_fragment_blocks(
        db_session,
        fragment.id,
        parse_fragment_blocks(fragment.canonical_text),
    )
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        artifact_ref=f"fragments:{fragment_id}",
        fragments=[fragment],
        reason="test_contexts",
    )

    # Create highlight
    highlight_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO highlights (
                id,
                user_id,
                anchor_kind,
                anchor_media_id,
                color,
                exact,
                prefix,
                suffix
            )
            VALUES (
                :id,
                :user_id,
                'fragment_offsets',
                :media_id,
                'yellow',
                'Test',
                '',
                ' canonical'
            )
        """),
        {
            "id": highlight_id,
            "user_id": user_id,
            "media_id": media_id,
        },
    )
    db_session.execute(
        text("""
            INSERT INTO highlight_fragment_anchors (
                highlight_id,
                fragment_id,
                start_offset,
                end_offset
            )
            VALUES (:highlight_id, :fragment_id, 0, 4)
        """),
        {"highlight_id": highlight_id, "fragment_id": fragment_id},
    )

    page_id = uuid4()
    note_block_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO pages (id, user_id, title)
            VALUES (:id, :user_id, 'Context Test Notes')
        """),
        {"id": page_id, "user_id": user_id},
    )
    db_session.execute(
        text("""
            INSERT INTO note_blocks (
                id,
                user_id,
                page_id,
                order_key,
                block_kind,
                body_pm_json,
                body_markdown,
                body_text,
                collapsed
            )
            VALUES (
                :id,
                :user_id,
                :page_id,
                '0000000001',
                'bullet',
                jsonb_build_object(
                    'type',
                    'paragraph',
                    'content',
                    jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Test note'))
                ),
                'Test note',
                'Test note',
                false
            )
        """),
        {"id": note_block_id, "user_id": user_id, "page_id": page_id},
    )
    db_session.execute(
        text("""
            INSERT INTO object_links (
                user_id,
                relation_type,
                a_type,
                a_id,
                b_type,
                b_id,
                metadata
            )
            VALUES (
                :user_id,
                'note_about',
                'note_block',
                :note_block_id,
                'highlight',
                :highlight_id,
                '{}'::jsonb
            )
        """),
        {"user_id": user_id, "note_block_id": note_block_id, "highlight_id": highlight_id},
    )

    db_session.flush()

    return media_id, fragment_id, highlight_id, note_block_id


def _create_pdf_media_with_highlight(db_session: Session, user_id: UUID) -> tuple:
    """Create a PDF media item with a canonical typed highlight."""
    media_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, 'pdf', 'Test PDF', 'ready_for_reading')
        """),
        {"id": media_id},
    )
    db_session.execute(
        text("""
            INSERT INTO library_entries (library_id, media_id, position)
            SELECT id, :media_id, 0
            FROM libraries
            WHERE owner_user_id = :user_id
              AND is_default = true
        """),
        {"user_id": user_id, "media_id": media_id},
    )
    db_session.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            SELECT id, :media_id
            FROM libraries
            WHERE owner_user_id = :user_id
              AND is_default = true
        """),
        {"user_id": user_id, "media_id": media_id},
    )

    highlight_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO highlights (
                id,
                user_id,
                anchor_kind,
                anchor_media_id,
                color,
                exact,
                prefix,
                suffix
            )
            VALUES (
                :id,
                :user_id,
                'pdf_page_geometry',
                :media_id,
                'yellow',
                'pdf quote',
                '',
                ''
            )
        """),
        {"id": highlight_id, "user_id": user_id, "media_id": media_id},
    )
    db_session.execute(
        text("""
            INSERT INTO highlight_pdf_anchors (
                highlight_id,
                media_id,
                page_number,
                geometry_version,
                geometry_fingerprint,
                sort_top,
                sort_left,
                plain_text_match_version,
                plain_text_match_status,
                plain_text_start_offset,
                plain_text_end_offset,
                rect_count
            )
            VALUES (
                :highlight_id,
                :media_id,
                1,
                1,
                'fingerprint',
                0,
                0,
                1,
                'unique',
                0,
                9,
                1
            )
        """),
        {"highlight_id": highlight_id, "media_id": media_id},
    )
    db_session.flush()
    return media_id, highlight_id


def _context_ref(target_type: str, target_id: UUID) -> MessageContextRef:
    return MessageContextRef(kind="object_ref", type=target_type, id=target_id)


def _insert_object_ref_context_item(
    db_session: Session,
    *,
    context_id: UUID,
    message_id: UUID,
    user_id: UUID,
    object_type: str,
    object_id: UUID,
    title: str,
    source_media_id: UUID | None = None,
) -> None:
    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                id,
                message_id,
                user_id,
                context_kind,
                object_type,
                object_id,
                source_media_id,
                ordinal,
                context_snapshot
            )
            VALUES (
                :id,
                :message_id,
                :user_id,
                'object_ref',
                :object_type,
                :object_id,
                :source_media_id,
                0,
                :context_snapshot
            )
            """
        ).bindparams(bindparam("context_snapshot", type_=JSONB)),
        {
            "id": context_id,
            "message_id": message_id,
            "user_id": user_id,
            "object_type": object_type,
            "object_id": object_id,
            "source_media_id": source_media_id,
            "context_snapshot": object_ref_context_snapshot(
                object_type=object_type,
                object_id=object_id,
                title=title,
            ),
        },
    )


def _reader_selection(media_id: UUID, fragment_id: UUID | None = None) -> ReaderSelectionContext:
    selected_fragment_id = fragment_id or uuid4()
    return ReaderSelectionContext(
        kind="reader_selection",
        client_context_id=uuid4(),
        media_id=media_id,
        media_kind="web_article",
        media_title="Test Article",
        exact="Test",
        prefix="",
        suffix=" canonical",
        source_version="fragments_v1",
        locator={
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(selected_fragment_id),
            "start_offset": 0,
            "end_offset": 4,
        },
    )


class TestContextSchema:
    def test_chat_context_input_requires_kind(self):
        adapter = TypeAdapter(ChatContextInput)

        with pytest.raises(ValidationError):
            adapter.validate_python({"type": "media", "id": str(uuid4())})

        parsed = adapter.validate_python(
            {"kind": "object_ref", "type": "media", "id": str(uuid4())}
        )
        assert parsed.kind == "object_ref"

    def test_reader_selection_requires_quote_and_locator(self):
        with pytest.raises(ValidationError):
            ReaderSelectionContext(
                kind="reader_selection",
                client_context_id=uuid4(),
                media_id=uuid4(),
                media_kind="web_article",
                media_title="Article",
                exact=" ",
                source_version="fragments_v1",
                locator={},
            )

        with pytest.raises(ValidationError):
            ReaderSelectionContext(
                kind="reader_selection",
                client_context_id=uuid4(),
                media_id=uuid4(),
                media_kind="web_article",
                media_title="Article",
                exact="Quote",
                locator={
                    "type": "web_text_offsets",
                    "media_id": str(uuid4()),
                    "fragment_id": str(uuid4()),
                    "start_offset": 0,
                    "end_offset": 5,
                },
            )


# =============================================================================
# Media ID Resolution Tests
# =============================================================================


class TestMediaIdResolution:
    """Tests for resolving media_id from context targets."""

    def test_resolve_media_direct(self, db_session: Session, media_with_highlight: tuple):
        """Direct media reference returns media_id."""
        media_id, _fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("media", media_id),
        )

        assert resolved == media_id

    def test_resolve_highlight_via_fragment(self, db_session: Session, media_with_highlight: tuple):
        """Highlight reference resolves via fragment to media_id."""
        media_id, _fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("highlight", highlight_id),
        )

        assert resolved == media_id

    def test_resolve_highlight_via_pdf_anchor(self, db_session: Session, user_with_library: tuple):
        """PDF highlight reference resolves via typed anchor to media_id."""
        user_id, default_library_id = user_with_library
        media_id, highlight_id = _create_pdf_media_with_highlight(db_session, user_id)

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("highlight", highlight_id),
        )

        assert resolved == media_id

    def test_resolve_note_block_via_highlight_fragment(
        self, db_session: Session, media_with_highlight: tuple
    ):
        """Note block linked to a highlight resolves through that highlight's media."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("note_block", note_block_id),
        )

        assert resolved == media_id

    def test_resolve_note_block_via_reverse_highlight_link(
        self, db_session: Session, media_with_highlight: tuple, user_with_library: tuple
    ):
        """Reverse-oriented object links resolve the same note media source."""
        user_id, _default_library_id = user_with_library
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight
        db_session.execute(
            text("""
                DELETE FROM object_links
                WHERE relation_type = 'note_about'
                  AND a_type = 'note_block'
                  AND a_id = :note_block_id
                  AND b_type = 'highlight'
                  AND b_id = :highlight_id
            """),
            {"note_block_id": note_block_id, "highlight_id": highlight_id},
        )
        db_session.execute(
            text("""
                INSERT INTO object_links (
                    user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                )
                VALUES (
                    :user_id, 'note_about', 'highlight', :highlight_id,
                    'note_block', :note_block_id, '{}'::jsonb
                )
            """),
            {"user_id": user_id, "highlight_id": highlight_id, "note_block_id": note_block_id},
        )

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("note_block", note_block_id),
        )

        assert resolved == media_id

    def test_resolve_nonexistent_media(self, db_session: Session):
        """Non-existent media raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(
                db_session,
                _context_ref("media", uuid4()),
            )

    def test_resolve_nonexistent_highlight(self, db_session: Session):
        """Non-existent highlight raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(
                db_session,
                _context_ref("highlight", uuid4()),
            )

    def test_resolve_nonexistent_note_block(self, db_session: Session):
        """Non-existent note block raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(
                db_session,
                _context_ref("note_block", uuid4()),
            )

    def test_resolve_unlinked_note_block_returns_none(
        self, db_session: Session, user_with_library: tuple
    ):
        """Unlinked notes can be context without implying a source media row."""
        user_id, default_library_id = user_with_library
        page_id = uuid4()
        note_block_id = uuid4()
        db_session.execute(
            text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Loose Notes')"),
            {"id": page_id, "user_id": user_id},
        )
        db_session.execute(
            text("""
                INSERT INTO note_blocks (
                    id, user_id, page_id, order_key, block_kind,
                    body_pm_json, body_markdown, body_text, collapsed
                )
                VALUES (
                    :id, :user_id, :page_id, '0000000001', 'bullet',
                    jsonb_build_object('type', 'paragraph'),
                    '', '', false
                )
            """),
            {"id": note_block_id, "user_id": user_id, "page_id": page_id},
        )

        assert (
            contexts_service.resolve_media_id_for_context(
                db_session,
                _context_ref("note_block", note_block_id),
            )
            is None
        )


# =============================================================================
# Context Insertion Tests
# =============================================================================


class TestContextInsertion:
    """Tests for inserting message contexts."""

    def test_insert_media_context(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Insert a media context."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        context = contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=_context_ref("media", media_id),
        )

        assert context.message_id == message_id
        assert context.ordinal == 0
        assert context.object_type == "media"
        assert context.object_id == media_id
        assert context.context_kind == "object_ref"
        assert context.source_media_id is None
        assert context.locator_json is None
        assert context.context_snapshot_json["kind"] == "object_ref"

    def test_insert_content_chunk_context_persists_citable_provenance(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        _conversation_id, message_id, user_id, _default_library_id = conversation_with_message
        media_id = create_searchable_media(db_session, user_id, title="Citable Source")
        row = (
            db_session.execute(
                text(
                    """
                    SELECT
                        cc.id AS chunk_id,
                        cc.primary_evidence_span_id AS evidence_span_id,
                        ss.source_version AS source_version
                    FROM content_chunks cc
                    JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                    JOIN source_snapshots ss ON ss.id = es.source_snapshot_id
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )

        context = contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=MessageContextRef(
                kind="object_ref",
                type="content_chunk",
                id=row["chunk_id"],
                evidence_span_ids=[row["evidence_span_id"]],
            ),
        )

        snapshot = context.context_snapshot_json
        assert context.source_media_id == media_id
        assert snapshot["source_version"] == row["source_version"]
        assert snapshot["evidence_span_ids"] == [str(row["evidence_span_id"])]
        assert snapshot["locator"]["type"] == "web_text_offsets"
        assert snapshot["locator"]["media_id"] == str(media_id)

        refs = load_message_context_refs(db_session, message_id)
        assert len(refs) == 1
        ref = refs[0]
        assert isinstance(ref, MessageContextRef)
        assert ref.source_version == row["source_version"]
        assert ref.locator is not None
        assert ref.locator.model_dump(mode="json") == snapshot["locator"]

        snapshots = load_message_context_snapshots_for_message_ids(db_session, [message_id])
        readback = snapshots[message_id][0].model_dump(mode="json")
        assert readback["source_version"] == row["source_version"]
        assert readback["locator"] == snapshot["locator"]

    def test_insert_content_chunk_context_rejects_stale_evidence_span(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        _conversation_id, message_id, user_id, _library_id = conversation_with_message
        media_id = create_searchable_media(db_session, user_id, title="Stale context source")
        row = (
            db_session.execute(
                text(
                    """
                    SELECT
                        cc.id AS chunk_id,
                        cc.index_run_id AS active_run_id,
                        cc.primary_evidence_span_id AS evidence_span_id
                    FROM content_chunks cc
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        activate_replacement_content_index_run(
            db_session,
            media_id=media_id,
            active_run_id=row["active_run_id"],
        )

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=message_id,
                ordinal=0,
                context=MessageContextRef(
                    kind="object_ref",
                    type="content_chunk",
                    id=row["chunk_id"],
                    evidence_span_ids=[row["evidence_span_id"]],
                ),
            )

        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_content_chunk_evidence_span_ids_rejects_duplicates(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        _conversation_id, _message_id, user_id, _library_id = conversation_with_message
        media_id = create_searchable_media(db_session, user_id, title="Duplicate span source")
        row = (
            db_session.execute(
                text(
                    """
                    SELECT
                        cc.id AS chunk_id,
                        cc.primary_evidence_span_id AS evidence_span_id
                    FROM content_chunks cc
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )

        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_content_chunk_evidence_span_ids(
                db_session,
                row["chunk_id"],
                [row["evidence_span_id"], row["evidence_span_id"]],
            )

        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_insert_reader_selection_context(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Insert an unsaved reader selection without creating a fake object ref."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight
        selection = _reader_selection(media_id, fragment_id)
        expected_locator = selection.locator.model_dump(mode="json", exclude_none=True)
        expected_locator["text_quote_selector"] = {
            "exact": "Test",
            "prefix": "",
            "suffix": " canonical text",
        }

        context = contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=selection,
        )

        assert context.context_kind == "reader_selection"
        assert context.object_type is None
        assert context.object_id is None
        assert context.source_media_id == media_id
        assert context.locator_json == expected_locator
        assert context.context_snapshot_json["kind"] == "reader_selection"
        assert context.context_snapshot_json["exact"] == "Test"
        assert context.context_snapshot_json["locator"] == expected_locator
        assert (
            context.context_snapshot_json["evidence_verification"] == "source_text_exact_match_v1"
        )

        link = (
            db_session.execute(
                text("""
                SELECT b_type, b_id, b_locator, metadata
                FROM object_links
                WHERE user_id = :user_id
                  AND relation_type = 'used_as_context'
                  AND a_type = 'message'
                  AND a_id = :message_id
                  AND b_type = 'media'
                  AND b_id = :media_id
            """),
                {"user_id": user_id, "message_id": message_id, "media_id": media_id},
            )
            .mappings()
            .one()
        )
        assert link["b_locator"] == expected_locator
        assert link["metadata"]["context_kind"] == "reader_selection"
        assert link["metadata"]["context_item_id"] == str(context.id)
        assert link["metadata"]["evidence_verification"] == "source_text_exact_match_v1"

        snapshots = load_message_context_snapshots_for_message_ids(db_session, [message_id])
        snapshot = snapshots[message_id][0].model_dump(mode="json")
        assert snapshot["kind"] == "reader_selection"
        assert snapshot["client_context_id"] == str(selection.client_context_id)
        assert snapshot["media_id"] == str(media_id)
        assert snapshot["source_media_id"] == str(media_id)
        assert snapshot["exact"] == "Test"
        assert snapshot["locator"] == expected_locator
        assert snapshot["source_version"] == "fragments_v1"

    def test_insert_reader_selection_context_rejects_exact_mismatch(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        _conversation_id, message_id, _user_id, _default_library_id = conversation_with_message
        media_id, fragment_id, _highlight_id, _note_block_id = media_with_highlight
        selection = _reader_selection(media_id, fragment_id).model_copy(
            update={"exact": "Wrong quote"}
        )

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=message_id,
                ordinal=0,
                context=selection,
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_insert_reader_selection_context_rejects_stale_source_version(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        _conversation_id, message_id, _user_id, _default_library_id = conversation_with_message
        media_id, fragment_id, _highlight_id, _note_block_id = media_with_highlight
        selection = _reader_selection(media_id, fragment_id).model_copy(
            update={"source_version": f"fragment:{fragment_id}"}
        )

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=message_id,
                ordinal=0,
                context=selection,
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_insert_reader_selection_context_requires_durable_source_index(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        _conversation_id, message_id, _user_id, _default_library_id = conversation_with_message
        media_id, fragment_id, _highlight_id, _note_block_id = media_with_highlight
        db_session.execute(
            text("DELETE FROM media_content_index_states WHERE media_id = :media_id"),
            {"media_id": media_id},
        )

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=message_id,
                ordinal=0,
                context=_reader_selection(media_id, fragment_id),
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_artifact_part_context_replay_and_readback_preserve_provenance(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        conversation_id, message_id, user_id, _default_library_id = conversation_with_message
        artifact_id = uuid4()
        part_id = uuid4()
        source_version = f"artifact_part:{part_id}:v1"
        locator = {
            "type": "artifact_part_ref",
            "artifact_id": str(artifact_id),
            "artifact_part_id": str(part_id),
            "message_id": str(message_id),
            "conversation_id": str(conversation_id),
            "part_key": "claim-1",
        }
        provenance = {
            "type": "artifact_part",
            "artifact_id": str(artifact_id),
            "artifact_kind": "briefing_document",
            "message_id": str(message_id),
            "conversation_id": str(conversation_id),
            "artifact_key": "brief-1",
            "artifact_version": 2,
            "artifact_part_id": str(part_id),
            "ordinal": 0,
            "part_key": "claim-1",
            "part_type": "claim",
            "text": "Durable claim text",
            "source_version": source_version,
            "locator": locator,
        }
        snapshot = {
            "kind": "object_ref",
            "type": "artifact_part",
            "id": str(part_id),
            "title": "claim-1",
            "preview": "Durable claim text",
            "artifact_id": str(artifact_id),
            "artifact_key": "brief-1",
            "artifact_version": 2,
            "source_version": source_version,
            "locator": locator,
            "artifact_part_provenance": provenance,
        }

        db_session.execute(
            text(
                """
                INSERT INTO message_context_items (
                    message_id,
                    user_id,
                    context_kind,
                    object_type,
                    object_id,
                    ordinal,
                    context_snapshot
                )
                VALUES (
                    :message_id,
                    :user_id,
                    'object_ref',
                    'artifact_part',
                    :part_id,
                    0,
                    :snapshot
                )
                """
            ).bindparams(bindparam("snapshot", type_=JSONB)),
            {
                "message_id": message_id,
                "user_id": user_id,
                "part_id": part_id,
                "snapshot": snapshot,
            },
        )
        db_session.flush()

        refs = load_message_context_refs(db_session, message_id)
        ref = refs[0]
        assert isinstance(ref, MessageContextRef)
        assert ref.type == "artifact_part"
        assert ref.id == part_id
        assert ref.artifact_id == artifact_id
        assert ref.artifact_key == "brief-1"
        assert ref.artifact_version == 2
        assert ref.source_version == source_version
        assert ref.locator is not None
        assert ref.locator.model_dump(mode="json") == locator
        assert ref.artifact_part_provenance is not None
        assert ref.artifact_part_provenance.artifact_part_id == part_id
        assert ref.artifact_part_provenance.source_version == source_version

        snapshots = load_message_context_snapshots_for_message_ids(db_session, [message_id])
        readback = snapshots[message_id][0]
        readback_json = readback.model_dump(mode="json")
        assert readback.type == "artifact_part"
        assert readback.id == part_id
        assert readback.title == "claim-1"
        assert readback.preview == "Durable claim text"
        assert readback.locator is not None
        assert readback.locator.model_dump(mode="json") == locator
        assert readback_json["artifact_id"] == str(artifact_id)
        assert readback_json["artifact_key"] == "brief-1"
        assert readback_json["artifact_version"] == 2
        assert readback_json["source_version"] == source_version
        assert readback_json["locator"] == locator
        assert readback_json["artifact_part_provenance"]["artifact_part_id"] == str(part_id)
        assert readback_json["artifact_part_provenance"]["source_version"] == source_version
        assert readback_json["artifact_part_provenance"]["locator"] == locator
        assert readback.artifact_id == artifact_id
        assert readback.artifact_key == "brief-1"
        assert readback.artifact_version == 2
        assert readback.source_version == source_version
        assert readback.artifact_part_provenance is not None
        assert readback.artifact_part_provenance.artifact_part_id == part_id

    def test_insert_artifact_context_stores_json_provenance(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        conversation_id, user_message_id, _user_id, _default_library_id = conversation_with_message
        assistant_message_id = uuid4()
        artifact_id = uuid4()
        db_session.execute(
            text(
                """
                INSERT INTO messages (
                    id, conversation_id, seq, role, content, status, parent_message_id
                )
                VALUES (
                    :message_id, :conversation_id, 2, 'assistant', 'Done',
                    'complete', :parent_message_id
                )
                """
            ),
            {
                "message_id": assistant_message_id,
                "conversation_id": conversation_id,
                "parent_message_id": user_message_id,
            },
        )
        db_session.execute(
            text(
                """
                INSERT INTO message_artifacts (
                    id, conversation_id, message_id, artifact_key,
                    artifact_version, artifact_kind, title, status
                )
                VALUES (
                    :artifact_id, :conversation_id, :message_id, 'brief-1',
                    2, 'briefing_document', 'Brief', 'complete'
                )
                """
            ),
            {
                "artifact_id": artifact_id,
                "conversation_id": conversation_id,
                "message_id": assistant_message_id,
            },
        )
        db_session.flush()

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=user_message_id,
                ordinal=0,
                context=MessageContextRef.model_validate(
                    {
                        "kind": "object_ref",
                        "type": "artifact",
                        "id": str(artifact_id),
                        "artifact_id": str(artifact_id),
                        "artifact_key": "caller-brief",
                        "artifact_version": 9,
                        "artifact_part_provenance": {
                            "type": "artifact",
                            "artifact_id": str(artifact_id),
                            "artifact_kind": "briefing_document",
                            "message_id": str(user_message_id),
                            "conversation_id": str(conversation_id),
                            "artifact_key": "caller-brief",
                            "artifact_version": 9,
                            "artifact_title": "Caller Brief",
                        },
                    }
                ),
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST
        assert "does not match the stored artifact" in exc_info.value.message

        row = contexts_service.insert_context(
            db=db_session,
            message_id=user_message_id,
            ordinal=0,
            context=MessageContextRef.model_validate(
                {
                    "kind": "object_ref",
                    "type": "artifact",
                    "id": str(artifact_id),
                }
            ),
        )

        json.dumps(row.context_snapshot_json)
        snapshot = row.context_snapshot_json
        stored = snapshot["artifact_part_provenance"]
        assert snapshot["type"] == "artifact"
        assert snapshot["id"] == str(artifact_id)
        assert snapshot["artifact_id"] == str(artifact_id)
        assert snapshot["artifact_key"] == "brief-1"
        assert snapshot["artifact_version"] == 2
        assert stored["type"] == "artifact"
        assert stored["artifact_id"] == str(artifact_id)
        assert stored["artifact_key"] == "brief-1"
        assert stored["artifact_version"] == 2
        assert stored["message_id"] == str(assistant_message_id)
        assert stored["conversation_id"] == str(conversation_id)
        assert stored["artifact_title"] == "Brief"

        refs = load_message_context_refs(db_session, user_message_id)
        ref = refs[0]
        assert isinstance(ref, MessageContextRef)
        assert ref.type == "artifact"
        assert ref.id == artifact_id
        assert ref.artifact_id == artifact_id
        assert ref.artifact_key == "brief-1"
        assert ref.artifact_version == 2
        assert ref.artifact_part_provenance is not None
        assert ref.artifact_part_provenance.artifact_key == "brief-1"
        assert ref.artifact_part_provenance.artifact_version == 2
        assert ref.artifact_part_provenance.message_id == assistant_message_id

        snapshots = load_message_context_snapshots_for_message_ids(db_session, [user_message_id])
        readback = snapshots[user_message_id][0]
        readback_json = readback.model_dump(mode="json")
        assert readback.type == "artifact"
        assert readback.id == artifact_id
        assert readback.artifact_id == artifact_id
        assert readback.artifact_key == "brief-1"
        assert readback.artifact_version == 2
        assert readback.artifact_part_provenance is not None
        assert readback.artifact_part_provenance.message_id == assistant_message_id
        assert readback_json["artifact_part_provenance"]["artifact_key"] == "brief-1"
        assert readback_json["artifact_part_provenance"]["artifact_version"] == 2

    def test_insert_artifact_part_context_stores_json_provenance(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        conversation_id, user_message_id, _user_id, _default_library_id = conversation_with_message
        assistant_message_id = uuid4()
        artifact_id = uuid4()
        part_id = uuid4()
        source_version = f"artifact_part:{part_id}:v1"
        locator = {
            "type": "artifact_part_ref",
            "artifact_id": str(artifact_id),
            "artifact_part_id": str(part_id),
            "message_id": str(assistant_message_id),
            "conversation_id": str(conversation_id),
            "part_key": "claim-1",
        }
        db_session.execute(
            text(
                """
                INSERT INTO messages (
                    id, conversation_id, seq, role, content, status, parent_message_id
                )
                VALUES (
                    :message_id, :conversation_id, 2, 'assistant', 'Done',
                    'complete', :parent_message_id
                )
                """
            ),
            {
                "message_id": assistant_message_id,
                "conversation_id": conversation_id,
                "parent_message_id": user_message_id,
            },
        )
        db_session.execute(
            text(
                """
                INSERT INTO message_artifacts (
                    id, conversation_id, message_id, artifact_key,
                    artifact_version, artifact_kind, title, status
                )
                VALUES (
                    :artifact_id, :conversation_id, :message_id, 'brief-1',
                    2, 'briefing_document', 'Brief', 'complete'
                )
                """
            ),
            {
                "artifact_id": artifact_id,
                "conversation_id": conversation_id,
                "message_id": assistant_message_id,
            },
        )
        db_session.execute(
            text(
                """
                INSERT INTO message_artifact_parts (
                    id, artifact_id, ordinal, part_key, part_type, text,
                    source_version, locator, metadata
                )
                VALUES (
                    :part_id, :artifact_id, 0, 'claim-1', 'claim',
                    'Durable claim text', :source_version, :locator,
                    '{"support_state":"not_source_grounded"}'::jsonb
                )
                """
            ).bindparams(bindparam("locator", type_=JSONB)),
            {
                "part_id": part_id,
                "artifact_id": artifact_id,
                "source_version": source_version,
                "locator": locator,
            },
        )
        db_session.flush()

        with pytest.raises(ApiError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=user_message_id,
                ordinal=0,
                context=MessageContextRef.model_validate(
                    {
                        "kind": "object_ref",
                        "type": "artifact_part",
                        "id": str(part_id),
                        "artifact_id": str(artifact_id),
                        "artifact_key": "caller-brief",
                        "artifact_version": 9,
                        "source_version": source_version,
                        "locator": locator,
                        "artifact_part_provenance": {
                            "type": "artifact_part",
                            "artifact_id": str(artifact_id),
                            "artifact_kind": "briefing_document",
                            "message_id": str(user_message_id),
                            "conversation_id": str(conversation_id),
                            "artifact_key": "caller-brief",
                            "artifact_version": 9,
                            "artifact_part_id": str(part_id),
                            "part_key": "caller-claim",
                            "part_type": "caller-type",
                            "text": "Caller supplied text",
                            "source_version": source_version,
                            "locator": locator,
                        },
                    }
                ),
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST
        assert "does not match the stored part" in exc_info.value.message

        row = contexts_service.insert_context(
            db=db_session,
            message_id=user_message_id,
            ordinal=0,
            context=MessageContextRef.model_validate(
                {
                    "kind": "object_ref",
                    "type": "artifact_part",
                    "id": str(part_id),
                    "artifact_id": str(artifact_id),
                    "artifact_key": "brief-1",
                    "artifact_version": 2,
                    "source_version": source_version,
                    "locator": locator,
                    "artifact_part_provenance": {
                        "type": "artifact_part",
                        "artifact_id": str(artifact_id),
                        "artifact_kind": "briefing_document",
                        "message_id": str(assistant_message_id),
                        "conversation_id": str(conversation_id),
                        "artifact_key": "brief-1",
                        "artifact_version": 2,
                        "artifact_part_id": str(part_id),
                        "part_key": "claim-1",
                        "part_type": "claim",
                        "text": "Durable claim text",
                        "source_version": source_version,
                        "locator": locator,
                    },
                }
            ),
        )

        json.dumps(row.context_snapshot_json)
        snapshot = row.context_snapshot_json
        stored = row.context_snapshot_json["artifact_part_provenance"]
        assert snapshot["artifact_key"] == "brief-1"
        assert snapshot["artifact_version"] == 2
        assert stored["artifact_part_id"] == str(part_id)
        assert stored["artifact_id"] == str(artifact_id)
        assert stored["artifact_key"] == "brief-1"
        assert stored["artifact_version"] == 2
        assert stored["message_id"] == str(assistant_message_id)
        assert stored["conversation_id"] == str(conversation_id)
        assert stored["part_key"] == "claim-1"
        assert stored["part_type"] == "claim"
        assert stored["text"] == "Durable claim text"
        assert stored["locator"] == locator

    def test_insert_reader_selection_context_requires_media_visibility(
        self,
        db_session: Session,
        conversation_with_message: tuple,
    ):
        """Reader selections are media-backed and require readable source media."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:id, 'web_article', 'Invisible Article', 'ready_for_reading')
            """),
            {"id": media_id},
        )

        with pytest.raises(NotFoundError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=message_id,
                ordinal=0,
                context=_reader_selection(media_id),
            )

        assert exc_info.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND

    def test_insert_context_creates_conversation_media(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Inserting context creates conversation_media entry."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        # Before: no conversation_media
        result = db_session.execute(
            text("""
                SELECT 1 FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.fetchone() is None

        # Insert context
        contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=_context_ref("highlight", highlight_id),
        )

        # After: conversation_media exists
        result = db_session.execute(
            text("""
                SELECT 1 FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.fetchone() is not None

    def test_insert_context_nonexistent_message(
        self, db_session: Session, media_with_highlight: tuple
    ):
        """Insert context for non-existent message raises error."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        with pytest.raises(NotFoundError) as exc_info:
            contexts_service.insert_context(
                db=db_session,
                message_id=uuid4(),
                ordinal=0,
                context=_context_ref("media", media_id),
            )

        assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND

    def test_insert_multiple_contexts_same_media(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Multiple contexts referencing same media don't duplicate conversation_media."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        # Insert first context (media)
        contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=_context_ref("media", media_id),
        )

        # Insert second context (highlight on same media)
        contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=1,
            context=_context_ref("highlight", highlight_id),
        )

        # Should have only one conversation_media entry
        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.scalar() == 1


# =============================================================================
# Batch Insert Tests
# =============================================================================


class TestBatchInsert:
    """Tests for batch context insertion."""

    def test_insert_contexts_batch(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Batch insert multiple contexts."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        contexts = [
            _context_ref("media", media_id),
            _context_ref("highlight", highlight_id),
            _context_ref("note_block", note_block_id),
        ]

        results = contexts_service.insert_contexts_batch(
            db=db_session,
            message_id=message_id,
            contexts=contexts,
        )

        assert len(results) == 3
        assert results[0].ordinal == 0
        assert results[1].ordinal == 1
        assert results[2].ordinal == 2


# =============================================================================
# Typed Anchor Context Resolution Tests
# =============================================================================


class TestTypedAnchorMediaResolution:
    """resolve_media_id_for_context uses canonical typed anchors."""

    def test_resolve_highlight_via_typed_anchor(
        self, db_session: Session, media_with_highlight: tuple
    ):
        """Highlight resolution uses the typed anchor row and returns media_id."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("highlight", highlight_id),
        )
        assert resolved == media_id

    def test_resolve_note_block_via_typed_anchor(
        self, db_session: Session, media_with_highlight: tuple
    ):
        """Linked note resolution uses the typed highlight anchor row."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("note_block", note_block_id),
        )
        assert resolved == media_id

    def test_resolve_media_direct_reference(self, db_session: Session, media_with_highlight: tuple):
        """Direct media context resolves to media_id."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("media", media_id),
        )
        assert resolved == media_id
