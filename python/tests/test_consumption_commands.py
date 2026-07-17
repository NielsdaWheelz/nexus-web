"""Integration tests for the consumption command port (spec §5.2).

Asserts through POST /consumption/commands, POST /lectern/commands, and the
listening heartbeat. Terminal state is observed by re-placing a finished media
and reading its projected consumption state.
"""

from uuid import UUID, uuid4

import pytest

from nexus.db.models import (
    Media,
    MediaKind,
    Podcast,
    PodcastEpisode,
    ProcessingStatus,
)
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, f"/me bootstrap failed: {response.text}"
    return UUID(response.json()["data"]["default_library_id"])


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    for table in (
        "podcast_episodes",
        "consumption_queue_items",
        "consumption_overrides",
        "podcast_listening_states",
        "reading_sessions",
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


def _create_podcast_episode(direct_db: DirectSessionManager, *, title: str = "An Episode") -> UUID:
    media_id = uuid4()
    podcast_id = uuid4()
    provider_episode_id = f"episode-{media_id}"
    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"pp-{podcast_id}",
                title="A Show",
                feed_url=f"https://feeds.example.com/{podcast_id}.xml",
                image_url="https://img.example.com/show.jpg",
            )
        )
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=title,
                canonical_source_url=f"https://example.com/{provider_episode_id}",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
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
                duration_seconds=600,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    return media_id


def _add_to_library(direct_db: DirectSessionManager, library_id: UUID, media_id: UUID) -> None:
    """Seed a physical library_entries row directly, bypassing the REST filing
    endpoint's membership-reachability gate. Production ingest always auto-files
    freshly-created media into the creator's default library
    (ensure_media_in_default_library); this mirrors that reachability for
    fixture media created via a bare INSERT/factory rather than real ingest."""
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _place(auth_client, user_id, media_ids, placement="Last"):
    response = auth_client.post(
        "/lectern/commands",
        headers=auth_headers(user_id),
        json={
            "kind": "PlaceItems",
            "clientMutationId": str(uuid4()),
            "mediaIds": [str(m) for m in media_ids],
            "placement": {"kind": placement},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["lectern"]["items"]


def _consumption(auth_client, user_id, payload):
    return auth_client.post("/consumption/commands", headers=auth_headers(user_id), json=payload)


def _heartbeat(
    auth_client,
    user_id,
    media_id,
    *,
    position_ms,
    expected_write_revision,
    expected_reset_epoch,
    duration_ms=600_000,
):
    return auth_client.put(
        f"/media/{media_id}/listening-state",
        headers=auth_headers(user_id),
        json={
            "positionMs": position_ms,
            "durationMs": {"kind": "Present", "value": duration_ms},
            "playbackSpeed": 1.0,
            "dwellMsDelta": 0,
            "deviceId": "device-1",
            "expectedWriteRevision": expected_write_revision,
            "expectedResetEpoch": expected_reset_epoch,
            "heartbeatGeneration": str(uuid4()),
            "heartbeatSequence": 1,
        },
    )


def _item_by_media(items, media_id) -> dict:
    return next(item for item in items if item["mediaId"] == str(media_id))


class TestFinishLecternItem:
    def test_suffix_next_selection_by_capability(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep1 = _create_podcast_episode(direct_db, title="Ep1")
        article = _create_web_article(direct_db, title="Interlude")
        ep2 = _create_podcast_episode(direct_db, title="Ep2")
        for media_id in (ep1, article, ep2):
            _add_to_library(direct_db, library_id, media_id)
        items = _place(auth_client, user_id, [ep1, article, ep2])
        ep1_item = _item_by_media(items, ep1)["itemId"]
        ep2_item = _item_by_media(items, ep2)["itemId"]

        result = _consumption(
            auth_client,
            user_id,
            {
                "kind": "FinishLecternItem",
                "clientMutationId": str(uuid4()),
                "mediaId": str(ep1),
                "itemId": ep1_item,
                "nextCapability": "FooterAudio",
            },
        )
        assert result.status_code == 200, result.text
        data = result.json()["data"]
        assert data["outcome"]["kind"] == "Removed"
        assert data["outcome"]["itemId"] == ep1_item
        # FooterAudio suffix selection skips the readable article and lands on ep2.
        assert data["outcome"]["nextItemId"] == {"kind": "Present", "value": ep2_item}
        assert data["nextItem"]["kind"] == "Present"
        assert data["nextItem"]["value"]["mediaId"] == str(ep2)
        assert [i["mediaId"] for i in data["lectern"]["items"]] == [str(article), str(ep2)]

    def test_readable_capability_selects_article(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep1 = _create_podcast_episode(direct_db, title="Ep1")
        article = _create_web_article(direct_db, title="Interlude")
        for media_id in (ep1, article):
            _add_to_library(direct_db, library_id, media_id)
        items = _place(auth_client, user_id, [ep1, article])
        ep1_item = _item_by_media(items, ep1)["itemId"]
        article_item = _item_by_media(items, article)["itemId"]

        result = _consumption(
            auth_client,
            user_id,
            {
                "kind": "FinishLecternItem",
                "clientMutationId": str(uuid4()),
                "mediaId": str(ep1),
                "itemId": ep1_item,
                "nextCapability": "Readable",
            },
        )
        assert result.status_code == 200, result.text
        assert result.json()["data"]["outcome"]["nextItemId"] == {
            "kind": "Present",
            "value": article_item,
        }

    def test_stop_and_no_wrap_return_absent_but_still_finish(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep1 = _create_podcast_episode(direct_db, title="Ep1")
        ep2 = _create_podcast_episode(direct_db, title="Ep2")
        for media_id in (ep1, ep2):
            _add_to_library(direct_db, library_id, media_id)
        items = _place(auth_client, user_id, [ep1, ep2])
        ep2_item = _item_by_media(items, ep2)["itemId"]

        # Finishing the last audio with FooterAudio has no suffix match: Absent,
        # no wrap back to ep1 — but the terminal write still happens.
        result = _consumption(
            auth_client,
            user_id,
            {
                "kind": "FinishLecternItem",
                "clientMutationId": str(uuid4()),
                "mediaId": str(ep2),
                "itemId": ep2_item,
                "nextCapability": "FooterAudio",
            },
        )
        assert result.status_code == 200, result.text
        assert result.json()["data"]["outcome"]["nextItemId"] == {"kind": "Absent"}
        assert result.json()["data"]["nextItem"] == {"kind": "Absent"}

        # Capability filter never blocked the write: re-placing ep2 shows Finished.
        replaced = _place(auth_client, user_id, [ep2])
        assert _item_by_media(replaced, ep2)["consumption"]["state"] == "Finished"

    def test_exact_agreement_404s(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep1 = _create_podcast_episode(direct_db, title="Ep1")
        other = _create_podcast_episode(direct_db, title="Other")
        for media_id in (ep1, other):
            _add_to_library(direct_db, library_id, media_id)
        items = _place(auth_client, user_id, [ep1])
        ep1_item = _item_by_media(items, ep1)["itemId"]

        # Correct item, wrong media -> 404 (exact agreement).
        wrong_media = _consumption(
            auth_client,
            user_id,
            {
                "kind": "FinishLecternItem",
                "clientMutationId": str(uuid4()),
                "mediaId": str(other),
                "itemId": ep1_item,
                "nextCapability": "Stop",
            },
        )
        assert wrong_media.status_code == 404, wrong_media.text
        assert wrong_media.json()["error"]["code"] == "E_NOT_FOUND"

        # Unknown item -> 404.
        unknown = _consumption(
            auth_client,
            user_id,
            {
                "kind": "FinishLecternItem",
                "clientMutationId": str(uuid4()),
                "mediaId": str(ep1),
                "itemId": str(uuid4()),
                "nextCapability": "Stop",
            },
        )
        assert unknown.status_code == 404, unknown.text

    def test_replay_reresolves_next_and_snapshot(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep1 = _create_podcast_episode(direct_db, title="Ep1")
        ep2 = _create_podcast_episode(direct_db, title="Ep2")
        for media_id in (ep1, ep2):
            _add_to_library(direct_db, library_id, media_id)
        items = _place(auth_client, user_id, [ep1, ep2])
        ep1_item = _item_by_media(items, ep1)["itemId"]
        ep2_item = _item_by_media(items, ep2)["itemId"]

        cmid = str(uuid4())
        body = {
            "kind": "FinishLecternItem",
            "clientMutationId": cmid,
            "mediaId": str(ep1),
            "itemId": ep1_item,
            "nextCapability": "FooterAudio",
        }
        first = _consumption(auth_client, user_id, body)
        assert first.status_code == 200, first.text
        assert first.json()["data"]["outcome"]["nextItemId"] == {
            "kind": "Present",
            "value": ep2_item,
        }

        replay = _consumption(auth_client, user_id, body)
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["outcome"] == {
            "kind": "Removed",
            "itemId": ep1_item,
            "nextItemId": {"kind": "Present", "value": ep2_item},
        }
        assert [i["mediaId"] for i in data["lectern"]["items"]] == [str(ep2)]


class TestSetUnread:
    def test_bump_reset_and_listening_states_payload(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)

        # Two heartbeats: create the row (rev 1) then advance position (rev 2).
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=1000,
                expected_write_revision=0,
                expected_reset_epoch=0,
            ).status_code
            == 200
        )
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=120_000,
                expected_write_revision=1,
                expected_reset_epoch=0,
            ).status_code
            == 200
        )

        result = _consumption(
            auth_client,
            user_id,
            {"kind": "SetUnread", "clientMutationId": str(uuid4()), "mediaId": str(episode)},
        )
        assert result.status_code == 200, result.text
        data = result.json()["data"]
        assert data["outcome"] == {"kind": "StateOnly"}
        assert len(data["listeningStates"]) == 1
        entry = data["listeningStates"][0]
        assert entry["mediaId"] == str(episode)
        assert entry["state"]["positionMs"] == 0
        assert entry["state"]["writeRevision"] == 3  # 2 -> +1
        assert entry["state"]["resetEpoch"] == 1  # 0 -> +1

    def test_replay_adopts_later_progress_without_double_bump(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=1000,
                expected_write_revision=0,
                expected_reset_epoch=0,
            ).status_code
            == 200
        )

        cmid = str(uuid4())
        body = {"kind": "SetUnread", "clientMutationId": cmid, "mediaId": str(episode)}
        first = _consumption(auth_client, user_id, body)
        assert first.status_code == 200, first.text
        # After reset: revision 2, epoch 1, position 0.
        assert first.json()["data"]["listeningStates"][0]["state"]["writeRevision"] == 2

        # New progress lands under the reset fence (expected 2/1).
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=5000,
                expected_write_revision=2,
                expected_reset_epoch=1,
            ).status_code
            == 200
        )

        replay = _consumption(auth_client, user_id, body)
        assert replay.status_code == 200, replay.text
        entry = replay.json()["data"]["listeningStates"][0]["state"]
        # Replay does not bump again (revision stays 3, not 4) and adopts the
        # later position rather than pairing a fresh revision with a stale zero.
        assert entry["positionMs"] == 5000, entry
        assert entry["writeRevision"] == 3, entry
        assert entry["resetEpoch"] == 1, entry


class TestSetBatchState:
    def test_podcast_only_enforcement(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)
        result = _consumption(
            auth_client,
            user_id,
            {
                "kind": "SetBatchState",
                "clientMutationId": str(uuid4()),
                "mediaIds": [str(article)],
                "state": "Finished",
            },
        )
        assert result.status_code == 400, result.text
        assert result.json()["error"]["code"] == "E_INVALID_KIND"

    def test_finished_and_unread_are_state_only(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, ep)
        _place(auth_client, user_id, [ep])

        finished = _consumption(
            auth_client,
            user_id,
            {
                "kind": "SetBatchState",
                "clientMutationId": str(uuid4()),
                "mediaIds": [str(ep)],
                "state": "Finished",
            },
        )
        assert finished.status_code == 200, finished.text
        data = finished.json()["data"]
        assert data["outcome"] == {"kind": "StateOnly"}
        # Never removes Lectern rows.
        assert [i["mediaId"] for i in data["lectern"]["items"]] == [str(ep)]
        assert _item_by_media(data["lectern"]["items"], ep)["consumption"]["state"] == "Finished"
        assert data["listeningStates"] == []

        unread = _consumption(
            auth_client,
            user_id,
            {
                "kind": "SetBatchState",
                "clientMutationId": str(uuid4()),
                "mediaIds": [str(ep)],
                "state": "Unread",
            },
        )
        assert unread.status_code == 200, unread.text
        udata = unread.json()["data"]
        assert _item_by_media(udata["lectern"]["items"], ep)["consumption"]["state"] == "Unread"
        # A reset listening row appears in the payload (created by mark-completed).
        assert [entry["mediaId"] for entry in udata["listeningStates"]] == [str(ep)]


class TestEnsureMediaFinished:
    def test_direct_state_only_finish(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, ep)

        result = _consumption(
            auth_client,
            user_id,
            {"kind": "EnsureMediaFinished", "clientMutationId": str(uuid4()), "mediaId": str(ep)},
        )
        assert result.status_code == 200, result.text
        assert result.json()["data"]["outcome"] == {"kind": "StateOnly"}
        # State-only: placing the media afterwards shows Finished, no Lectern row added by finish.
        placed = _place(auth_client, user_id, [ep])
        assert _item_by_media(placed, ep)["consumption"]["state"] == "Finished"
