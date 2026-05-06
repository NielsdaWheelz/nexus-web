"""Integration tests for command palette usage history."""

import pytest

from nexus.db.models import CommandPaletteUsage
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id):
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200


def _record_selection(auth_client, user_id, **overrides):
    payload = {
        "query": "",
        "target_key": "/search",
        "target_kind": "href",
        "target_href": "/search",
        "title_snapshot": "Search",
        "source": "static",
    }
    payload.update(overrides)
    return auth_client.post(
        "/me/palette-selections",
        json=payload,
        headers=auth_headers(user_id),
    )


class TestPaletteSelections:
    def test_post_records_supported_href_target_and_normalized_query(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = _record_selection(
            auth_client,
            user_id,
            query="  System   Search  ",
            target_key="/browse",
            target_href="/browse?q=  systems   thinking  &types=videos,podcasts#results",
            title_snapshot="  Browse   systems  ",
            source="search",
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["query_normalized"] == "system search"
        assert data["target_key"] == "/browse?q=systems+thinking&types=podcasts%2Cvideos"
        assert data["target_kind"] == "href"
        assert data["target_href"] == "/browse?q=systems+thinking&types=podcasts%2Cvideos"
        assert data["title_snapshot"] == "Browse systems"
        assert data["source"] == "search"
        assert data["use_count"] == 1
        assert data["last_used_at"]

    def test_post_updates_existing_query_target_row_and_caps_timestamp_history(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        direct_db.register_cleanup("command_palette_usages", "user_id", user_id)

        for idx in range(12):
            response = _record_selection(
                auth_client,
                user_id,
                query="Media",
                target_key="/media/media-1",
                target_href="/media/media-1?t_start_ms=1200",
                title_snapshot=f"Media {idx}",
                source="search",
            )
            assert response.status_code == 200

        assert response.json()["data"]["target_key"] == "/media/media-1"
        assert response.json()["data"]["title_snapshot"] == "Media 11"
        assert response.json()["data"]["use_count"] == 12

        with direct_db.session() as session:
            rows = (
                session.query(CommandPaletteUsage)
                .filter(CommandPaletteUsage.user_id == user_id)
                .all()
            )
            assert len(rows) == 1
            assert rows[0].query_normalized == "media"
            assert rows[0].visit_timestamps
            assert len(rows[0].visit_timestamps) == 10

    def test_post_rejects_absolute_href_target(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = _record_selection(
            auth_client,
            user_id,
            target_key="https://example.com/search",
            target_href="https://example.com/search",
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_post_rejects_href_on_non_href_target(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        response = _record_selection(
            auth_client,
            user_id,
            target_key="ask-ai",
            target_kind="prefill",
            target_href="/conversations/new",
            title_snapshot='Ask AI about "systems"',
            source="ai",
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestPaletteHistory:
    def test_get_returns_recent_destinations_deduped_by_target(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        first = _record_selection(
            auth_client,
            user_id,
            query="alpha",
            target_key="/media/media-1",
            target_href="/media/media-1?t_start_ms=1",
            title_snapshot="Old media title",
            source="search",
        )
        second = _record_selection(
            auth_client,
            user_id,
            query="beta",
            target_key="/media/media-1",
            target_href="/media/media-1#reader",
            title_snapshot="New media title",
            source="search",
        )
        third = _record_selection(
            auth_client,
            user_id,
            query="",
            target_key="nav-oracle",
            target_kind="action",
            target_href=None,
            title_snapshot="Open Oracle",
            source="oracle",
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert third.status_code == 200

        response = auth_client.get(
            "/me/palette-history",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["recent"] == [
            {
                "target_key": "/media/media-1",
                "target_kind": "href",
                "target_href": "/media/media-1",
                "title_snapshot": "New media title",
                "source": "search",
                "last_used_at": second.json()["data"]["last_used_at"],
            }
        ]

    def test_get_returns_query_aware_frecency_boosts_for_current_viewer(self, auth_client):
        viewer_id = create_test_user_id()
        other_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, other_id)

        for _ in range(2):
            response = _record_selection(
                auth_client,
                viewer_id,
                query="Apollo",
                target_key="/media/media-apollo",
                target_href="/media/media-apollo",
                title_snapshot="Apollo",
                source="search",
            )
            assert response.status_code == 200
        response = _record_selection(
            auth_client,
            viewer_id,
            query="",
            target_key="/media/media-library",
            target_href="/media/media-library",
            title_snapshot="Library",
            source="recent",
        )
        assert response.status_code == 200
        response = _record_selection(
            auth_client,
            other_id,
            query="Apollo",
            target_key="/media/media-other",
            target_href="/media/media-other",
            title_snapshot="Other",
            source="search",
        )
        assert response.status_code == 200

        response = auth_client.get(
            "/me/palette-history?query=apollo",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200
        boosts = response.json()["data"]["frecency_boosts"]
        assert boosts["/media/media-apollo"] > boosts["/media/media-library"]
        assert "/media/media-other" not in boosts

    def test_get_trims_recent_destinations_to_eight_rows(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        for idx in range(9):
            response = _record_selection(
                auth_client,
                user_id,
                target_key=f"/media/media-{idx}",
                target_href=f"/media/media-{idx}",
                title_snapshot=f"Media {idx}",
                source="search",
            )
            assert response.status_code == 200

        response = auth_client.get(
            "/me/palette-history",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        recent = response.json()["data"]["recent"]
        assert len(recent) == 8
        assert "/media/media-0" not in [row["target_key"] for row in recent]
        assert recent[0]["target_key"] == "/media/media-8"
