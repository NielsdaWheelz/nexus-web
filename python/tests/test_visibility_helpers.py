"""Tests for s4 visibility helper split and strict revocation.

Tests cover:
- Conversation visible-read helper: owner, public, library-shared branches
- Conversation strict revocation: share revocation, viewer membership, owner membership
- Highlight visible-read helper: media visibility + library intersection
- Highlight strict revocation: intersection membership revocation
- Owner/author write helpers remain masked 404

These tests exercise the service-layer helpers, not routes.
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversations import (
    get_conversation_for_owner_write_or_404,
    get_conversation_for_visible_read_or_404,
)
from nexus.services.highlights import (
    get_highlight_for_author_write_or_404,
    get_highlight_for_visible_read_or_404,
)

# =============================================================================
# Helpers
# =============================================================================


def _create_non_default_library(db: Session, owner_id):
    result = db.execute(
        text("""
            INSERT INTO libraries (name, owner_user_id, is_default)
            VALUES ('Shared Lib', :owner_id, false)
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


def _add_membership(db: Session, library_id, user_id, role="member"):
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:lib, :uid, :role)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "uid": user_id, "role": role},
    )
    db.flush()


def _create_conversation(db: Session, owner_id, sharing="private"):
    result = db.execute(
        text("""
            INSERT INTO conversations (owner_user_id, sharing, next_seq)
            VALUES (:owner, :sharing, 1)
            RETURNING id
        """),
        {"owner": owner_id, "sharing": sharing},
    )
    conv_id = result.scalar()
    db.flush()
    return conv_id


def _share_conversation(db: Session, conversation_id, library_id):
    db.execute(
        text("""
            INSERT INTO conversation_shares (conversation_id, library_id)
            VALUES (:cid, :lid)
            ON CONFLICT DO NOTHING
        """),
        {"cid": conversation_id, "lid": library_id},
    )
    db.flush()


def _create_media_and_fragment(db: Session, title="Test Article"):
    media_id = uuid4()
    fragment_id = uuid4()
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:mid, 'web_article', :title, 'ready_for_reading')
        """),
        {"mid": media_id, "title": title},
    )
    db.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (:fid, :mid, 0, '<p>test</p>', 'test content here')
        """),
        {"fid": fragment_id, "mid": media_id},
    )
    db.flush()
    return media_id, fragment_id


def _add_media_to_library(db: Session, library_id, media_id):
    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:lib, :mid)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "mid": media_id},
    )
    db.flush()


def _create_highlight(db: Session, user_id, fragment_id):
    highlight_id = uuid4()
    db.execute(
        text("""
            INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                    color, exact, prefix, suffix)
            VALUES (:hid, :uid, :fid, 0, 4, 'yellow', 'test', '', ' content here')
        """),
        {"hid": highlight_id, "uid": user_id, "fid": fragment_id},
    )
    db.flush()
    return highlight_id


# =============================================================================
# Conversation visible-read helper
# =============================================================================


class TestConversationVisibleRead:
    def test_get_conversation_for_visible_read_or_404_allows_owner(self, db_session: Session):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        conv_id = _create_conversation(db_session, owner_id, sharing="private")

        convo = get_conversation_for_visible_read_or_404(db_session, owner_id, conv_id)
        assert convo.id == conv_id

    def test_get_conversation_for_visible_read_or_404_allows_public_non_owner(
        self, db_session: Session
    ):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="public")

        convo = get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)
        assert convo.id == conv_id

    def test_get_conversation_for_visible_read_or_404_allows_library_shared_non_owner(
        self, db_session: Session
    ):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        # Create shared library with both members
        lib_id = _create_non_default_library(db_session, owner_id)
        _add_membership(db_session, lib_id, viewer_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="library")
        _share_conversation(db_session, conv_id, lib_id)

        convo = get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)
        assert convo.id == conv_id

    def test_get_conversation_for_visible_read_or_404_denies_after_share_revoked(
        self, db_session: Session
    ):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        _add_membership(db_session, lib_id, viewer_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="library")
        _share_conversation(db_session, conv_id, lib_id)

        # Verify access works first
        get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)

        # Revoke share
        db_session.execute(
            text("DELETE FROM conversation_shares WHERE conversation_id = :c AND library_id = :l"),
            {"c": conv_id, "l": lib_id},
        )
        db_session.flush()

        with pytest.raises(NotFoundError) as exc_info:
            get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)
        assert exc_info.value.code.value == "E_CONVERSATION_NOT_FOUND"

    def test_get_conversation_for_visible_read_or_404_denies_after_viewer_membership_revoked(
        self, db_session: Session
    ):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        _add_membership(db_session, lib_id, viewer_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="library")
        _share_conversation(db_session, conv_id, lib_id)

        # Verify access works first
        get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)

        # Revoke viewer membership
        db_session.execute(
            text("DELETE FROM memberships WHERE library_id = :l AND user_id = :u"),
            {"l": lib_id, "u": viewer_id},
        )
        db_session.flush()

        with pytest.raises(NotFoundError) as exc_info:
            get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)
        assert exc_info.value.code.value == "E_CONVERSATION_NOT_FOUND"

    def test_get_conversation_for_visible_read_or_404_denies_after_owner_membership_revoked(
        self, db_session: Session
    ):
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        lib_id = _create_non_default_library(db_session, owner_id)
        _add_membership(db_session, lib_id, viewer_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="library")
        _share_conversation(db_session, conv_id, lib_id)

        # Remove owner membership (share row stays)
        db_session.execute(
            text("DELETE FROM memberships WHERE library_id = :l AND user_id = :u"),
            {"l": lib_id, "u": owner_id},
        )
        db_session.flush()

        with pytest.raises(NotFoundError) as exc_info:
            get_conversation_for_visible_read_or_404(db_session, viewer_id, conv_id)
        assert exc_info.value.code.value == "E_CONVERSATION_NOT_FOUND"


# =============================================================================
# Highlight visible-read helper
# =============================================================================


class TestHighlightVisibleRead:
    def test_get_highlight_for_visible_read_or_404_requires_media_visibility_and_library_intersection(
        self, db_session: Session
    ):
        """Highlight visible when viewer can read media + library intersection with author."""
        author_id = uuid4()
        ensure_user_and_default_library(db_session, author_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        # Create shared non-default library
        lib_id = _create_non_default_library(db_session, author_id)
        _add_membership(db_session, lib_id, viewer_id)

        # Create media in the shared library
        media_id, fragment_id = _create_media_and_fragment(db_session)
        _add_media_to_library(db_session, lib_id, media_id)

        # Author creates highlight
        highlight_id = _create_highlight(db_session, author_id, fragment_id)

        # Viewer can read the highlight
        h = get_highlight_for_visible_read_or_404(db_session, viewer_id, highlight_id)
        assert h.id == highlight_id

    def test_get_highlight_for_visible_read_or_404_denies_after_intersection_revoked(
        self, db_session: Session
    ):
        """Highlight not visible after library intersection is revoked."""
        author_id = uuid4()
        ensure_user_and_default_library(db_session, author_id)
        viewer_id = uuid4()
        ensure_user_and_default_library(db_session, viewer_id)

        lib_id = _create_non_default_library(db_session, author_id)
        _add_membership(db_session, lib_id, viewer_id)

        media_id, fragment_id = _create_media_and_fragment(db_session)
        _add_media_to_library(db_session, lib_id, media_id)

        highlight_id = _create_highlight(db_session, author_id, fragment_id)

        # Verify visible first
        get_highlight_for_visible_read_or_404(db_session, viewer_id, highlight_id)

        # Revoke viewer membership
        db_session.execute(
            text("DELETE FROM memberships WHERE library_id = :l AND user_id = :u"),
            {"l": lib_id, "u": viewer_id},
        )
        db_session.flush()

        with pytest.raises(NotFoundError) as exc_info:
            get_highlight_for_visible_read_or_404(db_session, viewer_id, highlight_id)
        assert exc_info.value.code.value == "E_MEDIA_NOT_FOUND"


# =============================================================================
# Owner/author write helpers masked 404
# =============================================================================


class TestWriteHelpersMasked404:
    def test_owner_and_author_write_helpers_remain_masked_404(self, db_session: Session):
        """Non-owner/non-author invocations produce masked NotFoundError."""
        owner_id = uuid4()
        ensure_user_and_default_library(db_session, owner_id)
        non_owner_id = uuid4()
        ensure_user_and_default_library(db_session, non_owner_id)

        conv_id = _create_conversation(db_session, owner_id, sharing="public")

        # Non-owner cannot use write helper even if conversation is public
        with pytest.raises(NotFoundError) as exc_info:
            get_conversation_for_owner_write_or_404(db_session, non_owner_id, conv_id)
        assert exc_info.value.code.value == "E_CONVERSATION_NOT_FOUND"

        # Create media and highlight by owner
        lib_id = _create_non_default_library(db_session, owner_id)
        _add_membership(db_session, lib_id, non_owner_id)
        media_id, fragment_id = _create_media_and_fragment(db_session)
        _add_media_to_library(db_session, lib_id, media_id)
        highlight_id = _create_highlight(db_session, owner_id, fragment_id)

        # Non-author cannot use author-write helper
        with pytest.raises(NotFoundError) as exc_info:
            get_highlight_for_author_write_or_404(db_session, non_owner_id, highlight_id)
        assert exc_info.value.code.value == "E_MEDIA_NOT_FOUND"
