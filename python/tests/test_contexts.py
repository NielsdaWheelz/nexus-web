"""Service-layer tests for message context management.

Tests cover the helpers in services/contexts.py:
- Insert message context items with ordinal ordering
- Compute media_id from context targets (media, highlight, note_block)
- Transactionally upsert conversation_media
- recompute_conversation_media helper is idempotent

NO PUBLIC ROUTES use these in PR-02. These are service-layer tests only.
"""

from uuid import UUID, uuid4

import pytest
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import ChatContextInput, MessageContextRef, ReaderSelectionContext
from nexus.services import contexts as contexts_service
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversations import load_message_context_snapshots_for_message_ids

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


def _reader_selection(media_id: UUID) -> ReaderSelectionContext:
    return ReaderSelectionContext(
        kind="reader_selection",
        client_context_id=uuid4(),
        media_id=media_id,
        media_kind="web_article",
        media_title="Test Article",
        exact="selected quote",
        prefix="before ",
        suffix=" after",
        locator={
            "kind": "fragment_offsets",
            "fragment_id": str(uuid4()),
            "start_offset": 10,
            "end_offset": 24,
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
                locator={},
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

    def test_insert_reader_selection_context(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Insert an unsaved reader selection without creating a fake object ref."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight
        selection = _reader_selection(media_id)

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
        assert context.locator_json == selection.locator
        assert context.context_snapshot_json["kind"] == "reader_selection"
        assert context.context_snapshot_json["exact"] == "selected quote"
        assert context.context_snapshot_json["locator"] == selection.locator

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
        assert link["b_locator"] == selection.locator
        assert link["metadata"]["context_kind"] == "reader_selection"
        assert link["metadata"]["context_item_id"] == str(context.id)

        snapshots = load_message_context_snapshots_for_message_ids(db_session, [message_id])
        snapshot = snapshots[message_id][0].model_dump(mode="json")
        assert snapshot["kind"] == "reader_selection"
        assert snapshot["client_context_id"] == str(selection.client_context_id)
        assert snapshot["media_id"] == str(media_id)
        assert snapshot["source_media_id"] == str(media_id)
        assert snapshot["exact"] == "selected quote"
        assert snapshot["locator"] == selection.locator

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
# Conversation Media Recompute Tests
# =============================================================================


class TestConversationMediaRecompute:
    """Tests for recompute_conversation_media helper."""

    def test_recompute_is_idempotent(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """recompute_conversation_media is idempotent."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        # Insert context
        contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=_context_ref("media", media_id),
        )

        # Recompute multiple times
        contexts_service.recompute_conversation_media(db_session, conversation_id)
        contexts_service.recompute_conversation_media(db_session, conversation_id)
        contexts_service.recompute_conversation_media(db_session, conversation_id)

        # Should still have exactly one entry
        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id
            """),
            {"conv_id": conversation_id},
        )
        assert result.scalar() == 1

    def test_recompute_removes_stale_entries(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """recompute removes stale conversation_media entries."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        # Insert context
        context = contexts_service.insert_context(
            db=db_session,
            message_id=message_id,
            ordinal=0,
            context=_context_ref("media", media_id),
        )

        # Manually delete the context (simulating cascade from highlight delete)
        db_session.execute(
            text("DELETE FROM message_context_items WHERE id = :id"),
            {"id": context.id},
        )
        db_session.flush()

        # conversation_media is now stale
        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id
            """),
            {"conv_id": conversation_id},
        )
        assert result.scalar() == 1

        # Recompute should remove it
        contexts_service.recompute_conversation_media(db_session, conversation_id)

        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id
            """),
            {"conv_id": conversation_id},
        )
        assert result.scalar() == 0

    def test_recompute_adds_missing_entries(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """recompute adds missing conversation_media entries."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        # Manually insert context without going through service
        context_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO message_context_items (
                    id, message_id, user_id, ordinal, object_type, object_id, context_snapshot
                )
                VALUES (:id, :message_id, :user_id, 0, 'media', :media_id, '{}'::jsonb)
            """),
            {"id": context_id, "message_id": message_id, "user_id": user_id, "media_id": media_id},
        )
        db_session.flush()

        # No conversation_media yet
        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id
            """),
            {"conv_id": conversation_id},
        )
        assert result.scalar() == 0

        # Recompute should add it
        contexts_service.recompute_conversation_media(db_session, conversation_id)

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
# S6 PR-02: Kernel-Based Context Resolution Tests
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

    def test_resolve_media_direct_unchanged(self, db_session: Session, media_with_highlight: tuple):
        """Direct media resolution path is unaffected by typed-anchor changes."""
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session,
            _context_ref("media", media_id),
        )
        assert resolved == media_id


class TestTypedAnchorRecompute:
    """recompute_conversation_media uses canonical typed anchors."""

    def test_recompute_with_highlight_context_resolves_via_typed_anchor(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Recompute correctly resolves media for highlight context through typed anchors."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        context_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO message_context_items (
                    id, message_id, user_id, ordinal, object_type, object_id, context_snapshot
                )
                VALUES (:id, :message_id, :user_id, 0, 'highlight', :highlight_id, '{}'::jsonb)
            """),
            {
                "id": context_id,
                "message_id": message_id,
                "user_id": user_id,
                "highlight_id": highlight_id,
            },
        )
        db_session.flush()

        contexts_service.recompute_conversation_media(db_session, conversation_id)

        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.scalar() == 1

    def test_recompute_with_note_block_context_resolves_via_typed_anchor(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Recompute resolves media for a highlight-linked note block."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, note_block_id = media_with_highlight

        context_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO message_context_items (
                    id, message_id, user_id, ordinal, object_type, object_id, context_snapshot
                )
                VALUES (:id, :message_id, :user_id, 0, 'note_block', :note_block_id, '{}'::jsonb)
            """),
            {
                "id": context_id,
                "message_id": message_id,
                "user_id": user_id,
                "note_block_id": note_block_id,
            },
        )
        db_session.flush()

        contexts_service.recompute_conversation_media(db_session, conversation_id)

        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.scalar() == 1

    def test_recompute_with_pdf_highlight_context_resolves_via_typed_anchor(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        user_with_library: tuple,
    ):
        """Recompute also handles PDF highlight contexts through typed anchors."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, highlight_id = _create_pdf_media_with_highlight(db_session, user_id)

        context_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO message_context_items (
                    id, message_id, user_id, ordinal, object_type, object_id, context_snapshot
                )
                VALUES (:id, :message_id, :user_id, 0, 'highlight', :highlight_id, '{}'::jsonb)
            """),
            {
                "id": context_id,
                "message_id": message_id,
                "user_id": user_id,
                "highlight_id": highlight_id,
            },
        )
        db_session.flush()

        contexts_service.recompute_conversation_media(db_session, conversation_id)

        result = db_session.execute(
            text("""
                SELECT COUNT(*) FROM conversation_media
                WHERE conversation_id = :conv_id AND media_id = :media_id
            """),
            {"conv_id": conversation_id, "media_id": media_id},
        )
        assert result.scalar() == 1
