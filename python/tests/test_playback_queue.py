"""Integration tests for playback queue APIs."""

from uuid import UUID, uuid4

import pytest

from nexus.db.models import Media, MediaKind, Podcast, PodcastEpisode, ProcessingStatus
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user_default_library(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"Expected 200 from /me bootstrap, got {response.status_code}: {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


def _create_podcast_episode_media(
    direct_db: DirectSessionManager,
    *,
    title: str,
    podcast_title: str,
    duration_seconds: int,
) -> UUID:
    media_id = uuid4()
    podcast_id = uuid4()
    provider_podcast_id = f"provider-{podcast_id}"
    provider_episode_id = f"episode-{media_id}"
    now_iso = "2026-03-22T00:00:00Z"
    audio_url = f"https://cdn.example.com/{media_id}.mp3"

    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=provider_podcast_id,
                title=podcast_title,
                author="Queue Test",
                feed_url=f"https://feeds.example.com/{provider_podcast_id}.xml",
                website_url=f"https://example.com/{provider_podcast_id}",
                image_url=None,
                description=None,
            )
        )
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=title,
                canonical_source_url=f"https://example.com/{provider_episode_id}",
                processing_status=ProcessingStatus.ready_for_reading,
                external_playback_url=audio_url,
                provider="podcast_index",
                provider_id=provider_episode_id,
            )
        )
        session.add(
            PodcastEpisode(
                media_id=media_id,
                podcast_id=podcast_id,
                provider_episode_id=provider_episode_id,
                guid=f"guid-{provider_episode_id}",
                fallback_identity=f"fallback-{provider_episode_id}",
                published_at=now_iso,
                duration_seconds=duration_seconds,
            )
        )
        session.commit()

    direct_db.register_cleanup("playback_queue_items", "media_id", media_id)
    direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
    direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    return media_id


def _add_media_to_library(auth_client, user_id: UUID, library_id: UUID, media_id: UUID) -> None:
    response = auth_client.post(
        f"/libraries/{library_id}/media",
        headers=auth_headers(user_id),
        json={"media_id": str(media_id)},
    )
    assert response.status_code == 201, (
        f"Expected 201 adding media to library, got {response.status_code}: {response.text}"
    )


def _queue_media(
    auth_client,
    user_id: UUID,
    media_ids: list[UUID],
    *,
    insert_position: str,
    current_media_id: UUID | None = None,
) -> dict:
    payload: dict[str, object] = {
        "media_ids": [str(media_id) for media_id in media_ids],
        "insert_position": insert_position,
    }
    if current_media_id is not None:
        payload["current_media_id"] = str(current_media_id)
    response = auth_client.post(
        "/playback/queue/items",
        headers=auth_headers(user_id),
        json=payload,
    )
    assert response.status_code == 200, (
        f"Expected 200 queue add response, got {response.status_code}: {response.text}"
    )
    return response.json()


class TestPlaybackQueueApi:
    def test_post_items_supports_next_last_and_ignores_duplicates(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap_user_default_library(auth_client, user_id)

        media_a = _create_podcast_episode_media(
            direct_db,
            title="Episode A",
            podcast_title="Queue Podcast",
            duration_seconds=60,
        )
        media_b = _create_podcast_episode_media(
            direct_db,
            title="Episode B",
            podcast_title="Queue Podcast",
            duration_seconds=70,
        )
        media_c = _create_podcast_episode_media(
            direct_db,
            title="Episode C",
            podcast_title="Queue Podcast",
            duration_seconds=80,
        )
        for media_id in (media_a, media_b, media_c):
            _add_media_to_library(auth_client, user_id, library_id, media_id)

        _queue_media(auth_client, user_id, [media_a], insert_position="last")
        _queue_media(auth_client, user_id, [media_b], insert_position="last")
        queue_after_next = _queue_media(
            auth_client,
            user_id,
            [media_c],
            insert_position="next",
            current_media_id=media_a,
        )
        duplicate_attempt = _queue_media(auth_client, user_id, [media_b], insert_position="last")

        assert [row["media_id"] for row in queue_after_next["data"]] == [
            str(media_a),
            str(media_c),
            str(media_b),
        ], f"Expected next insert order A->C->B, got: {queue_after_next}"
        assert [row["media_id"] for row in duplicate_attempt["data"]] == [
            str(media_a),
            str(media_c),
            str(media_b),
        ], f"Duplicate add should be idempotent with no extra row; got {duplicate_attempt['data']}"

        put_state = auth_client.put(
            f"/media/{media_a}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 5_000, "playback_speed": 1.25},
        )
        assert put_state.status_code == 204

        queue_response = auth_client.get("/playback/queue", headers=auth_headers(user_id))
        assert queue_response.status_code == 200, (
            f"Expected 200 from queue read, got {queue_response.status_code}: {queue_response.text}"
        )
        first_item = queue_response.json()["data"][0]
        assert first_item["title"] == "Episode A"
        assert first_item["podcast_title"] == "Queue Podcast"
        assert first_item["duration_seconds"] == 60
        assert first_item["listening_state"]["position_ms"] == 5_000

    def test_put_order_requires_exact_item_set_and_reorders_atomically(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap_user_default_library(auth_client, user_id)

        media_ids = [
            _create_podcast_episode_media(
                direct_db,
                title=f"Episode {label}",
                podcast_title="Atomic Queue Podcast",
                duration_seconds=60,
            )
            for label in ("A", "B", "C")
        ]
        for media_id in media_ids:
            _add_media_to_library(auth_client, user_id, library_id, media_id)
        queue = _queue_media(auth_client, user_id, media_ids, insert_position="last")
        item_ids = [UUID(row["item_id"]) for row in queue["data"]]

        missing_one = auth_client.put(
            "/playback/queue/order",
            headers=auth_headers(user_id),
            json={"item_ids": [str(item_ids[0]), str(item_ids[1])]},
        )
        assert missing_one.status_code == 400, (
            "Queue reorder must reject missing IDs to avoid silent item loss."
        )

        with_extra = auth_client.put(
            "/playback/queue/order",
            headers=auth_headers(user_id),
            json={"item_ids": [str(item_ids[0]), str(item_ids[1]), str(item_ids[2]), str(uuid4())]},
        )
        assert with_extra.status_code == 400, (
            "Queue reorder must reject extra IDs to avoid cross-queue corruption."
        )

        unchanged = auth_client.get("/playback/queue", headers=auth_headers(user_id))
        assert [row["item_id"] for row in unchanged.json()["data"]] == [str(i) for i in item_ids], (
            "Invalid reorder request must leave queue order unchanged."
        )

        reordered = auth_client.put(
            "/playback/queue/order",
            headers=auth_headers(user_id),
            json={"item_ids": [str(item_ids[2]), str(item_ids[0]), str(item_ids[1])]},
        )
        assert reordered.status_code == 200, (
            f"Expected successful reorder, got {reordered.status_code}: {reordered.text}"
        )
        assert [row["media_id"] for row in reordered.json()["data"]] == [
            str(media_ids[2]),
            str(media_ids[0]),
            str(media_ids[1]),
        ]

    def test_delete_masks_cross_user_queue_item_and_shifts_positions(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_user_id = create_test_user_id()
        owner_library_id = _bootstrap_user_default_library(auth_client, owner_user_id)
        other_user_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, other_user_id)

        media_a = _create_podcast_episode_media(
            direct_db,
            title="Delete Episode A",
            podcast_title="Delete Podcast",
            duration_seconds=50,
        )
        media_b = _create_podcast_episode_media(
            direct_db,
            title="Delete Episode B",
            podcast_title="Delete Podcast",
            duration_seconds=55,
        )
        _add_media_to_library(auth_client, owner_user_id, owner_library_id, media_a)
        _add_media_to_library(auth_client, owner_user_id, owner_library_id, media_b)

        queue = _queue_media(auth_client, owner_user_id, [media_a, media_b], insert_position="last")
        first_item_id = queue["data"][0]["item_id"]
        second_item_id = queue["data"][1]["item_id"]

        delete_owner = auth_client.delete(
            f"/playback/queue/items/{first_item_id}",
            headers=auth_headers(owner_user_id),
        )
        assert delete_owner.status_code == 200, (
            f"Expected owner delete success, got {delete_owner.status_code}: {delete_owner.text}"
        )
        owner_rows = delete_owner.json()["data"]
        assert len(owner_rows) == 1
        assert owner_rows[0]["item_id"] == second_item_id
        assert owner_rows[0]["position"] == 0

        delete_other = auth_client.delete(
            f"/playback/queue/items/{second_item_id}",
            headers=auth_headers(other_user_id),
        )
        assert delete_other.status_code == 404, (
            "Queue item deletion by non-owner must be masked as not found."
        )

    def test_clear_removes_all_queue_rows(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap_user_default_library(auth_client, user_id)

        media_ids = [
            _create_podcast_episode_media(
                direct_db,
                title="Clear Episode A",
                podcast_title="Clear Podcast",
                duration_seconds=40,
            ),
            _create_podcast_episode_media(
                direct_db,
                title="Clear Episode B",
                podcast_title="Clear Podcast",
                duration_seconds=45,
            ),
        ]
        for media_id in media_ids:
            _add_media_to_library(auth_client, user_id, library_id, media_id)
        _queue_media(auth_client, user_id, media_ids, insert_position="last")

        clear_response = auth_client.post("/playback/queue/clear", headers=auth_headers(user_id))
        assert clear_response.status_code == 200, (
            f"Expected 200 from clear, got {clear_response.status_code}: {clear_response.text}"
        )
        assert clear_response.json()["data"] == []

        queue_after_clear = auth_client.get("/playback/queue", headers=auth_headers(user_id))
        assert queue_after_clear.status_code == 200
        assert queue_after_clear.json()["data"] == []

    def test_get_next_returns_following_item_or_null(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap_user_default_library(auth_client, user_id)

        media_a = _create_podcast_episode_media(
            direct_db,
            title="Next Episode A",
            podcast_title="Next Podcast",
            duration_seconds=30,
        )
        media_b = _create_podcast_episode_media(
            direct_db,
            title="Next Episode B",
            podcast_title="Next Podcast",
            duration_seconds=35,
        )
        media_c = _create_podcast_episode_media(
            direct_db,
            title="Next Episode C",
            podcast_title="Next Podcast",
            duration_seconds=40,
        )
        for media_id in (media_a, media_b, media_c):
            _add_media_to_library(auth_client, user_id, library_id, media_id)
        _queue_media(auth_client, user_id, [media_a, media_b, media_c], insert_position="last")

        next_from_a = auth_client.get(
            f"/playback/queue/next?current_media_id={media_a}",
            headers=auth_headers(user_id),
        )
        assert next_from_a.status_code == 200
        assert next_from_a.json()["data"]["media_id"] == str(media_b)

        next_from_c = auth_client.get(
            f"/playback/queue/next?current_media_id={media_c}",
            headers=auth_headers(user_id),
        )
        assert next_from_c.status_code == 200
        assert next_from_c.json()["data"] is None

    def test_queue_rows_are_scoped_per_user(self, auth_client, direct_db: DirectSessionManager):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        library_a = _bootstrap_user_default_library(auth_client, user_a)
        library_b = _bootstrap_user_default_library(auth_client, user_b)

        media_a = _create_podcast_episode_media(
            direct_db,
            title="Scoped Episode A",
            podcast_title="Scoped Podcast A",
            duration_seconds=20,
        )
        media_b = _create_podcast_episode_media(
            direct_db,
            title="Scoped Episode B",
            podcast_title="Scoped Podcast B",
            duration_seconds=25,
        )
        _add_media_to_library(auth_client, user_a, library_a, media_a)
        _add_media_to_library(auth_client, user_b, library_b, media_b)
        _queue_media(auth_client, user_a, [media_a], insert_position="last")
        _queue_media(auth_client, user_b, [media_b], insert_position="last")

        queue_a = auth_client.get("/playback/queue", headers=auth_headers(user_a))
        queue_b = auth_client.get("/playback/queue", headers=auth_headers(user_b))

        assert queue_a.status_code == 200
        assert queue_b.status_code == 200
        assert [row["media_id"] for row in queue_a.json()["data"]] == [str(media_a)]
        assert [row["media_id"] for row in queue_b.json()["data"]] == [str(media_b)]
