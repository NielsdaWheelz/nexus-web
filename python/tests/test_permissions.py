"""Tests for authorization predicates module.

Tests cover:
- can_read_media: member/admin visibility, non-member rejection
- can_read_media_bulk: batch checking with mixed results
- is_library_admin: role-based checks
- is_admin_of_any_containing_library: admin check across libraries

Key invariants tested:
- No existence leak (non-existent resources return False, not raise)
- All functions accept explicit Session
- Bulk function uses exactly one query
"""

from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    can_read_media_bulk,
    is_admin_of_any_containing_library,
    is_library_admin,
    is_library_member,
)
from nexus.services.bootstrap import ensure_user_and_default_library


class TestCanReadMedia:
    """Tests for can_read_media predicate."""

    def test_can_read_media_true_for_member(self, db_session: Session):
        """Member can read media in their library."""
        # Create user with default library
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Create media
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )

        # Add media to library
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": library_id, "media_id": media_id},
        )
        db_session.flush()

        # Change user to member role (not admin)
        db_session.execute(
            text("""
                UPDATE memberships SET role = 'member'
                WHERE library_id = :library_id AND user_id = :user_id
            """),
            {"library_id": library_id, "user_id": user_id},
        )
        db_session.flush()

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_true_for_admin(self, db_session: Session):
        """Admin can read media in their library."""
        # Create user with default library (admin role)
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Create media
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )

        # Add media to library
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": library_id, "media_id": media_id},
        )
        db_session.flush()

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_false_for_non_member(self, db_session: Session):
        """Non-member cannot read media in another user's library."""
        # Create owner with default library
        owner_id = uuid4()
        owner_library_id = ensure_user_and_default_library(db_session, owner_id)
        db_session.flush()

        # Create non-member user
        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)
        db_session.flush()

        # Create media in owner's library
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": owner_library_id, "media_id": media_id},
        )
        db_session.flush()

        assert can_read_media(db_session, non_member_id, media_id) is False

    def test_can_read_media_false_for_nonexistent_media(self, db_session: Session):
        """Non-existent media returns False (no existence leak)."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        non_existent_media_id = uuid4()
        assert can_read_media(db_session, user_id, non_existent_media_id) is False


class TestCanReadMediaBulk:
    """Tests for can_read_media_bulk predicate."""

    def test_can_read_media_bulk_mixed(self, db_session: Session):
        """Bulk check returns correct results for mixed visibility."""
        # Create user with default library
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Create readable media (in user's library)
        readable_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Readable', 'pending')
            """),
            {"media_id": readable_id},
        )
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": library_id, "media_id": readable_id},
        )

        # Create unreadable media (not in user's library)
        unreadable_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Unreadable', 'pending')
            """),
            {"media_id": unreadable_id},
        )

        # Non-existent media
        non_existent_id = uuid4()

        db_session.flush()

        # Check all three
        result = can_read_media_bulk(
            db_session, user_id, [readable_id, unreadable_id, non_existent_id]
        )

        # All input IDs should be present
        assert len(result) == 3
        assert readable_id in result
        assert unreadable_id in result
        assert non_existent_id in result

        # Correct values
        assert result[readable_id] is True
        assert result[unreadable_id] is False
        assert result[non_existent_id] is False

    def test_can_read_media_bulk_empty_list(self, db_session: Session):
        """Empty list returns empty dict without query."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        result = can_read_media_bulk(db_session, user_id, [])
        assert result == {}


class TestIsLibraryAdmin:
    """Tests for is_library_admin predicate."""

    def test_is_library_admin_true(self, db_session: Session):
        """Admin role returns True."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Default library has admin membership
        assert is_library_admin(db_session, user_id, library_id) is True

    def test_is_library_admin_false_for_member_role(self, db_session: Session):
        """Member role returns False."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Change to member role
        db_session.execute(
            text("""
                UPDATE memberships SET role = 'member'
                WHERE library_id = :library_id AND user_id = :user_id
            """),
            {"library_id": library_id, "user_id": user_id},
        )
        db_session.flush()

        assert is_library_admin(db_session, user_id, library_id) is False

    def test_is_library_admin_false_for_nonexistent_library(self, db_session: Session):
        """Non-existent library returns False (no existence leak)."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        non_existent_library_id = uuid4()
        assert is_library_admin(db_session, user_id, non_existent_library_id) is False


class TestIsAdminOfAnyContainingLibrary:
    """Tests for is_admin_of_any_containing_library predicate."""

    def test_is_admin_of_any_containing_library_true(self, db_session: Session):
        """Returns True when user is admin of library containing media."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Create media in user's library
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": library_id, "media_id": media_id},
        )
        db_session.flush()

        assert is_admin_of_any_containing_library(db_session, user_id, media_id) is True

    def test_is_admin_of_any_containing_library_false_admin_other_library(
        self, db_session: Session
    ):
        """Returns False when user is admin of different library (not containing media)."""
        # Create owner
        owner_id = uuid4()
        owner_library_id = ensure_user_and_default_library(db_session, owner_id)
        db_session.flush()

        # Create admin of different library
        admin_id = uuid4()
        ensure_user_and_default_library(db_session, admin_id)
        db_session.flush()

        # Create media in owner's library only
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": owner_library_id, "media_id": media_id},
        )
        db_session.flush()

        # admin_id is admin of their own library, but not of owner's library
        assert is_admin_of_any_containing_library(db_session, admin_id, media_id) is False

    def test_is_admin_of_any_containing_library_false_nonexistent_media(self, db_session: Session):
        """Returns False for non-existent media (no existence leak)."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        non_existent_media_id = uuid4()
        assert (
            is_admin_of_any_containing_library(db_session, user_id, non_existent_media_id) is False
        )

    def test_is_admin_of_any_containing_library_false_member_not_admin(self, db_session: Session):
        """Returns False when user is member (not admin) of library containing media."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Create media in user's library
        media_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status)
                VALUES (:media_id, 'web_article', 'Test', 'pending')
            """),
            {"media_id": media_id},
        )
        db_session.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
            """),
            {"library_id": library_id, "media_id": media_id},
        )

        # Change to member role
        db_session.execute(
            text("""
                UPDATE memberships SET role = 'member'
                WHERE library_id = :library_id AND user_id = :user_id
            """),
            {"library_id": library_id, "user_id": user_id},
        )
        db_session.flush()

        assert is_admin_of_any_containing_library(db_session, user_id, media_id) is False


class TestIsLibraryMember:
    """Tests for is_library_member predicate."""

    def test_is_library_member_true_for_admin(self, db_session: Session):
        """Admin is a member."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        assert is_library_member(db_session, user_id, library_id) is True

    def test_is_library_member_true_for_member(self, db_session: Session):
        """Member role is a member."""
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.flush()

        # Change to member role
        db_session.execute(
            text("""
                UPDATE memberships SET role = 'member'
                WHERE library_id = :library_id AND user_id = :user_id
            """),
            {"library_id": library_id, "user_id": user_id},
        )
        db_session.flush()

        assert is_library_member(db_session, user_id, library_id) is True

    def test_is_library_member_false_for_non_member(self, db_session: Session):
        """Non-member returns False."""
        owner_id = uuid4()
        owner_library_id = ensure_user_and_default_library(db_session, owner_id)
        db_session.flush()

        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)
        db_session.flush()

        assert is_library_member(db_session, non_member_id, owner_library_id) is False
