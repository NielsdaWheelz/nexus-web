"""Tests for authorization predicates module.

Tests cover:
- can_read_media / visible_media_ids_cte_sql: the single membership-join
  readability relation (see nexus/auth/permissions.py module docstring)
- can_read_conversation: owner / public / library-shared visibility
- can_read_highlight: media visibility + library intersection
- is_library_member: role-based checks

Key invariants tested:
- No existence leak (non-existent resources return False, not raise)
- All functions accept explicit Session
- can_read_media and visible_media_ids_cte_sql are twins of the same relation
  and must never drift: a media item is readable iff a *current* membership
  reaches a physical library_entries row for it (default, non-default, or
  system library — no is_default distinction), minus a viewer tombstone
  (user_media_deletions) and minus an armed teardown intent
  (media_teardown_intents).
- default_library_intrinsics / default_library_closure_edges rows no longer
  grant access by themselves: only a membership-reachable physical
  library_entries row does. The ORM models for those tables still exist in
  this slice; tests below create such rows explicitly to prove they are now
  inert for visibility purposes.
- Strict revocation: membership/share removal flips outcome immediately
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    is_library_member,
    visible_media_ids_cte_sql,
)
from nexus.db.models import DefaultLibraryClosureEdge, DefaultLibraryIntrinsic
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_governance import ensure_system_library

pytestmark = pytest.mark.integration

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
    _add_membership(db, lib_id, owner_id, "admin")
    db.flush()
    return lib_id


def _create_media(db: Session, title: str = "Test", kind: str = "web_article") -> "UUID":
    mid = uuid4()
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, :kind, :title, 'pending')
        """),
        {"id": mid, "kind": kind, "title": title},
    )
    db.flush()
    return mid


def _add_physical_entry(db: Session, library_id, media_id) -> None:
    """Insert a physical library_entries row for media_id in library_id. Idempotent."""
    existing = db.execute(
        text(
            "SELECT 1 FROM library_entries WHERE library_id = :library_id AND media_id = :media_id"
        ),
        {"library_id": library_id, "media_id": media_id},
    ).first()
    if existing is not None:
        return
    next_position = int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM library_entries "
                "WHERE library_id = :library_id"
            ),
            {"library_id": library_id},
        ).scalar_one()
    )
    db.execute(
        text(
            "INSERT INTO library_entries (library_id, position, media_id) "
            "VALUES (:library_id, :position, :media_id)"
        ),
        {"library_id": library_id, "position": next_position, "media_id": media_id},
    )
    db.flush()


def _create_intrinsic_row(db: Session, default_library_id, media_id) -> None:
    """Create a default_library_intrinsics row directly (no physical entry).

    Used only to prove this table no longer grants read access by itself.
    """
    db.merge(DefaultLibraryIntrinsic(default_library_id=default_library_id, media_id=media_id))
    db.flush()


def _create_closure_edge_row(db: Session, default_library_id, media_id, source_library_id) -> None:
    """Create a default_library_closure_edges row directly (no physical entry).

    Used only to prove this table no longer grants read access by itself.
    """
    db.merge(
        DefaultLibraryClosureEdge(
            default_library_id=default_library_id,
            media_id=media_id,
            source_library_id=source_library_id,
        )
    )
    db.flush()


def _add_tombstone(db: Session, user_id, media_id) -> None:
    db.execute(
        text("""
            INSERT INTO user_media_deletions (user_id, media_id)
            VALUES (:uid, :mid)
        """),
        {"uid": user_id, "mid": media_id},
    )
    db.flush()


def _arm_teardown_intent(db: Session, media_id) -> None:
    db.execute(
        text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
        {"id": uuid4(), "media_id": media_id},
    )
    db.flush()


def _add_membership(db: Session, library_id, user_id, role="member") -> None:
    existing = db.execute(
        text("""
            SELECT 1
            FROM memberships
            WHERE library_id = :lib
              AND user_id = :uid
        """),
        {"lib": library_id, "uid": user_id},
    ).first()
    if existing is not None:
        return

    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:lib, :uid, :role)
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


def _visible_media_ids(db: Session, viewer_id) -> set["UUID"]:
    rows = db.execute(text(visible_media_ids_cte_sql()), {"viewer_id": viewer_id}).scalars().all()
    return set(rows)


# =============================================================================
# can_read_media - single membership-join relation
# =============================================================================


class TestCanReadMedia:
    """Tests for can_read_media predicate."""

    def test_can_read_media_true_for_member(self, db_session: Session):
        """Member can read media in a non-default library they belong to."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)

        # Create non-default library with user as member
        lib_id = _create_non_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, lib_id, media_id)

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
        _add_physical_entry(db_session, lib_id, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_false_for_non_member(self, db_session: Session):
        """Non-member cannot read media in another user's library."""
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)

        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, lib_id, media_id)

        assert can_read_media(db_session, non_member_id, media_id) is False

    def test_can_read_media_false_for_nonexistent_media(self, db_session: Session):
        """Non-existent media returns False (no existence leak)."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        assert can_read_media(db_session, user_id, uuid4()) is False

    def test_can_read_media_true_for_default_library_physical_entry(self, db_session: Session):
        """A plain default-library library_entries row is now sufficient by itself.

        No intrinsic/closure row involved: the viewer's own admin membership in
        their default library plus the physical entry is the whole relation.
        """
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)

        _add_physical_entry(db_session, default_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_true_for_system_library_membership(self, db_session: Session):
        """Membership in a system library (e.g. Oracle Corpus) grants access too."""
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)

        system_lib = ensure_system_library(
            db_session,
            system_key=f"test_system_{uuid4().hex}",
            name="Test System Library",
            owner_user_id=user_id,
        )
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, system_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

    def test_can_read_media_false_for_intrinsic_row_without_reachable_entry(
        self, db_session: Session
    ):
        """A default_library_intrinsics row alone, with no reachable physical
        entry, grants nothing (the intrinsic branch is dead)."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)

        # Intrinsic row only -- deliberately no library_entries row anywhere.
        _create_intrinsic_row(db_session, default_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is False

    def test_can_read_media_false_for_closure_edge_row_without_reachable_entry(
        self, db_session: Session
    ):
        """A default_library_closure_edges row alone, with no reachable physical
        entry, grants nothing (the closure branch is dead)."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)

        other_id = uuid4()
        ensure_user_and_default_library(db_session, other_id)
        source_lib = _create_non_default_library(db_session, other_id)
        _add_membership(db_session, source_lib, user_id)

        media_id = _create_media(db_session)
        # Closure edge only -- deliberately no library_entries row in either
        # the default library or the source library.
        _create_closure_edge_row(db_session, default_lib, media_id, source_lib)

        assert can_read_media(db_session, user_id, media_id) is False

    def test_can_read_media_false_for_tombstoned_media_across_visibility_paths(
        self, db_session: Session
    ):
        """Tombstone exclusion applies uniformly regardless of which library
        (non-default, default, or system) the physical entry lives in."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)

        non_default_lib = _create_non_default_library(db_session, user_id)
        non_default_media = _create_media(db_session, "non-default")
        _add_physical_entry(db_session, non_default_lib, non_default_media)

        default_media = _create_media(db_session, "default")
        _add_physical_entry(db_session, default_lib, default_media)

        system_lib = ensure_system_library(
            db_session,
            system_key=f"test_system_{uuid4().hex}",
            name="Test System Library",
            owner_user_id=user_id,
        )
        system_media = _create_media(db_session, "system")
        _add_physical_entry(db_session, system_lib, system_media)

        for media_id in (non_default_media, default_media, system_media):
            assert can_read_media(db_session, user_id, media_id) is True
            _add_tombstone(db_session, user_id, media_id)
            assert can_read_media(db_session, user_id, media_id) is False

    def test_can_read_media_false_for_armed_teardown_intent(self, db_session: Session):
        """An armed media_teardown_intents row excludes the media from reads."""
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, default_lib, media_id)

        assert can_read_media(db_session, user_id, media_id) is True

        _arm_teardown_intent(db_session, media_id)

        assert can_read_media(db_session, user_id, media_id) is False


# =============================================================================
# visible_media_ids_cte_sql - the set twin of can_read_media
# =============================================================================


class TestVisibleMediaIdsCteSql:
    """Tests for visible_media_ids_cte_sql: must agree with can_read_media."""

    def test_includes_membership_reachable_media(self, db_session: Session):
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, default_lib, media_id)

        assert media_id in _visible_media_ids(db_session, user_id)

    def test_includes_system_library_media(self, db_session: Session):
        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        system_lib = ensure_system_library(
            db_session,
            system_key=f"test_system_{uuid4().hex}",
            name="Test System Library",
            owner_user_id=user_id,
        )
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, system_lib, media_id)

        assert media_id in _visible_media_ids(db_session, user_id)

    def test_excludes_non_member_library_media(self, db_session: Session):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        non_member_id = uuid4()
        ensure_user_and_default_library(db_session, non_member_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, lib_id, media_id)

        assert media_id not in _visible_media_ids(db_session, non_member_id)

    def test_excludes_intrinsic_row_without_reachable_entry(self, db_session: Session):
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _create_intrinsic_row(db_session, default_lib, media_id)

        assert media_id not in _visible_media_ids(db_session, user_id)

    def test_excludes_tombstoned_media(self, db_session: Session):
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, default_lib, media_id)
        assert media_id in _visible_media_ids(db_session, user_id)

        _add_tombstone(db_session, user_id, media_id)

        assert media_id not in _visible_media_ids(db_session, user_id)

    def test_excludes_armed_teardown_media(self, db_session: Session):
        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session)
        _add_physical_entry(db_session, default_lib, media_id)
        assert media_id in _visible_media_ids(db_session, user_id)

        _arm_teardown_intent(db_session, media_id)

        assert media_id not in _visible_media_ids(db_session, user_id)


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


# =============================================================================
# can_read_highlight - anchor-kind-aware visibility
# =============================================================================


class TestCanReadHighlightAnchorAware:
    """Typed-anchor highlight visibility."""

    def test_can_read_highlight_normalized_fragment_true(self, db_session: Session):
        """Normalized fragment highlight is readable by author with library access."""
        from nexus.auth.permissions import can_read_highlight
        from tests.factories import (
            create_normalized_fragment_highlight,
            create_test_fragment,
            create_test_media_in_library,
            get_user_default_library,
        )

        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        lib_id = get_user_default_library(db_session, user_id)
        media_id = create_test_media_in_library(db_session, user_id, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="x" * 30)
        hl_id = create_normalized_fragment_highlight(db_session, user_id, frag_id, media_id, 0, 10)
        assert can_read_highlight(db_session, user_id, hl_id) is True

    def test_can_read_highlight_pdf_page_geometry_true(self, db_session: Session):
        """PDF highlight with canonical typed anchor is readable by author."""
        from nexus.auth.permissions import can_read_highlight

        user_id = uuid4()
        default_lib = ensure_user_and_default_library(db_session, user_id)
        media_id = _create_media(db_session, title="PDF", kind="pdf")
        _add_physical_entry(db_session, default_lib, media_id)

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
                    sort_top,
                    sort_left,
                    plain_text_match_status,
                    plain_text_start_offset,
                    plain_text_end_offset,
                    rect_count
                )
                VALUES (
                    :highlight_id,
                    :media_id,
                    1,
                    0,
                    0,
                    'unique',
                    0,
                    9,
                    1
                )
            """),
            {"highlight_id": highlight_id, "media_id": media_id},
        )
        db_session.flush()

        assert can_read_highlight(db_session, user_id, highlight_id) is True

    def test_can_read_highlight_mismatch_returns_false(self, db_session: Session):
        """Typed anchor mismatch returns False without leaking existence."""
        from nexus.auth.permissions import can_read_highlight
        from tests.factories import (
            create_mismatched_fragment_highlight,
            create_test_fragment,
            create_test_media_in_library,
            get_user_default_library,
        )

        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        lib_id = get_user_default_library(db_session, user_id)
        media_id = create_test_media_in_library(db_session, user_id, lib_id)
        frag1_id = create_test_fragment(db_session, media_id, content="a" * 30)
        media_id2 = create_test_media_in_library(db_session, user_id, lib_id, title="Other")
        frag2_id = create_test_fragment(db_session, media_id2, content="b" * 30)
        hl_id = create_mismatched_fragment_highlight(
            db_session, user_id, frag1_id, media_id, frag2_id
        )
        assert can_read_highlight(db_session, user_id, hl_id) is False

    def test_can_read_highlight_nonexistent_returns_false(self, db_session: Session):
        """Nonexistent highlight returns False without raising."""
        from nexus.auth.permissions import can_read_highlight

        user_id = uuid4()
        ensure_user_and_default_library(db_session, user_id)
        assert can_read_highlight(db_session, user_id, uuid4()) is False
