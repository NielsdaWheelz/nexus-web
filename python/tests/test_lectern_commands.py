"""Integration tests for the Lectern command port (spec §5.1).

Assert through the API: GET /lectern and POST /lectern/commands. Media is seeded
through ``direct_db`` and made readable by adding it to the viewer's default
library; commands run through the real service facade (fresh session + one
serializable transaction + replay).
"""

from uuid import UUID, uuid4

import pytest

from nexus.db.models import (
    Media,
    MediaKind,
    MediaTeardownIntent,
    Podcast,
    PodcastEpisode,
    ProcessingStatus,
    UserMediaDeletion,
)
from nexus.ids import new_uuid7
from nexus.services.consumption import _lectern_store
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, f"/me bootstrap failed: {response.text}"
    return UUID(response.json()["data"]["default_library_id"])


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    # Children registered last so LIFO cleanup deletes them before the media row.
    for table in (
        "podcast_episodes",
        "consumption_queue_items",
        "consumption_overrides",
        "podcast_listening_states",
        "reading_sessions",
        "user_media_deletions",
        "media_teardown_intents",
        "library_entries",
    ):
        direct_db.register_cleanup(table, "media_id", media_id)


def _create_web_article(direct_db: DirectSessionManager, *, title: str = "An Article") -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=title,
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    return media_id


def _create_video(direct_db: DirectSessionManager, *, title: str = "A Video") -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.video.value,
                title=title,
                canonical_source_url=f"https://youtube.com/watch?v={media_id.hex[:11]}",
                external_playback_url=f"https://youtube.com/watch?v={media_id.hex[:11]}",
                provider="youtube",
                provider_id=media_id.hex[:11],
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    return media_id


def _create_podcast_episode(
    direct_db: DirectSessionManager,
    *,
    title: str = "An Episode",
    podcast_title: str = "A Show",
    image_url: str | None = "https://img.example.com/show.jpg",
    duration_seconds: int | None = 600,
    with_audio: bool = True,
) -> UUID:
    media_id = uuid4()
    podcast_id = uuid4()
    provider_episode_id = f"episode-{media_id}"
    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"pp-{podcast_id}",
                title=podcast_title,
                feed_url=f"https://feeds.example.com/{podcast_id}.xml",
                image_url=image_url,
            )
        )
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=title,
                canonical_source_url=f"https://example.com/{provider_episode_id}",
                external_playback_url=(
                    f"https://cdn.example.com/{media_id}.mp3" if with_audio else None
                ),
                provider="podcast_index",
                provider_id=provider_episode_id,
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.add(
            PodcastEpisode(
                media_id=media_id,
                podcast_id=podcast_id,
                provider_episode_id=provider_episode_id,
                guid=f"guid-{provider_episode_id}",
                fallback_identity=f"fallback-{provider_episode_id}",
                published_at="2026-03-22T00:00:00Z",
                duration_seconds=duration_seconds,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    return media_id


def _add_to_library(auth_client, user_id: UUID, library_id: UUID, media_id: UUID) -> None:
    response = auth_client.post(
        f"/libraries/{library_id}/media",
        headers=auth_headers(user_id),
        json={"media_id": str(media_id)},
    )
    assert response.status_code == 201, f"add media to library failed: {response.text}"


def _hide_media(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID) -> None:
    with direct_db.session() as session:
        session.add(UserMediaDeletion(user_id=user_id, media_id=media_id))
        session.commit()


def _unhide_media(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID) -> None:
    with direct_db.session() as session:
        from sqlalchemy import text

        session.execute(
            text("DELETE FROM user_media_deletions WHERE user_id = :u AND media_id = :m"),
            {"u": user_id, "m": media_id},
        )
        session.commit()


def _place(auth_client, user_id, media_ids, placement, *, cmid: str | None = None):
    return auth_client.post(
        "/lectern/commands",
        headers=auth_headers(user_id),
        json={
            "kind": "PlaceItems",
            "clientMutationId": cmid or str(uuid4()),
            "mediaIds": [str(m) for m in media_ids],
            "placement": placement,
        },
    )


def _get_lectern(auth_client, user_id) -> list[dict]:
    response = auth_client.get("/lectern", headers=auth_headers(user_id))
    assert response.status_code == 200, f"GET /lectern failed: {response.text}"
    return response.json()["data"]["items"]


def _media_order(items: list[dict]) -> list[str]:
    return [item["mediaId"] for item in items]


class TestLecternSnapshot:
    def test_snapshot_shape_and_activation_derivation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Read Me")
        video = _create_video(direct_db, title="Watch Me")
        episode = _create_podcast_episode(direct_db, title="Hear Me")
        for media_id in (article, video, episode):
            _add_to_library(auth_client, user_id, library_id, media_id)

        placed = _place(auth_client, user_id, [article, video, episode], {"kind": "Last"})
        assert placed.status_code == 200, placed.text
        items = placed.json()["data"]["lectern"]["items"]
        by_media = {item["mediaId"]: item for item in items}

        article_item = by_media[str(article)]
        assert article_item["activation"] == {"kind": "Readable"}, article_item
        assert article_item["subtitle"] == {"kind": "Absent"}, "article has no subtitle"
        assert article_item["consumption"]["state"] == "Unread"
        assert article_item["consumption"]["progress"] == {"kind": "Absent"}
        assert article_item["href"] == f"/media/{article}"

        video_item = by_media[str(video)]
        assert video_item["activation"] == {"kind": "OpenPane"}, (
            f"video must never derive FooterAudio: {video_item['activation']}"
        )

        episode_item = by_media[str(episode)]
        activation = episode_item["activation"]
        assert activation["kind"] == "FooterAudio", activation
        assert activation["positionMs"] == 0
        assert activation["writeRevision"] == 0
        assert activation["resetEpoch"] == 0
        assert activation["durationMs"] == {"kind": "Present", "value": 600_000}, activation
        assert activation["artworkUrl"] == {
            "kind": "Present",
            "value": "https://img.example.com/show.jpg",
        }
        assert activation["chapters"] == []
        assert episode_item["subtitle"] == {"kind": "Present", "value": "A Show"}


class TestPlaceItems:
    def test_first_last_after_and_move_preserves_item_id(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        c = _create_web_article(direct_db, title="C")
        for media_id in (a, b, c):
            _add_to_library(auth_client, user_id, library_id, media_id)

        _place(auth_client, user_id, [a], {"kind": "Last"})
        _place(auth_client, user_id, [b], {"kind": "Last"})
        first = _place(auth_client, user_id, [c], {"kind": "First"})
        assert _media_order(first.json()["data"]["lectern"]["items"]) == [
            str(c),
            str(a),
            str(b),
        ]

        items = _get_lectern(auth_client, user_id)
        by_media = {item["mediaId"]: item["itemId"] for item in items}
        a_item_id = by_media[str(a)]

        # Move A after B without changing its itemId.
        b_item_id = by_media[str(b)]
        moved = _place(auth_client, user_id, [a], {"kind": "After", "itemId": b_item_id})
        moved_items = moved.json()["data"]["lectern"]["items"]
        assert _media_order(moved_items) == [str(c), str(b), str(a)]
        moved_a = next(i for i in moved_items if i["mediaId"] == str(a))
        assert moved_a["itemId"] == a_item_id, "move must preserve itemId"

    def test_after_anchor_validation(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        for media_id in (a, b):
            _add_to_library(auth_client, user_id, library_id, media_id)
        _place(auth_client, user_id, [a, b], {"kind": "Last"})
        items = _get_lectern(auth_client, user_id)
        a_item_id = next(i["itemId"] for i in items if i["mediaId"] == str(a))

        # Anchor is part of the moved block -> 400.
        in_block = _place(auth_client, user_id, [a], {"kind": "After", "itemId": a_item_id})
        assert in_block.status_code == 400, in_block.text
        assert in_block.json()["error"]["code"] == "E_INVALID_REQUEST"

        # Absent anchor -> 404.
        absent_anchor = _place(auth_client, user_id, [a], {"kind": "After", "itemId": str(uuid4())})
        assert absent_anchor.status_code == 404, absent_anchor.text
        assert absent_anchor.json()["error"]["code"] == "E_NOT_FOUND"

    def test_place_dedupes_input(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        _add_to_library(auth_client, user_id, library_id, a)
        placed = _place(auth_client, user_id, [a, a, a], {"kind": "Last"})
        assert placed.status_code == 200, placed.text
        assert _media_order(placed.json()["data"]["lectern"]["items"]) == [str(a)]
        assert len(placed.json()["data"]["outcome"]["itemIds"]) == 1

    def test_cross_user_media_is_not_found(self, auth_client, direct_db: DirectSessionManager):
        owner = create_test_user_id()
        _bootstrap(auth_client, owner)
        other = create_test_user_id()
        other_lib = _bootstrap(auth_client, other)
        other_media = _create_web_article(direct_db, title="Other's")
        _add_to_library(auth_client, other, other_lib, other_media)

        placed = _place(auth_client, owner, [other_media], {"kind": "Last"})
        assert placed.status_code == 404, placed.text
        assert placed.json()["error"]["code"] == "E_NOT_FOUND"

    def test_teardown_intent_target_is_media_deleting(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_web_article(direct_db, title="Deleting")
        _add_to_library(auth_client, user_id, library_id, media_id)
        with direct_db.session() as session:
            session.add(MediaTeardownIntent(id=new_uuid7(), media_id=media_id))
            session.commit()

        placed = _place(auth_client, user_id, [media_id], {"kind": "Last"})
        assert placed.status_code == 409, placed.text
        assert placed.json()["error"]["code"] == "E_MEDIA_DELETING"

    def test_limit_exceeded_returns_e_limit(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        # Prefer a lowered cap over inserting 2,000 rows; the store reads the
        # module-level constant at call time.
        monkeypatch.setattr(_lectern_store, "LECTERN_MAX_ITEMS", 2)
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        c = _create_web_article(direct_db, title="C")
        for media_id in (a, b, c):
            _add_to_library(auth_client, user_id, library_id, media_id)

        ok = _place(auth_client, user_id, [a, b], {"kind": "Last"})
        assert ok.status_code == 200, ok.text
        over = _place(auth_client, user_id, [c], {"kind": "Last"})
        assert over.status_code == 409, over.text
        assert over.json()["error"]["code"] == "E_LIMIT"
        # Nothing written: the third media never joined the Lectern.
        assert _media_order(_get_lectern(auth_client, user_id)) == [str(a), str(b)]


class TestSetOrder:
    def test_exact_permutation_and_hidden_slot_retention(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        c = _create_web_article(direct_db, title="C")
        for media_id in (a, b, c):
            _add_to_library(auth_client, user_id, library_id, media_id)
        _place(auth_client, user_id, [a, b, c], {"kind": "Last"})
        items = _get_lectern(auth_client, user_id)
        item_by_media = {i["mediaId"]: i["itemId"] for i in items}

        # Hide B (a viewer hide marker); it keeps a latent slot between A and C.
        _hide_media(direct_db, user_id, b)
        visible = _get_lectern(auth_client, user_id)
        assert _media_order(visible) == [str(a), str(c)], "hidden row is excluded"

        # SetOrder over the exact visible permutation reverses A and C.
        reordered = auth_client.post(
            "/lectern/commands",
            headers=auth_headers(user_id),
            json={
                "kind": "SetOrder",
                "clientMutationId": str(uuid4()),
                "itemIds": [item_by_media[str(c)], item_by_media[str(a)]],
            },
        )
        assert reordered.status_code == 200, reordered.text
        assert reordered.json()["data"]["outcome"] == {"kind": "Ordered"}
        assert _media_order(reordered.json()["data"]["lectern"]["items"]) == [str(c), str(a)]

        # Un-hiding B proves it kept its latent slot between the visible rows.
        _unhide_media(direct_db, user_id, b)
        assert _media_order(_get_lectern(auth_client, user_id)) == [str(c), str(b), str(a)]

    def test_rejects_wrong_visible_set(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        for media_id in (a, b):
            _add_to_library(auth_client, user_id, library_id, media_id)
        _place(auth_client, user_id, [a, b], {"kind": "Last"})
        items = _get_lectern(auth_client, user_id)
        one_item = items[0]["itemId"]

        partial = auth_client.post(
            "/lectern/commands",
            headers=auth_headers(user_id),
            json={"kind": "SetOrder", "clientMutationId": str(uuid4()), "itemIds": [one_item]},
        )
        assert partial.status_code == 400, partial.text
        assert partial.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestRemoveItem:
    def test_remove_item(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        for media_id in (a, b):
            _add_to_library(auth_client, user_id, library_id, media_id)
        _place(auth_client, user_id, [a, b], {"kind": "Last"})
        items = _get_lectern(auth_client, user_id)
        a_item_id = next(i["itemId"] for i in items if i["mediaId"] == str(a))

        removed = auth_client.post(
            "/lectern/commands",
            headers=auth_headers(user_id),
            json={"kind": "RemoveItem", "clientMutationId": str(uuid4()), "itemId": a_item_id},
        )
        assert removed.status_code == 200, removed.text
        assert removed.json()["data"]["outcome"] == {"kind": "Removed", "itemId": a_item_id}
        assert _media_order(removed.json()["data"]["lectern"]["items"]) == [str(b)]


class TestReplay:
    def test_same_key_returns_memoized_outcome_with_fresh_snapshot(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        for media_id in (a, b):
            _add_to_library(auth_client, user_id, library_id, media_id)

        cmid = str(uuid4())
        first = _place(auth_client, user_id, [a], {"kind": "Last"}, cmid=cmid)
        assert first.status_code == 200, first.text
        first_item_ids = first.json()["data"]["outcome"]["itemIds"]

        # A background addition arrives between the two attempts.
        _place(auth_client, user_id, [b], {"kind": "Last"})

        replay = _place(auth_client, user_id, [a], {"kind": "Last"}, cmid=cmid)
        assert replay.status_code == 200, replay.text
        # Same memoized outcome...
        assert replay.json()["data"]["outcome"]["itemIds"] == first_item_ids
        # ...but a FRESH snapshot that still contains the intervening addition.
        assert _media_order(replay.json()["data"]["lectern"]["items"]) == [str(a), str(b)]

    def test_same_key_different_payload_conflicts(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        a = _create_web_article(direct_db, title="A")
        b = _create_web_article(direct_db, title="B")
        for media_id in (a, b):
            _add_to_library(auth_client, user_id, library_id, media_id)

        cmid = str(uuid4())
        first = _place(auth_client, user_id, [a], {"kind": "Last"}, cmid=cmid)
        assert first.status_code == 200, first.text
        mismatch = _place(auth_client, user_id, [b], {"kind": "Last"}, cmid=cmid)
        assert mismatch.status_code == 409, mismatch.text
        assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"
