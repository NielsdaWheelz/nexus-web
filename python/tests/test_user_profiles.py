"""Integration tests for user profiles, search, and email-based library invites.

Tests cover:
- Bootstrap syncs email from JWT to users table
- GET /me returns email and display_name
- PATCH /me updates display_name
- GET /users/search searches by email prefix and display_name substring
- Library member/invite responses include email and display_name
- Invite by email (alternative to user_id)
"""

from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.services.sealed_handles import seal_user, unseal_user
from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


def _enable_sharing(direct_db, user_id) -> None:
    with direct_db.session() as db:
        db.execute(
            text(
                "INSERT INTO billing_entitlement_overrides "
                "(id, user_id, plan_tier, reason) "
                "VALUES (:id, :user_id, 'plus', 'library invite test')"
            ),
            {"id": uuid4(), "user_id": user_id},
        )
        db.commit()


def _user_invitee(user_id) -> dict:
    return {"kind": "User", "userHandle": str(seal_user(user_id))}


# =============================================================================
# Bootstrap email sync
# =============================================================================


class TestBootstrapEmailSync:
    """Tests that email from JWT is persisted to users table during bootstrap."""

    def test_bootstrap_syncs_email_from_jwt(self, auth_client):
        """First auth request with email in JWT stores email in users table."""
        user_id = create_test_user_id()
        email = f"test-{user_id}@example.com"

        response = auth_client.get(
            "/me",
            headers=auth_headers(user_id, email=email),
        )

        assert response.status_code == 200, (
            f"Expected 200 but got {response.status_code}: {response.json()}"
        )
        data = response.json()["data"]
        assert data["email"] == email, (
            f"Expected email '{email}' in /me response, got '{data.get('email')}'"
        )

    def test_bootstrap_updates_email_on_re_login(self, auth_client):
        """Subsequent auth with different email updates the stored email."""
        user_id = create_test_user_id()
        old_email = f"old-{user_id}@example.com"
        new_email = f"new-{user_id}@example.com"

        # First login with old email
        auth_client.get("/me", headers=auth_headers(user_id, email=old_email))

        # Second login with new email
        response = auth_client.get(
            "/me",
            headers=auth_headers(user_id, email=new_email),
        )

        data = response.json()["data"]
        assert data["email"] == new_email, (
            f"Expected email to update to '{new_email}', got '{data.get('email')}'"
        )


# =============================================================================
# GET /me with profile fields
# =============================================================================


class TestGetMeProfile:
    """Tests for GET /me including email and display_name."""

    def test_get_me_returns_email(self, auth_client):
        """GET /me includes email field synced from JWT."""
        user_id = create_test_user_id()
        email = f"profile-{user_id}@example.com"

        response = auth_client.get(
            "/me",
            headers=auth_headers(user_id, email=email),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert "email" in data, f"Expected 'email' in /me response, got keys: {list(data.keys())}"
        assert data["email"] == email

    def test_get_me_returns_display_name_null_initially(self, auth_client):
        """GET /me returns null display_name before user sets one."""
        user_id = create_test_user_id()

        response = auth_client.get(
            "/me",
            headers=auth_headers(user_id, email=f"dn-{user_id}@example.com"),
        )

        data = response.json()["data"]
        assert "display_name" in data, (
            f"Expected 'display_name' in /me response, got keys: {list(data.keys())}"
        )
        assert data["display_name"] is None


# =============================================================================
# PATCH /me (display_name)
# =============================================================================


class TestPatchMe:
    """Tests for PATCH /me to update display_name."""

    def test_patch_me_updates_display_name(self, auth_client):
        """PATCH /me with display_name updates the user's display name."""
        user_id = create_test_user_id()
        email = f"patch-{user_id}@example.com"
        headers = auth_headers(user_id, email=email)

        # Bootstrap user
        auth_client.get("/me", headers=headers)

        # Update display_name
        response = auth_client.patch(
            "/me",
            json={"display_name": "Alice Wonderland"},
            headers=headers,
        )

        assert response.status_code == 200, (
            f"Expected 200 but got {response.status_code}: {response.json()}"
        )
        data = response.json()["data"]
        assert data["display_name"] == "Alice Wonderland"

    def test_patch_me_display_name_persists(self, auth_client):
        """Updated display_name is returned on subsequent GET /me."""
        user_id = create_test_user_id()
        headers = auth_headers(user_id, email=f"persist-{user_id}@example.com")

        auth_client.get("/me", headers=headers)
        auth_client.patch("/me", json={"display_name": "Bob Builder"}, headers=headers)

        response = auth_client.get("/me", headers=headers)
        data = response.json()["data"]
        assert data["display_name"] == "Bob Builder"

    def test_patch_me_rejects_too_long_display_name(self, auth_client):
        """Display name > 100 chars returns 400."""
        user_id = create_test_user_id()
        headers = auth_headers(user_id, email=f"long-{user_id}@example.com")
        auth_client.get("/me", headers=headers)

        response = auth_client.patch(
            "/me",
            json={"display_name": "A" * 101},
            headers=headers,
        )

        assert response.status_code == 400, (
            f"Expected 400 for too-long display_name, got {response.status_code}: {response.json()}"
        )

    def test_patch_me_clears_display_name_with_null(self, auth_client):
        """Setting display_name to null clears it."""
        user_id = create_test_user_id()
        headers = auth_headers(user_id, email=f"clear-{user_id}@example.com")
        auth_client.get("/me", headers=headers)

        auth_client.patch("/me", json={"display_name": "Temp"}, headers=headers)
        response = auth_client.patch("/me", json={"display_name": None}, headers=headers)

        assert response.status_code == 200
        assert response.json()["data"]["display_name"] is None


# =============================================================================
# GET /users/search
# =============================================================================


class TestUserSearch:
    """Tests for GET /users/search endpoint."""

    def test_search_users_by_email_prefix(self, auth_client):
        """Search finds users by email prefix (case-insensitive)."""
        # Create two users with known emails
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        searcher = create_test_user_id()

        email_a = f"alice-{user_a}@example.com"
        email_b = f"bob-{user_b}@example.com"

        auth_client.get("/me", headers=auth_headers(user_a, email=email_a))
        auth_client.get("/me", headers=auth_headers(user_b, email=email_b))
        auth_client.get(
            "/me", headers=auth_headers(searcher, email=f"searcher-{searcher}@example.com")
        )

        response = auth_client.get(
            f"/users/search?q=alice-{user_a}",
            headers=auth_headers(searcher, email=f"searcher-{searcher}@example.com"),
        )

        assert response.status_code == 200, (
            f"Expected 200 but got {response.status_code}: {response.json()}"
        )
        data = response.json()["data"]
        assert len(data) >= 1, f"Expected at least 1 result, got {len(data)}"
        emails = [u["email"] for u in data]
        assert email_a in emails, f"Expected '{email_a}' in results, got {emails}"

    def test_search_users_by_display_name(self, auth_client):
        """Search finds users by display_name substring."""
        user_id = create_test_user_id()
        searcher = create_test_user_id()
        email = f"dn-search-{user_id}@example.com"
        headers = auth_headers(user_id, email=email)

        auth_client.get("/me", headers=headers)
        auth_client.patch(
            "/me", json={"display_name": f"UniqueTestName-{user_id}"}, headers=headers
        )
        auth_client.get("/me", headers=auth_headers(searcher, email=f"s-{searcher}@example.com"))

        response = auth_client.get(
            f"/users/search?q=UniqueTestName-{user_id}",
            headers=auth_headers(searcher, email=f"s-{searcher}@example.com"),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) >= 1, "Expected at least 1 result for display_name search"
        user_ids = [unseal_user(u["userHandle"]) for u in data]
        assert user_id in user_ids

    def test_search_users_rejects_short_query(self, auth_client):
        """Query shorter than 3 characters returns 400."""
        user_id = create_test_user_id()
        headers = auth_headers(user_id, email=f"short-{user_id}@example.com")
        auth_client.get("/me", headers=headers)

        response = auth_client.get("/users/search?q=ab", headers=headers)

        assert response.status_code == 400, (
            f"Expected 400 for short query, got {response.status_code}: {response.json()}"
        )

    def test_search_users_caps_results(self, auth_client):
        """Results are capped at the limit parameter."""
        searcher = create_test_user_id()
        headers = auth_headers(searcher, email=f"cap-{searcher}@example.com")
        auth_client.get("/me", headers=headers)

        response = auth_client.get(
            "/users/search?q=test&limit=2",
            headers=headers,
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) <= 2, f"Expected at most 2 results, got {len(data)}"

    def test_search_users_excludes_self(self, auth_client):
        """Search results do not include the searching user."""
        user_id = create_test_user_id()
        email = f"selfexclude-{user_id}@example.com"
        headers = auth_headers(user_id, email=email)
        auth_client.get("/me", headers=headers)

        response = auth_client.get(
            f"/users/search?q=selfexclude-{user_id}",
            headers=headers,
        )

        assert response.status_code == 200
        data = response.json()["data"]
        user_ids = [unseal_user(u["userHandle"]) for u in data]
        assert user_id not in user_ids, (
            f"Search should exclude self, but found {user_id} in results"
        )

    def test_search_users_returns_expected_fields(self, auth_client):
        """Each result includes user_handle, email, and display_name."""
        user_a = create_test_user_id()
        searcher = create_test_user_id()
        email_a = f"fields-{user_a}@example.com"

        auth_client.get("/me", headers=auth_headers(user_a, email=email_a))
        auth_client.patch(
            "/me",
            json={"display_name": "FieldsTest"},
            headers=auth_headers(user_a, email=email_a),
        )
        auth_client.get("/me", headers=auth_headers(searcher, email=f"fs-{searcher}@example.com"))

        response = auth_client.get(
            f"/users/search?q=fields-{user_a}",
            headers=auth_headers(searcher, email=f"fs-{searcher}@example.com"),
        )

        data = response.json()["data"]
        assert len(data) >= 1
        result = next(u for u in data if unseal_user(u["userHandle"]) == user_a)
        assert set(result) == {"userHandle", "email", "displayName"}
        assert result["email"] == email_a
        assert result["displayName"] == "FieldsTest"


# =============================================================================
# Library members/invites include email + display_name
# =============================================================================


class TestMemberResponseEnrichment:
    """Tests that member and invite list responses include email/display_name."""

    def test_list_members_includes_email_and_display_name(self, auth_client):
        """GET /libraries/{id}/members returns email and display_name for each member."""
        owner = create_test_user_id()
        owner_email = f"owner-{owner}@example.com"
        headers = auth_headers(owner, email=owner_email)

        # Create library
        lib_resp = auth_client.post(
            "/libraries",
            json={"name": "Member Test Lib"},
            headers=headers,
        )
        assert lib_resp.status_code == 201
        lib_id = lib_resp.json()["data"]["id"]

        # Set display_name
        auth_client.patch("/me", json={"display_name": "OwnerName"}, headers=headers)

        # List members
        response = auth_client.get(f"/libraries/{lib_id}/members", headers=headers)

        assert response.status_code == 200
        members = response.json()["data"]
        assert len(members) >= 1
        owner_member = next(m for m in members if unseal_user(m["userHandle"]) == owner)
        assert "email" in owner_member, (
            f"Expected 'email' in member response, got keys: {list(owner_member.keys())}"
        )
        assert owner_member["email"] == owner_email
        assert owner_member["displayName"] == "OwnerName"

    def test_list_invites_includes_invitee_email(self, auth_client, direct_db):
        """GET /libraries/{id}/invites includes invitee email/display_name."""
        owner = create_test_user_id()
        invitee = create_test_user_id()
        owner_email = f"inv-owner-{owner}@example.com"
        invitee_email = f"inv-target-{invitee}@example.com"

        owner_headers = auth_headers(owner, email=owner_email)
        invitee_headers = auth_headers(invitee, email=invitee_email)

        # Bootstrap both users
        auth_client.get("/me", headers=owner_headers)
        auth_client.get("/me", headers=invitee_headers)
        _enable_sharing(direct_db, owner)

        # Create library
        lib_resp = auth_client.post(
            "/libraries",
            json={"name": "Invite Test Lib"},
            headers=owner_headers,
        )
        lib_id = lib_resp.json()["data"]["id"]

        # Create invite by sealed user handle.
        auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={
                "invitee": {
                    "kind": "User",
                    "userHandle": seal_user(invitee),
                },
                "role": "member",
            },
            headers=owner_headers,
        )

        # List invites
        response = auth_client.get(
            f"/libraries/{lib_id}/invites",
            headers=owner_headers,
        )

        assert response.status_code == 200
        invites = response.json()["data"]
        assert len(invites) >= 1
        inv = invites[0]
        assert "inviteeEmail" in inv, (
            f"Expected 'invitee_email' in invite response, got keys: {list(inv.keys())}"
        )
        assert inv["inviteeEmail"] == invitee_email


# =============================================================================
# Invite by email
# =============================================================================


class TestInviteByEmail:
    """Tests for creating library invites using email instead of user_id."""

    def test_create_invite_by_email(self, auth_client, direct_db):
        """POST /libraries/{id}/invites with invitee_email creates invite."""
        owner = create_test_user_id()
        invitee = create_test_user_id()
        owner_email = f"byemail-owner-{owner}@example.com"
        invitee_email = f"byemail-target-{invitee}@example.com"

        owner_headers = auth_headers(owner, email=owner_email)

        # Bootstrap both
        auth_client.get("/me", headers=owner_headers)
        auth_client.get("/me", headers=auth_headers(invitee, email=invitee_email))
        _enable_sharing(direct_db, owner)

        # Create library
        lib_resp = auth_client.post(
            "/libraries",
            json={"name": "Email Invite Lib"},
            headers=owner_headers,
        )
        lib_id = lib_resp.json()["data"]["id"]

        # Invite by email
        response = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={
                "invitee": {"kind": "Email", "email": invitee_email},
                "role": "member",
            },
            headers=owner_headers,
        )

        assert response.status_code == 201, (
            f"Expected 201 for invite-by-email, got {response.status_code}: {response.json()}"
        )
        data = response.json()["data"]
        assert unseal_user(data["inviteeUserHandle"]) == invitee

    def test_create_invite_by_nonexistent_email_returns_404(self, auth_client):
        """Invite by email for non-existent user returns 404."""
        owner = create_test_user_id()
        owner_headers = auth_headers(owner, email=f"nouser-owner-{owner}@example.com")
        auth_client.get("/me", headers=owner_headers)

        lib_resp = auth_client.post(
            "/libraries",
            json={"name": "No User Lib"},
            headers=owner_headers,
        )
        lib_id = lib_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={
                "invitee": {
                    "kind": "Email",
                    "email": "nonexistent@example.com",
                },
                "role": "member",
            },
            headers=owner_headers,
        )

        assert response.status_code == 404, (
            f"Expected 404 for nonexistent email, got {response.status_code}: {response.json()}"
        )

    def test_create_invite_requires_email_or_user_id(self, auth_client):
        """Invite without the strict invitee union returns 400."""
        owner = create_test_user_id()
        owner_headers = auth_headers(owner, email=f"neither-{owner}@example.com")
        auth_client.get("/me", headers=owner_headers)

        lib_resp = auth_client.post(
            "/libraries",
            json={"name": "Neither Lib"},
            headers=owner_headers,
        )
        lib_id = lib_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={"role": "member"},
            headers=owner_headers,
        )

        assert response.status_code == 400, (
            f"Expected 400 when neither email nor user_id provided, "
            f"got {response.status_code}: {response.json()}"
        )


class TestLibraryInviteBilling:
    def test_free_actor_cannot_create_invitation(self, auth_client):
        owner = create_test_user_id()
        invitee = create_test_user_id()
        owner_headers = auth_headers(owner)
        auth_client.get("/me", headers=owner_headers)
        auth_client.get("/me", headers=auth_headers(invitee))
        library_id = auth_client.post(
            "/libraries",
            json={"name": "Free invite gate"},
            headers=owner_headers,
        ).json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee), "role": "member"},
            headers=owner_headers,
        )
        assert response.status_code == 402
        assert response.json()["error"]["code"] == "E_BILLING_REQUIRED"

    def test_pending_duplicate_stays_conflict_after_downgrade(
        self,
        auth_client,
        direct_db,
    ):
        owner = create_test_user_id()
        invitee = create_test_user_id()
        owner_headers = auth_headers(owner)
        auth_client.get("/me", headers=owner_headers)
        auth_client.get("/me", headers=auth_headers(invitee))
        _enable_sharing(direct_db, owner)
        library_id = auth_client.post(
            "/libraries",
            json={"name": "Downgrade invite gate"},
            headers=owner_headers,
        ).json()["data"]["id"]
        body = {"invitee": _user_invitee(invitee), "role": "member"}
        created = auth_client.post(
            f"/libraries/{library_id}/invites",
            json=body,
            headers=owner_headers,
        )
        assert created.status_code == 201, created.json()

        with direct_db.session() as db:
            db.execute(
                text("DELETE FROM billing_entitlement_overrides WHERE user_id = :user_id"),
                {"user_id": owner},
            )
            db.commit()

        repeated = auth_client.post(
            f"/libraries/{library_id}/invites",
            json=body,
            headers=owner_headers,
        )
        assert repeated.status_code == 409
        assert repeated.json()["error"]["code"] == "E_INVITE_ALREADY_EXISTS"
