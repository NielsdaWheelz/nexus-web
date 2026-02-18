"""Service-layer and route-level tests for conversation sharing.

Tests cover:
- Service-layer sharing invariants (S3 PR-02)
- Route-level share endpoints (S4 PR-06):
  - GET /conversations/{id}/shares (owner-only)
  - PUT /conversations/{id}/shares (owner-only, atomic replacement)
  - Masking: not-visible -> 404, visible non-owner -> 403
  - Default-library target prohibition
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services import shares as shares_service
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

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
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """Can set sharing='library' with valid non-default library_ids."""
        conversation_id, user_id, default_library_id = conversation

        result = shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[extra_library]
        )

        assert result.sharing == "library"

        # Verify share exists
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 1
        assert shares[0].library_id == extra_library

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
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """Deleting the last share auto-transitions sharing to 'private'."""
        conversation_id, user_id, default_library_id = conversation

        # First, set to library sharing with a non-default library
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[extra_library]
        )

        # Verify sharing is 'library'
        result = db_session.execute(
            text("SELECT sharing FROM conversations WHERE id = :id"),
            {"id": conversation_id},
        )
        assert result.scalar() == "library"

        # Delete the share
        updated = shares_service.delete_share(db_session, conversation_id, extra_library)

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

        # Create a second non-default library for replacement test
        second_library_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO libraries (id, owner_user_id, name, is_default)
                VALUES (:id, :owner_user_id, 'Second Lib', false)
            """),
            {"id": second_library_id, "owner_user_id": user_id},
        )
        db_session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": second_library_id, "user_id": user_id},
        )
        db_session.flush()

        # Set initial share with non-default library
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[extra_library_id]
        )

        # Replace with different non-default library
        shares_service.set_shares(db_session, conversation_id, [second_library_id])

        # Verify only new library is shared
        shares = shares_service.get_shares(db_session, conversation_id)
        assert len(shares) == 1
        assert shares[0].library_id == second_library_id

    def test_set_shares_empty_list_transitions_to_private(
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """set_shares with empty list transitions sharing='library' to 'private'."""
        conversation_id, user_id, default_library_id = conversation

        # Set initial share with non-default library
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[extra_library]
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

        # Create a second non-default library for multi-share test
        second_library_id = uuid4()
        db_session.execute(
            text("""
                INSERT INTO libraries (id, owner_user_id, name, is_default)
                VALUES (:id, :owner_user_id, 'Second Library', false)
            """),
            {"id": second_library_id, "owner_user_id": user_id},
        )
        db_session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": second_library_id, "user_id": user_id},
        )
        db_session.flush()

        # Set multiple shares with non-default libraries
        shares_service.set_sharing_mode(
            db_session,
            conversation_id,
            "library",
            library_ids=[extra_library_id, second_library_id],
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

    def test_set_sharing_mode_default_library_forbidden(
        self, db_session: Session, conversation: tuple
    ):
        """set_sharing_mode rejects default library as share target."""
        conversation_id, user_id, default_library_id = conversation

        from nexus.errors import ForbiddenError

        with pytest.raises(ForbiddenError) as exc_info:
            shares_service.set_sharing_mode(
                db_session, conversation_id, "library", library_ids=[default_library_id]
            )

        assert exc_info.value.code == ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN

    def test_add_share_default_library_forbidden(
        self, db_session: Session, conversation: tuple, extra_library
    ):
        """add_share rejects default library as share target."""
        conversation_id, user_id, default_library_id = conversation

        # First set conversation to library sharing with a non-default library
        shares_service.set_sharing_mode(
            db_session, conversation_id, "library", library_ids=[extra_library]
        )

        from nexus.errors import ForbiddenError

        with pytest.raises(ForbiddenError) as exc_info:
            shares_service.add_share(db_session, conversation_id, default_library_id)

        assert exc_info.value.code == ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN

    def test_set_shares_default_library_forbidden(self, db_session: Session, conversation: tuple):
        """set_shares rejects default library as share target."""
        conversation_id, user_id, default_library_id = conversation

        from nexus.errors import ForbiddenError

        with pytest.raises(ForbiddenError) as exc_info:
            shares_service.set_shares(db_session, conversation_id, [default_library_id])

        assert exc_info.value.code == ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN


# =============================================================================
# S4 PR-06: Route-Level Share Endpoint Tests
# =============================================================================


@pytest.fixture
def shares_auth_client(engine):
    """Create a client with auth middleware for share endpoint testing."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    return TestClient(app)


def _create_conversation(session: Session, owner_user_id: UUID) -> UUID:
    conv_id = uuid4()
    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, 'private', 1)
        """),
        {"id": conv_id, "owner_user_id": owner_user_id},
    )
    session.commit()
    return conv_id


def _create_non_default_library(session: Session, owner_user_id: UUID) -> UUID:
    lib_id = uuid4()
    session.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :owner_user_id, 'Shared Lib', false)
        """),
        {"id": lib_id, "owner_user_id": owner_user_id},
    )
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": lib_id, "user_id": owner_user_id},
    )
    session.commit()
    return lib_id


def _add_member(session: Session, library_id: UUID, user_id: UUID) -> None:
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'member')
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "user_id": user_id},
    )
    session.commit()


def _share_conv(session: Session, conv_id: UUID, lib_id: UUID) -> None:
    session.execute(
        text("""
            INSERT INTO conversation_shares (conversation_id, library_id)
            VALUES (:conversation_id, :library_id)
            ON CONFLICT DO NOTHING
        """),
        {"conversation_id": conv_id, "library_id": lib_id},
    )
    session.execute(
        text("UPDATE conversations SET sharing = 'library' WHERE id = :id"),
        {"id": conv_id},
    )
    session.commit()


def _get_default_library_id(session: Session, user_id: UUID) -> UUID:
    result = session.execute(
        text("""
            SELECT id FROM libraries WHERE owner_user_id = :uid AND is_default = true
        """),
        {"uid": user_id},
    )
    return result.scalar_one()


class TestShareEndpoints:
    """Route-level tests for GET/PUT /conversations/{id}/shares."""

    def test_get_conversation_shares_owner_success(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Owner can read share targets, ordered by library_id."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_id)
            lib1 = _create_non_default_library(session, user_id)
            lib2 = _create_non_default_library(session, user_id)
            _share_conv(session, conv_id, lib1)
            _share_conv(session, conv_id, lib2)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib1)
        direct_db.register_cleanup("memberships", "library_id", lib2)
        direct_db.register_cleanup("libraries", "id", lib1)
        direct_db.register_cleanup("libraries", "id", lib2)

        response = shares_auth_client.get(
            f"/conversations/{conv_id}/shares", headers=auth_headers(user_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["conversation_id"] == str(conv_id)
        assert data["sharing"] == "library"
        assert len(data["shares"]) == 2
        # Deterministic ordering by library_id
        share_lib_ids = [s["library_id"] for s in data["shares"]]
        assert share_lib_ids == sorted(share_lib_ids)

    def test_get_conversation_shares_visible_non_owner_forbidden(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Visible non-owner gets 403 E_OWNER_REQUIRED."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_a))
        shares_auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = _create_non_default_library(session, user_a)
            _add_member(session, lib_id, user_b)
            conv_id = _create_conversation(session, user_a)
            _share_conv(session, conv_id, lib_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = shares_auth_client.get(
            f"/conversations/{conv_id}/shares", headers=auth_headers(user_b)
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_REQUIRED"

    def test_get_conversation_shares_non_visible_is_masked_404(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Non-visible conversation gives masked 404."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_a))
        shares_auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_a)

        direct_db.register_cleanup("conversations", "id", conv_id)

        response = shares_auth_client.get(
            f"/conversations/{conv_id}/shares", headers=auth_headers(user_b)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_put_conversation_shares_owner_success(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Owner can replace share targets atomically."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_id)
            lib_id = _create_non_default_library(session, user_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = shares_auth_client.put(
            f"/conversations/{conv_id}/shares",
            headers=auth_headers(user_id),
            json={"sharing": "library", "library_ids": [str(lib_id)]},
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["sharing"] == "library"
        assert len(data["shares"]) == 1
        assert data["shares"][0]["library_id"] == str(lib_id)

    def test_put_conversation_shares_default_library_forbidden(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Default library target returns E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_id)
            default_lib_id = _get_default_library_id(session, user_id)

        direct_db.register_cleanup("conversations", "id", conv_id)

        response = shares_auth_client.put(
            f"/conversations/{conv_id}/shares",
            headers=auth_headers(user_id),
            json={"sharing": "library", "library_ids": [str(default_lib_id)]},
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN"

    def test_put_conversation_shares_duplicate_library_ids_are_deduped(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Duplicate library_ids in payload produce one share row."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_id)
            lib_id = _create_non_default_library(session, user_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = shares_auth_client.put(
            f"/conversations/{conv_id}/shares",
            headers=auth_headers(user_id),
            json={"sharing": "library", "library_ids": [str(lib_id), str(lib_id)]},
        )
        assert response.status_code == 200
        assert len(response.json()["data"]["shares"]) == 1

    def test_put_conversation_shares_invalid_target_is_atomic_no_partial_write(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """If one target is invalid, no shares change (atomic failure)."""
        user_a = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_a))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_a)
            good_lib = _create_non_default_library(session, user_a)

            # Set initial share
            _share_conv(session, conv_id, good_lib)

            # Create library A is NOT member of
            user_other = create_test_user_id()
            ensure_user_and_default_library(session, user_other)
            bad_lib = _create_non_default_library(session, user_other)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", good_lib)
        direct_db.register_cleanup("memberships", "library_id", bad_lib)
        direct_db.register_cleanup("libraries", "id", good_lib)
        direct_db.register_cleanup("libraries", "id", bad_lib)

        response = shares_auth_client.put(
            f"/conversations/{conv_id}/shares",
            headers=auth_headers(user_a),
            json={"sharing": "library", "library_ids": [str(good_lib), str(bad_lib)]},
        )
        assert response.status_code == 403

        # Prior shares should be unchanged
        get_resp = shares_auth_client.get(
            f"/conversations/{conv_id}/shares", headers=auth_headers(user_a)
        )
        assert get_resp.status_code == 200
        assert len(get_resp.json()["data"]["shares"]) == 1
        assert get_resp.json()["data"]["shares"][0]["library_id"] == str(good_lib)
