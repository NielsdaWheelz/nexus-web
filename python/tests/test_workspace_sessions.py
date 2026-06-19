"""Integration tests for per-device workspace session persistence."""

import pytest

from nexus.schemas.workspace_session import WORKSPACE_SESSION_DEVICE_ID_MAX_LENGTH
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _sample_state(active_pane_id: str = "pane-1", href: str = "/libraries") -> dict:
    """Build a representative opaque workspace state blob."""
    return {
        "schemaVersion": 6,
        "activePaneId": active_pane_id,
        "panes": [
            {
                "id": active_pane_id,
                "href": href,
                "widthPx": 480,
                "visibility": "visible",
                "history": {"back": [], "forward": []},
            }
        ],
    }


def _register_session_cleanup(direct_db: DirectSessionManager, user_id) -> None:
    """Register cleanup for a user's workspace session rows."""
    direct_db.register_cleanup("workspace_sessions", "user_id", user_id)


def _assert_invalid_request(resp) -> None:
    """Assert the repo-standard request validation error envelope."""

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestWorkspaceSession:
    """GET/PUT /me/workspace-session."""

    def test_put_then_get_round_trips_own_session(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        state = _sample_state()
        put_resp = auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": state},
            headers=auth_headers(user_id),
        )

        assert put_resp.status_code == 200
        assert put_resp.json()["data"]["state"] == state

        get_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-a"},
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["own"]["state"] == state
        assert data["most_recent_elsewhere"] is None

    def test_put_twice_same_device_is_last_write_wins(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        first_state = _sample_state(active_pane_id="pane-1", href="/libraries")
        second_state = _sample_state(active_pane_id="pane-2", href="/media/abc")

        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": first_state},
            headers=auth_headers(user_id),
        )
        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": second_state},
            headers=auth_headers(user_id),
        )

        get_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-a"},
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        assert get_resp.json()["data"]["own"]["state"] == second_state

    def test_cross_device_get_sees_other_device_session(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        state_a = _sample_state(active_pane_id="pane-a", href="/media/from-a")
        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": state_a},
            headers=auth_headers(user_id),
        )

        get_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-b"},
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["own"] is None
        assert data["most_recent_elsewhere"]["state"] == state_a

    def test_most_recent_elsewhere_returns_latest_other_device(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        older_state = _sample_state(active_pane_id="pane-old", href="/media/older")
        newer_state = _sample_state(active_pane_id="pane-new", href="/media/newer")

        # PUT device-a first, then device-b — device-b is the most recent.
        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": older_state},
            headers=auth_headers(user_id),
        )
        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-b", "state": newer_state},
            headers=auth_headers(user_id),
        )

        get_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-c"},
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["own"] is None
        assert data["most_recent_elsewhere"]["state"] == newer_state

    def test_get_returns_null_when_device_has_no_session(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        get_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-a"},
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["own"] is None
        assert data["most_recent_elsewhere"] is None

    def test_sessions_are_user_scoped(self, auth_client, direct_db: DirectSessionManager):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))
        _register_session_cleanup(direct_db, user_a)
        _register_session_cleanup(direct_db, user_b)

        state_a = _sample_state(active_pane_id="pane-a", href="/media/owned-by-a")
        auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": state_a},
            headers=auth_headers(user_a),
        )

        own_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-a"},
            headers=auth_headers(user_b),
        )
        elsewhere_resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": "device-b"},
            headers=auth_headers(user_b),
        )

        assert own_resp.status_code == 200
        assert own_resp.json()["data"]["own"] is None
        assert elsewhere_resp.status_code == 200
        assert elsewhere_resp.json()["data"]["most_recent_elsewhere"] is None

    def test_get_rejects_missing_device_id(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        resp = auth_client.get(
            "/me/workspace-session",
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)

    @pytest.mark.parametrize(
        "device_id",
        ["", "x" * (WORKSPACE_SESSION_DEVICE_ID_MAX_LENGTH + 1)],
    )
    def test_get_rejects_device_id_outside_length_bounds(
        self, auth_client, direct_db: DirectSessionManager, device_id: str
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        resp = auth_client.get(
            "/me/workspace-session",
            params={"device_id": device_id},
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)

    def test_put_rejects_unknown_extra_field(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        resp = auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": _sample_state(), "bogus": True},
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)

    def test_put_rejects_oversized_state(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        oversized_state = {"schemaVersion": 4, "blob": "x" * 70_000}
        resp = auth_client.put(
            "/me/workspace-session",
            json={"device_id": "device-a", "state": oversized_state},
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)

    def test_put_rejects_missing_device_id(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        resp = auth_client.put(
            "/me/workspace-session",
            json={"state": _sample_state()},
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)

    @pytest.mark.parametrize(
        "device_id",
        ["", "x" * (WORKSPACE_SESSION_DEVICE_ID_MAX_LENGTH + 1)],
    )
    def test_put_rejects_device_id_outside_length_bounds(
        self, auth_client, direct_db: DirectSessionManager, device_id: str
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _register_session_cleanup(direct_db, user_id)

        resp = auth_client.put(
            "/me/workspace-session",
            json={"device_id": device_id, "state": _sample_state()},
            headers=auth_headers(user_id),
        )

        _assert_invalid_request(resp)
