"""Service-layer tests for conversation sharing invariants.

Tests cover the invariants enforced in services/shares.py:
- sharing='private' forbids any conversation_share rows
- sharing='library' requires ≥1 conversation_share row
- Owner must be a member of the library to add a share
- Deleting the last share auto-transitions sharing to 'private'

NO PUBLIC ROUTES expose these in PR-02. These are service-layer tests only.
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services import shares as shares_service
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
def conversation(db_session: Session, user_with_library: tuple):
    """Create a test conversation.

    Returns:
        Tuple of (conversation_id, user_id, default_library_id)
    """
    user_id, default_library_id = user_with_library

    conversation_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, 'private', 1)
        """),
        {"id": conversation_id, "owner_user_id": user_id},
    )
    db_session.flush()

    return conversation_id, user_id, default_library_id


@pytest.fixture
def extra_library(db_session: Session, user_with_library: tuple):
    """Create an additional non-default library for the user.

    Returns:
        library_id
    """
    user_id, _ = user_with_library

    library_id = uuid4()
    db_session.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :owner_user_id, 'Test Library', false)
        """),
        {"id": library_id, "owner_user_id": user_id},
    )
    db_session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": library_id, "user_id": user_id},
    )
    db_session.flush()

    return library_id


# =============================================================================
# Share Invariant Tests
# =============================================================================


class TestSharingInvariants:
    """Tests for conversation sharing invariants."""

    def test_add_share_to_private_conversation_fails(
        self, db_session: Session, conversation: tuple
    ):
        """Cannot add share to a private conversation."""
        conversation_id, user_id, default_library_id = conversation

        with pytest.raises(ApiError) as exc_info:
            shares_service.add_share(db_session, conversation_id, default_library_id)

        assert exc_info.value.code == ApiErrorCode.E_SHARES_NOT_ALLOWED

    def test_set_sharing_library_requires_libraries(self, db_session: Session, conversation: tuple):
        """Cannot set sharing='library' without library_ids."""
        conversation_id, user_id, default_library_id = conversation

        with pytest.raises(ApiError) as exc_info:
            shares_service.set_sharing_mode(db_session, conversation_id, "library", library_ids=[])

        assert exc_info.value.code == ApiErrorCode.E_SHARE_REQUIRED

    def test_set_sharing_library_with_libraries_succeeds(
        self, db_session: Session, conversation: tuple
    ):
        """Can set sharing='library' with valid library_ids."""
        conversation_id, user_id, default_library_id = conversation

        result = shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[default_library_id]
        )

        assert result.sharing == "library"

        # Verify share exists
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 1
        assert shares[0].library_id == default_library_id

    def test_owner_must_be_member_of_library(self, db_session: Session, conversation: tuple):
        """Owner must be a member of the library to share with it."""
        conversation_id, user_id, default_library_id = conversation

        # Create a library owned by another user
        other_user_id = uuid4()
        ensure_user_and_default_library(db_session, other_user_id)

        other_library_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO libraries (id, owner_user_id, name, is_default)
                VALUES (:id, :owner_user_id, 'Other Library', false)
            """),
            {"id": other_library_id, "owner_user_id": other_user_id},
        )
        db_session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": other_library_id, "user_id": other_user_id},
        )
        db_session.flush()

        # Try to share with library user is not a member of
        with pytest.raises(ApiError) as exc_info:
            shares_service.set_sharing_mode(
                db_session, conversation_id, "library", library_ids=[other_library_id]
            )

        assert exc_info.value.code == ApiErrorCode.E_FORBIDDEN

    def test_delete_last_share_transitions_to_private(
        self, db_session: Session, conversation: tuple
    ):
        """Deleting the last share auto-transitions sharing to 'private'."""
        conversation_id, user_id, default_library_id = conversation

        # First, set to library sharing
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[default_library_id]
        )

        # Verify sharing is 'library'
        result = db_session.execute(
            text("SELECT sharing FROM conversations WHERE id = :id"),
            {"id": conversation_id},
        )
        assert result.scalar() == "library"

        # Delete the share
        updated = shares_service.delete_share(db_session, conversation_id, default_library_id)

        # Verify auto-transition to private
        assert updated.sharing == "private"

        # Verify no shares remain
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 0

    def test_set_shares_replaces_existing(
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """set_shares replaces all existing shares."""
        conversation_id, user_id, default_library_id = conversation
        extra_library_id = extra_library

        # Set initial share
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[default_library_id]
        )

        # Replace with different library
        shares_service.set_shares(db_session, conversation_id, [extra_library_id])

        # Verify only new library is shared
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 1
        assert shares[0].library_id == extra_library_id

    def test_set_shares_empty_list_transitions_to_private(
        self, db_session: Session, conversation: tuple
    ):
        """set_shares with empty list transitions sharing='library' to 'private'."""
        conversation_id, user_id, default_library_id = conversation

        # Set initial share
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[default_library_id]
        )

        # Clear all shares
        updated = shares_service.set_shares(db_session, conversation_id, [])

        # Verify transition to private
        assert updated.sharing == "private"

    def test_set_sharing_private_removes_all_shares(
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """set_sharing_mode to 'private' removes all shares."""
        conversation_id, user_id, default_library_id = conversation
        extra_library_id = extra_library

        # Set multiple shares
        shares_service.set_sharing_mode(
            db_session,
            conversation_id,
            "library",
            library_ids=[default_library_id, extra_library_id],
        )

        # Verify shares exist
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 2

        # Set to private
        updated = shares_service.set_sharing_mode(db_session, conversation_id, "private")

        # Verify all shares removed
        assert updated.sharing == "private"
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 0

    def test_conversation_not_found(self, db_session: Session):
        """Operations on non-existent conversation raise NotFoundError."""
        fake_id = uuid4()
        fake_library_id = uuid4()

        with pytest.raises(NotFoundError) as exc_info:
            shares_service.set_sharing_mode(db_session, fake_id, "private")

        assert exc_info.value.code == ApiErrorCode.E_CONVERSATION_NOT_FOUND

        with pytest.raises(NotFoundError):
            shares_service.delete_share(db_session, fake_id, fake_library_id)

        with pytest.raises(NotFoundError):
            shares_service.get_shares(db_session, fake_id)
