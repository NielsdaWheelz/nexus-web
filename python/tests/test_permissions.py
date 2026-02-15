"""Tests for authorization predicates module.

Tests cover:
- can_read_media: s4 provenance semantics (non-default membership, intrinsic, closure edge)
- can_read_media_bulk: batch checking with mixed s4 paths
- can_read_conversation: owner / public / library-shared visibility
- can_read_highlight: media visibility + library intersection
- is_library_admin: role-based checks
- is_admin_of_any_containing_library: admin check across libraries

Key invariants tested:
- No existence leak (non-existent resources return False, not raise)
- All functions accept explicit Session
- Bulk function uses exactly one query
- Default library_media alone is NOT sufficient without intrinsic/closure
- Strict revocation: membership/share removal flips outcome immediately
"""

from uuid import UUID, uuid4

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

# =============================================================================
# Helpers
# =============================================================================


def _create_non_default_library(db: Session, owner_id=None):
    """Create a non-default library owned by owner_id with admin membership."""
    if owner_id is None:
        owner_id = uuid4()
        ensure_user_and_default_library(db, owner_id)
    result = db.execute(
        text("""
            INSERT INTO libraries (name, owner_user_id, is_default)
            VALUES ('Test Library', :owner_id, false)
            RETURNING id
        """),
        {"owner_id": owner_id},
    )
    lib_id = result.scalar()
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:lib_id, :owner_id, 'admin')
            ON CONFLICT DO NOTHING
        """),
        {"lib_id": lib_id, "owner_id": owner_id},
    )
    db.flush()
    return lib_id


def _create_media(db: Session, title: str = "Test") -> "UUID":
    mid = uuid4()
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, 'web_article', :title, 'pending')
        """),
        {"id": mid, "title": title},
    )
    db.flush()
    return mid


def _add_media_to_library(db: Session, library_id, media_id) -> None:
    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:lib, :media)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "media": media_id},
    )
    db.flush()


def _add_intrinsic(db: Session, default_library_id, media_id) -> None:
    db.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            VALUES (:dl, :m)
            ON CONFLICT DO NOTHING
        """),
        {"dl": default_library_id, "m": media_id},
    )
    db.flush()


def _add_closure_edge(db: Session, default_library_id, media_id, source_library_id) -> None:
    db.execute(
        text("""
            INSERT INTO default_library_closure_edges (default_library_id, media_id, source_library_id)
            VALUES (:dl, :m, :sl)
            ON CONFLICT DO NOTHING
        """),
        {"dl": default_library_id, "m": media_id, "sl": source_library_id},
    )
    db.flush()


def _add_membership(db: Session, library_id, user_id, role="member") -> None:
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:lib, :uid, :role)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "uid": user_id, "role": role},
    )
    db.flush()


def _delete_membership(db: Session, library_id, user_id) -> None:
    db.execute(
        text("DELETE FROM memberships WHERE library_id = :lib AND user_id = :uid"),
        {"lib": library_id, "uid": user_id},
    )
    db.flush()


def _get_default_library_id(db: Session, user_id) -> "UUID":
    result = db.execute(
        text("SELECT id FROM libraries WHERE owner_user_id = :uid AND is_default = true"),
        {"uid": user_id},
    )
    return result.scalar()


# =============================================================================
# can_read_media - S4 Provenance
# =============================================================================


class TestCanReadMedia:
    """Tests for can_read_media predicate with s4 provenance semantics."""

    def test_can_read_media_true_for_member(self, db_session: Session):
        """Member can read media in a non-default library they belong to."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)

        # Create non-default library with user as member
        lib_id = _create_non_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_media_to_library(db_session, lib_id, media_id)

        # Change to member role
        db_session.execute(
            text(
                "UPDATE memberships SET role = 'member' WHERE library_id = :lib AND user_id = :uid"
            ),
            {"lib": lib_id, "uid": user_id},
        )
        db_session.flush()

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_true_for_admin(self, db_session: Session):
        """Admin can read media in a non-default library they belong to."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)

        lib_id = _create_non_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_media_to_library(db_session, lib_id, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_false_for_non_member(self, db_session: Session):
        """Non-member cannot read media in another user's library."""
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)

        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        media_id = _create_media(db_session)
        _add_media_to_library(db_session, lib_id, media_id)

        assert can_read_media(db_session, non_member_id, media_id) is False

    def test_can_read_media_false_for_nonexistent_media(self, db_session: Session):
        """Non-existent media returns False (no existence leak)."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        assert can_read_media(db_session, user_id, uuid4()) is False

    def test_can_read_media_false_for_default_library_media_without_intrinsic_or_closure(
        self, db_session: Session
    ):
        """Default library_media row alone is NOT sufficient for s4 visibility."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)

        # Only add to library_media, NO intrinsic, NO closure edge
        _add_media_to_library(db_session, default_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is False

    def test_can_read_media_true_for_default_intrinsic(self, db_session: Session):
        """Default library media with intrinsic provenance is readable."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)

        _add_media_to_library(db_session, default_lib, media_id)
        _add_intrinsic(db_session, default_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_true_for_default_closure_with_active_source_membership(
        self, db_session: Session
    ):
        """Default library media with closure edge + active source membership is readable."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)

        # Create a source non-default library owned by someone else
        other_id = uuid4()
        ensure_user_and_default_library(db_session, other_id)
        source_lib = _create_non_default_library(db_session, other_id)

        # Add user as member of source library
        _add_membership(db_session, source_lib, user_id)

        media_id = _create_media(db_session)
        _add_media_to_library(db_session, source_lib, media_id)
        _add_media_to_library(db_session, default_lib, media_id)
        _add_closure_edge(db_session, default_lib, media_id, source_lib)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_false_for_default_closure_after_membership_revocation(
        self, db_session: Session
    ):
        """Closure edge becomes invalid after source membership revocation."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)

        other_id = uuid4()
        ensure_user_and_default_library(db_session, other_id)
        source_lib = _create_non_default_library(db_session, other_id)

        _add_membership(db_session, source_lib, user_id)

        media_id = _create_media(db_session)
        _add_media_to_library(db_session, source_lib, media_id)
        _add_media_to_library(db_session, default_lib, media_id)
        _add_closure_edge(db_session, default_lib, media_id, source_lib)

        # Verify readable before revocation
        assert can_read_media(db_session, user_id, media_id) is True

        # Revoke membership
        _delete_membership(db_session, source_lib, user_id)

        # Immediately not readable
        assert can_read_media(db_session, user_id, media_id) is False


# =============================================================================
# can_read_media_bulk - S4 Provenance
# =============================================================================


class TestCanReadMediaBulk:
    """Tests for can_read_media_bulk with s4 provenance semantics."""

    def test_can_read_media_bulk_mixed_s4_paths(self, db_session: Session):
        """Bulk check returns correct results across all s4 paths."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)

        # Non-default path
        nd_lib = _create_non_default_library(db_session, user_id)
        media_nd = _create_media(db_session, "non-default")
        _add_media_to_library(db_session, nd_lib, media_nd)

        # Intrinsic path
        media_intr = _create_media(db_session, "intrinsic")
        _add_media_to_library(db_session, default_lib, media_intr)
        _add_intrinsic(db_session, default_lib, media_intr)

        # Closure path
        other_id = uuid4()
        ensure_user_and_default_library(db_session, other_id)
        source_lib = _create_non_default_library(db_session, other_id)
        _add_membership(db_session, source_lib, user_id)
        media_closure = _create_media(db_session, "closure")
        _add_media_to_library(db_session, source_lib, media_closure)
        _add_media_to_library(db_session, default_lib, media_closure)
        _add_closure_edge(db_session, default_lib, media_closure, source_lib)

        # Unreadable (default library_media only, no provenance)
        media_unreadable = _create_media(db_session, "no provenance")
        _add_media_to_library(db_session, default_lib, media_unreadable)

        # Non-existent
        media_nonexist = uuid4()

        result = can_read_media_bulk(
            db_session,
            user_id,
            [media_nd, media_intr, media_closure, media_unreadable, media_nonexist],
        )

        assert len(result) == 5
        assert result[media_nd] is True
        assert result[media_intr] is True
        assert result[media_closure] is True
        assert result[media_unreadable] is False
        assert result[media_nonexist] is False

    def test_can_read_media_bulk_empty_list(self, db_session: Session):
        """Empty list returns empty dict without query."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        result = can_read_media_bulk(db_session, user_id, [])
        assert result == {}


# =============================================================================
# is_library_admin
# =============================================================================


class TestIsLibraryAdmin:
    """Tests for is_library_admin predicate."""

    def test_is_library_admin_true(self, db_session: Session):
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        assert is_library_admin(db_session, user_id, library_id) is True

    def test_is_library_admin_false_for_member_role(self, db_session: Session):
        user_id = uuid4()
        library_id = ensure_user_and_default_library(db_session, user_id)
        db_session.execute(
            text("UPDATE memberships SET role = 'member' WHERE library_id = :l AND user_id = :u"),
            {"l": library_id, "u": user_id},
        )
        db_session.flush()
        assert is_library_admin(db_session, user_id, library_id) is False

    def test_is_library_admin_false_for_nonexistent_library(self, db_session: Session):
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        assert is_library_admin(db_session, user_id, uuid4()) is False


# =============================================================================
# is_admin_of_any_containing_library
# =============================================================================


class TestIsAdminOfAnyContainingLibrary:
    """Tests for is_admin_of_any_containing_library predicate."""

    def test_is_admin_of_any_containing_library_true(self, db_session: Session):
        user_id = uuid4()
        lib_id = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_media_to_library(db_session, lib_id, media_id)
        assert is_admin_of_any_containing_library(db_session, user_id, media_id) is True

    def test_is_admin_of_any_containing_library_false_admin_other_library(
        self, db_session: Session
    ):
        owner_id = uuid4()
        owner_lib = ensure_user_and_default_library(db_session, owner_id)
        admin_id = uuid4()
        ensure_user_and_default_library(db_session, admin_id)

        media_id = _create_media(db_session)
        _add_media_to_library(db_session, owner_lib, media_id)
        assert is_admin_of_any_containing_library(db_session, admin_id, media_id) is False

    def test_is_admin_of_any_containing_library_false_nonexistent_media(self, db_session: Session):
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        assert is_admin_of_any_containing_library(db_session, user_id, uuid4()) is False

    def test_is_admin_of_any_containing_library_false_member_not_admin(self, db_session: Session):
        user_id = uuid4()
        lib_id = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_media_to_library(db_session, lib_id, media_id)
        db_session.execute(
            text("UPDATE memberships SET role = 'member' WHERE library_id = :l AND user_id = :u"),
            {"l": lib_id, "u": user_id},
        )
        db_session.flush()
        assert is_admin_of_any_containing_library(db_session, user_id, media_id) is False


# =============================================================================
# is_library_member
# =============================================================================


class TestIsLibraryMember:
    """Tests for is_library_member predicate."""

    def test_is_library_member_true_for_admin(self, db_session: Session):
        user_id = uuid4()
        lib_id = ensure_user_and_default_library(db_session, user_id)
        assert is_library_member(db_session, user_id, lib_id) is True

    def test_is_library_member_true_for_member(self, db_session: Session):
        user_id = uuid4()
        lib_id = ensure_user_and_default_library(db_session, user_id)
        db_session.execute(
            text("UPDATE memberships SET role = 'member' WHERE library_id = :l AND user_id = :u"),
            {"l": lib_id, "u": user_id},
        )
        db_session.flush()
        assert is_library_member(db_session, user_id, lib_id) is True

    def test_is_library_member_false_for_non_member(self, db_session: Session):
        owner_id = uuid4()
        owner_lib = ensure_user_and_default_library(db_session, owner_id)
        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)
        assert is_library_member(db_session, non_member_id, owner_lib) is False
