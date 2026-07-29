"""Integration tests for Nexus usage history and selection replay."""

from uuid import uuid4

import pytest

from nexus.db.models import NexusUsage, ResourceMutation
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id):
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200


def _record_selection(auth_client, user_id, **overrides):
    payload = {
        "client_mutation_id": f"nexus-selection-{uuid4()}",
        "query": "",
        "target_href": "/search",
        "label_snapshot": "Search",
        "source": "Static",
    }
    payload.update(overrides)
    return auth_client.post(
        "/me/nexus-selections",
        json=payload,
        headers=auth_headers(user_id),
    )


def _register_cleanup(direct_db: DirectSessionManager, user_id) -> None:
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    direct_db.register_cleanup("nexus_usages", "user_id", user_id)


class TestNexusSelections:
    @pytest.mark.parametrize("target_href", ["/lectern", "/stats", "/atlas"])
    def test_post_accepts_supported_internal_targets(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        target_href: str,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)

        response = _record_selection(
            auth_client,
            user_id,
            target_href=target_href,
            label_snapshot=target_href.removeprefix("/").title(),
        )

        assert response.status_code == 200
        assert set(response.json()["data"]) == {"use_count", "last_used_at"}
        assert response.json()["data"]["use_count"] == 1

    def test_exact_replay_returns_memo_without_incrementing_usage(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)
        client_mutation_id = "nexus-selection-exact-replay"
        request = {
            "client_mutation_id": client_mutation_id,
            "query": "Media",
            "target_href": "/media/media-1?t_start_ms=1200",
            "label_snapshot": "Media",
            "source": "Search",
        }

        first = _record_selection(auth_client, user_id, **request)
        replay = _record_selection(auth_client, user_id, **request)

        assert first.status_code == 200
        assert replay.status_code == 200
        assert replay.json() == first.json()
        with direct_db.session() as session:
            usages = session.query(NexusUsage).filter(NexusUsage.user_id == user_id).all()
            memos = (
                session.query(ResourceMutation)
                .filter(
                    ResourceMutation.user_id == user_id,
                    ResourceMutation.mutation_scope == "Nexus.SelectionRecord",
                )
                .all()
            )
        assert len(usages) == 1
        assert usages[0].target_href == "/media/media-1"
        assert usages[0].use_count == 1
        assert len(usages[0].visit_timestamps) == 1
        assert len(memos) == 1
        assert memos[0].client_mutation_id == client_mutation_id
        assert memos[0].changed_lanes == {}
        assert memos[0].response_json == first.json()["data"]

    def test_reusing_selection_id_with_different_full_request_conflicts(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)
        client_mutation_id = "nexus-selection-mismatch"

        first = _record_selection(
            auth_client,
            user_id,
            client_mutation_id=client_mutation_id,
            query="Apollo",
        )
        mismatch = _record_selection(
            auth_client,
            user_id,
            client_mutation_id=client_mutation_id,
            query="Apollo  ",
        )

        assert first.status_code == 200
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"
        with direct_db.session() as session:
            usage = session.query(NexusUsage).filter(NexusUsage.user_id == user_id).one()
        assert usage.use_count == 1

    def test_distinct_selection_ids_increment_one_query_href_aggregate_and_cap_visits(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)

        for index in range(12):
            response = _record_selection(
                auth_client,
                user_id,
                client_mutation_id=f"nexus-selection-{index}",
                query="Media",
                target_href="/media/media-1?t_start_ms=1200",
                label_snapshot=f"Media {index}",
                source="Search",
            )
            assert response.status_code == 200

        assert response.json()["data"]["use_count"] == 12
        with direct_db.session() as session:
            usage = session.query(NexusUsage).filter(NexusUsage.user_id == user_id).one()
        assert usage.query_normalized == "media"
        assert usage.target_href == "/media/media-1"
        assert usage.label_snapshot == "Media 11"
        assert len(usage.visit_timestamps) == 10

    def test_preserves_and_deterministically_canonicalizes_semantic_target_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)

        people = _record_selection(
            auth_client,
            user_id,
            client_mutation_id="nexus-selection-people",
            query="People",
            target_href="/search?kinds=people",
            label_snapshot="People",
            source="Static",
        )
        first_search = _record_selection(
            auth_client,
            user_id,
            client_mutation_id="nexus-selection-search-first",
            query="Ursula",
            target_href="/search?q=ursula%20le%20guin&kinds=people#results",
            label_snapshot="Ursula",
            source="Search",
        )
        second_search = _record_selection(
            auth_client,
            user_id,
            client_mutation_id="nexus-selection-search-second",
            query="Ursula",
            target_href="/search?kinds=people&q=ursula+le+guin#results",
            label_snapshot="Ursula K. Le Guin",
            source="Recent",
        )

        assert people.status_code == 200
        assert first_search.status_code == 200
        assert second_search.status_code == 200
        assert second_search.json()["data"]["use_count"] == 2
        with direct_db.session() as session:
            usages = (
                session.query(NexusUsage)
                .filter(NexusUsage.user_id == user_id)
                .order_by(NexusUsage.query_normalized)
                .all()
            )
        assert [
            (usage.query_normalized, usage.target_href, usage.use_count) for usage in usages
        ] == [
            ("people", "/search?kinds=people", 1),
            ("ursula", "/search?kinds=people&q=ursula+le+guin#results", 2),
        ]

    def test_strips_transient_media_query_and_fragment_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)

        query_locator = _record_selection(
            auth_client,
            user_id,
            client_mutation_id="nexus-selection-media-query",
            query="Media",
            target_href="/media/media-1?t_start_ms=1200",
            label_snapshot="Media",
            source="Search",
        )
        fragment_locator = _record_selection(
            auth_client,
            user_id,
            client_mutation_id="nexus-selection-media-fragment",
            query="Media",
            target_href="/media/media-1#reader",
            label_snapshot="Media revisited",
            source="Recent",
        )

        assert query_locator.status_code == 200
        assert fragment_locator.status_code == 200
        assert fragment_locator.json()["data"]["use_count"] == 2
        with direct_db.session() as session:
            usage = session.query(NexusUsage).filter(NexusUsage.user_id == user_id).one()
        assert usage.target_href == "/media/media-1"
        assert usage.use_count == 2

    def test_post_rejects_external_old_and_unknown_fields(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        external = _record_selection(
            auth_client,
            user_id,
            target_href="https://example.com/search",
        )
        old_source = _record_selection(auth_client, user_id, source="static")
        old_fields = _record_selection(
            auth_client,
            user_id,
            target_key="/search",
            target_kind="href",
            title_snapshot="Search",
        )

        assert external.status_code == 400
        assert external.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert old_source.status_code == 400
        assert old_fields.status_code == 400


class TestNexusHistory:
    def test_get_returns_five_recent_targets_deduped_by_canonical_href(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _register_cleanup(direct_db, user_id)

        first = _record_selection(
            auth_client,
            user_id,
            query="alpha",
            target_href="/media/media-1?t_start_ms=1",
            label_snapshot="Old media title",
            source="Search",
        )
        second = _record_selection(
            auth_client,
            user_id,
            query="beta",
            target_href="/media/media-1#reader",
            label_snapshot="New media title",
            source="Search",
        )
        assert first.status_code == 200
        assert second.status_code == 200
        for index in range(4):
            response = _record_selection(
                auth_client,
                user_id,
                target_href=f"/media/media-{index + 2}",
                label_snapshot=f"Media {index + 2}",
                source="Recent",
            )
            assert response.status_code == 200

        response = auth_client.get(
            "/me/nexus-history",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        recent = response.json()["data"]["recent"]
        assert len(recent) == 5
        assert [row["target_href"] for row in recent] == [
            "/media/media-5",
            "/media/media-4",
            "/media/media-3",
            "/media/media-2",
            "/media/media-1",
        ]
        assert recent[-1]["label_snapshot"] == "New media title"
        assert recent[-1]["last_used_at"] == second.json()["data"]["last_used_at"]

    def test_get_aggregates_then_bounds_query_aware_frecency_by_href(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        viewer_id = create_test_user_id()
        other_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, other_id)
        _register_cleanup(direct_db, viewer_id)
        _register_cleanup(direct_db, other_id)

        for _ in range(2):
            response = _record_selection(
                auth_client,
                viewer_id,
                query="Apollo",
                target_href="/media/media-apollo",
                label_snapshot="Apollo",
                source="Search",
            )
            assert response.status_code == 200
        response = _record_selection(
            auth_client,
            viewer_id,
            query="",
            target_href="/media/media-apollo",
            label_snapshot="Apollo recent",
            source="Recent",
        )
        assert response.status_code == 200
        response = _record_selection(
            auth_client,
            viewer_id,
            query="",
            target_href="/media/media-library",
            label_snapshot="Library",
            source="Recent",
        )
        assert response.status_code == 200
        response = _record_selection(
            auth_client,
            other_id,
            query="Apollo",
            target_href="/media/media-other",
            label_snapshot="Other",
            source="Search",
        )
        assert response.status_code == 200

        response = auth_client.get(
            "/me/nexus-history?query=apollo",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200
        frecency = response.json()["data"]["frecency_by_href"]
        assert frecency == {
            "/media/media-apollo": 0.701493,
            "/media/media-library": 0.259259,
        }
        assert all(0 <= value < 1 for value in frecency.values())

    def test_old_palette_routes_do_not_exist(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        assert (
            auth_client.get(
                "/me/palette-history",
                headers=auth_headers(user_id),
            ).status_code
            == 404
        )
        assert (
            auth_client.post(
                "/me/palette-selections",
                json={},
                headers=auth_headers(user_id),
            ).status_code
            == 404
        )
