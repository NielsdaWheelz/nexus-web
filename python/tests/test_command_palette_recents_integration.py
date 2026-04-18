"""Integration tests for command palette recents."""

from datetime import UTC, datetime, timedelta

import pytest

from nexus.db.models import CommandPaletteRecent
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id):
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200


class TestGetCommandPaletteRecents:
    def test_get_returns_only_current_viewer_rows_in_descending_recency_order(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        other_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, other_id)

        now = datetime.now(UTC)
        with direct_db.session() as session:
            session.add_all(
                [
                    CommandPaletteRecent(
                        user_id=viewer_id,
                        href="/search",
                        title_snapshot="Search",
                        created_at=now - timedelta(minutes=3),
                        last_used_at=now - timedelta(minutes=3),
                    ),
                    CommandPaletteRecent(
                        user_id=viewer_id,
                        href="/media/media-2",
                        title_snapshot="Media two",
                        created_at=now - timedelta(minutes=1),
                        last_used_at=now - timedelta(minutes=1),
                    ),
                    CommandPaletteRecent(
                        user_id=viewer_id,
                        href="/libraries",
                        title_snapshot="Libraries",
                        created_at=now - timedelta(minutes=2),
                        last_used_at=now - timedelta(minutes=2),
                    ),
                    CommandPaletteRecent(
                        user_id=other_id,
                        href="/videos",
                        title_snapshot="Videos",
                        created_at=now,
                        last_used_at=now,
                    ),
                ]
            )
            session.commit()

        response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200
        rows = response.json()["data"]
        assert [row["href"] for row in rows] == [
            "/media/media-2",
            "/libraries",
            "/search",
        ]


class TestPostCommandPaletteRecent:
    def test_post_inserts_supported_route(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/search", "title_snapshot": "Search"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["href"] == "/search"
        assert data["title_snapshot"] == "Search"
        assert data["last_used_at"]

    def test_removed_discover_podcasts_route_is_rejected(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/discover/podcasts?query=tech", "title_snapshot": "Discover podcasts"},
            headers=auth_headers(user_id),
        )
        list_response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400, (
            f"Expected removed discover podcasts route to be rejected, got {response.status_code}: "
            f"{response.json()}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert list_response.status_code == 200
        assert list_response.json()["data"] == []

    def test_post_canonicalizes_podcast_home_route(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/podcasts?sort=unplayed", "title_snapshot": "Podcasts"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected podcasts recent to be accepted, got {response.status_code}: "
            f"{response.json()}"
        )
        data = response.json()["data"]
        assert data["href"] == "/podcasts"
        assert data["title_snapshot"] == "Podcasts"

    def test_post_updates_last_used_at_instead_of_creating_second_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        first = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/media/media-1?t_start_ms=1200", "title_snapshot": "Old title"},
            headers=auth_headers(user_id),
        )
        second = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/media/media-1?fragment=f1", "title_snapshot": "New title"},
            headers=auth_headers(user_id),
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["data"]["href"] == "/media/media-1"
        assert second.json()["data"]["title_snapshot"] == "New title"
        assert second.json()["data"]["last_used_at"] >= first.json()["data"]["last_used_at"]

        with direct_db.session() as session:
            rows = (
                session.query(CommandPaletteRecent)
                .filter(CommandPaletteRecent.user_id == user_id)
                .all()
            )
            assert len(rows) == 1
            assert rows[0].href == "/media/media-1"
            assert rows[0].title_snapshot == "New title"

    def test_post_trims_to_eight_rows(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        for idx in range(9):
            response = auth_client.post(
                "/me/command-palette-recents",
                json={"href": f"/media/media-{idx}"},
                headers=auth_headers(user_id),
            )
            assert response.status_code == 200

        response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        rows = response.json()["data"]
        assert len(rows) == 8
        assert "/media/media-0" not in [row["href"] for row in rows]
        assert rows[0]["href"] == "/media/media-8"

    def test_query_param_variants_collapse_to_one_canonical_row(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        first = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/conversations/conv-1?message=7"},
            headers=auth_headers(user_id),
        )
        second = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/conversations/conv-1#latest"},
            headers=auth_headers(user_id),
        )
        list_response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(user_id),
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert list_response.status_code == 200
        rows = list_response.json()["data"]
        assert len(rows) == 1
        assert rows[0]["href"] == "/conversations/conv-1"

    def test_removed_podcast_subscriptions_route_is_rejected(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/podcasts/subscriptions", "title_snapshot": "My podcasts"},
            headers=auth_headers(user_id),
        )
        list_response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400, (
            f"Expected removed subscriptions route to be rejected, got {response.status_code}: "
            f"{response.json()}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert list_response.status_code == 200
        assert list_response.json()["data"] == []

    def test_transient_routes_are_rejected_and_do_not_create_rows(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = auth_client.post(
            "/me/command-palette-recents",
            json={"href": "/conversations/new?quote=123"},
            headers=auth_headers(user_id),
        )
        list_response = auth_client.get(
            "/me/command-palette-recents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert list_response.status_code == 200
        assert list_response.json()["data"] == []
