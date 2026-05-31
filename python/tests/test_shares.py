"""Route-level tests for conversation sharing.

Tests cover:
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
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.mock_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_plus_billing(session: Session, user_id: UUID) -> None:
    grant_entitlement_override(
        session,
        user_id=user_id,
        plan_tier="plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="share test access",
        actor_label="test",
    )


@pytest.fixture
def shares_auth_client(engine):
    """Create a client with auth middleware for share endpoint testing."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID, email: str | None = None) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id, email=email)
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
    existing = session.execute(
        text("""
            SELECT 1
            FROM memberships
            WHERE library_id = :library_id AND user_id = :user_id
        """),
        {"library_id": library_id, "user_id": user_id},
    ).scalar_one_or_none()
    if existing is not None:
        session.commit()
        return

    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'member')
        """),
        {"library_id": library_id, "user_id": user_id},
    )
    session.commit()


def _share_conv(session: Session, conv_id: UUID, lib_id: UUID) -> None:
    existing = session.execute(
        text("""
            SELECT 1
            FROM conversation_shares
            WHERE conversation_id = :conversation_id AND library_id = :library_id
        """),
        {"conversation_id": conv_id, "library_id": lib_id},
    ).scalar_one_or_none()
    if existing is None:
        session.execute(
            text("""
                INSERT INTO conversation_shares (conversation_id, library_id)
                VALUES (:conversation_id, :library_id)
            """),
            {"conversation_id": conv_id, "library_id": lib_id},
        )

    session.execute(
        text("UPDATE conversations SET sharing = 'library', updated_at = now() WHERE id = :id"),
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
            _seed_plus_billing(session, user_id)
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

    def test_put_conversation_shares_empty_list_clears_shares(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Owner can clear share targets through the atomic replacement endpoint."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv_id = _create_conversation(session, user_id)
            lib_id = _create_non_default_library(session, user_id)
            _share_conv(session, conv_id, lib_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = shares_auth_client.put(
            f"/conversations/{conv_id}/shares",
            headers=auth_headers(user_id),
            json={"sharing": "library", "library_ids": []},
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["sharing"] == "private"
        assert data["shares"] == []

    def test_put_conversation_shares_default_library_forbidden(
        self, shares_auth_client, direct_db: DirectSessionManager
    ):
        """Default library target returns E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN."""
        user_id = create_test_user_id()
        shares_auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            _seed_plus_billing(session, user_id)
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
            _seed_plus_billing(session, user_id)
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
            _seed_plus_billing(session, user_a)
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
