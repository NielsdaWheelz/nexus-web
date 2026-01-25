"""Service-layer tests for message context management.

Tests cover the helpers in services/contexts.py:
- Validate target_type ↔ FK consistency
- Insert message_context rows with ordinal ordering
- Compute media_id from context targets (media, highlight, annotation)
- Transactionally upsert conversation_media
- recompute_conversation_media helper is idempotent

NO PUBLIC ROUTES use these in PR-02. These are service-layer tests only.
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services import contexts as contexts_service
from nexus.services.bootstrap import ensure_user_and_default_library

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
        Tuple of (media_id, fragment_id, highlight_id, annotation_id)
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
            INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                   color, exact, prefix, suffix)
            VALUES (:id, :user_id, :fragment_id, 0, 4, 'yellow', 'Test', '', ' canonical')
        """),
        {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id},
    )

    # Create annotation
    annotation_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO annotations (id, highlight_id, body)
            VALUES (:id, :highlight_id, 'Test annotation')
        """),
        {"id": annotation_id, "highlight_id": highlight_id},
    )

    db_session.flush()

    return media_id, fragment_id, highlight_id, annotation_id


# =============================================================================
# Target Type Validation Tests
# =============================================================================


class TestTargetTypeValidation:
    """Tests for target_type validation."""

    def test_validate_media_requires_media_id(self):
        """target_type='media' requires media_id."""
        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_target_type(
                "media",
                {"media_id": None, "highlight_id": None, "annotation_id": None},
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_highlight_requires_highlight_id(self):
        """target_type='highlight' requires highlight_id."""
        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_target_type(
                "highlight",
                {"media_id": uuid4(), "highlight_id": None, "annotation_id": None},
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_annotation_requires_annotation_id(self):
        """target_type='annotation' requires annotation_id."""
        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_target_type(
                "annotation",
                {"media_id": None, "highlight_id": None, "annotation_id": None},
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_exactly_one_fk(self):
        """Exactly one FK must be set."""
        # Multiple FKs set
        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_target_type(
                "media",
                {"media_id": uuid4(), "highlight_id": uuid4(), "annotation_id": None},
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_invalid_target_type(self):
        """Invalid target_type raises error."""
        with pytest.raises(ApiError) as exc_info:
            contexts_service.validate_target_type(
                "invalid",
                {"media_id": uuid4(), "highlight_id": None, "annotation_id": None},
            )
        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_validate_media_succeeds(self):
        """Valid media target passes validation."""
        # Should not raise
        contexts_service.validate_target_type(
            "media",
            {"media_id": uuid4(), "highlight_id": None, "annotation_id": None},
        )

    def test_validate_highlight_succeeds(self):
        """Valid highlight target passes validation."""
        contexts_service.validate_target_type(
            "highlight",
            {"media_id": None, "highlight_id": uuid4(), "annotation_id": None},
        )

    def test_validate_annotation_succeeds(self):
        """Valid annotation target passes validation."""
        contexts_service.validate_target_type(
            "annotation",
            {"media_id": None, "highlight_id": None, "annotation_id": uuid4()},
        )


# =============================================================================
# Media ID Resolution Tests
# =============================================================================


class TestMediaIdResolution:
    """Tests for resolving media_id from context targets."""

    def test_resolve_media_direct(self, db_session: Session, media_with_highlight: tuple):
        """Direct media reference returns media_id."""
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session, "media", media_id, None, None
        )

        assert resolved == media_id

    def test_resolve_highlight_via_fragment(self, db_session: Session, media_with_highlight: tuple):
        """Highlight reference resolves via fragment to media_id."""
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session, "highlight", None, highlight_id, None
        )

        assert resolved == media_id

    def test_resolve_annotation_via_highlight_fragment(
        self, db_session: Session, media_with_highlight: tuple
    ):
        """Annotation reference resolves via highlight.fragment to media_id."""
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        resolved = contexts_service.resolve_media_id_for_context(
            db_session, "annotation", None, None, annotation_id
        )

        assert resolved == media_id

    def test_resolve_nonexistent_media(self, db_session: Session):
        """Non-existent media raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(db_session, "media", uuid4(), None, None)

    def test_resolve_nonexistent_highlight(self, db_session: Session):
        """Non-existent highlight raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(
                db_session, "highlight", None, uuid4(), None
            )

    def test_resolve_nonexistent_annotation(self, db_session: Session):
        """Non-existent annotation raises NotFoundError."""
        with pytest.raises(NotFoundError):
            contexts_service.resolve_media_id_for_context(
                db_session, "annotation", None, None, uuid4()
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        context = contexts_service.insert_context(
            db_session,
            message_id=message_id,
            ordinal=0,
            target_type="media",
            media_id=media_id,
        )

        assert context.message_id == message_id
        assert context.ordinal == 0
        assert context.target_type == "media"
        assert context.media_id == media_id

    def test_insert_context_creates_conversation_media(
        self,
        db_session: Session,
        conversation_with_message: tuple,
        media_with_highlight: tuple,
    ):
        """Inserting context creates conversation_media entry."""
        conversation_id, message_id, user_id, default_library_id = conversation_with_message
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

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
            db_session,
            message_id=message_id,
            ordinal=0,
            target_type="highlight",
            highlight_id=highlight_id,
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        with pytest.raises(NotFoundError) as exc_info:
            contexts_service.insert_context(
                db_session,
                message_id=uuid4(),
                ordinal=0,
                target_type="media",
                media_id=media_id,
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        # Insert first context (media)
        contexts_service.insert_context(
            db_session,
            message_id=message_id,
            ordinal=0,
            target_type="media",
            media_id=media_id,
        )

        # Insert second context (highlight on same media)
        contexts_service.insert_context(
            db_session,
            message_id=message_id,
            ordinal=1,
            target_type="highlight",
            highlight_id=highlight_id,
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        # Insert context
        contexts_service.insert_context(
            db_session,
            message_id=message_id,
            ordinal=0,
            target_type="media",
            media_id=media_id,
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        # Insert context
        context = contexts_service.insert_context(
            db_session,
            message_id=message_id,
            ordinal=0,
            target_type="media",
            media_id=media_id,
        )

        # Manually delete the context (simulating cascade from highlight delete)
        db_session.execute(
            text("DELETE FROM message_contexts WHERE id = :id"),
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        # Manually insert context without going through service
        context_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO message_contexts (id, message_id, ordinal, target_type, media_id)
                VALUES (:id, :message_id, 0, 'media', :media_id)
            """),
            {"id": context_id, "message_id": message_id, "media_id": media_id},
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
        media_id, fragment_id, highlight_id, annotation_id = media_with_highlight

        contexts = [
            {
                "ordinal": 0,
                "target_type": "media",
                "media_id": media_id,
            },
            {
                "ordinal": 1,
                "target_type": "highlight",
                "highlight_id": highlight_id,
            },
            {
                "ordinal": 2,
                "target_type": "annotation",
                "annotation_id": annotation_id,
            },
        ]

        results = contexts_service.insert_contexts_batch(db_session, message_id, contexts)

        assert len(results) == 3
        assert results[0].ordinal == 0
        assert results[1].ordinal == 1
        assert results[2].ordinal == 2
