"""Integration tests for the consumption command port (spec §5.2).

Asserts through POST /consumption/commands, POST /lectern/commands, and the
listening heartbeat. Terminal state is observed by re-placing a finished media
and reading its projected consumption state.
"""

import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    Media,
    MediaKind,
    Podcast,
    PodcastEpisode,
    ProcessingStatus,
)
from nexus.schemas.consumption import EnsureMediaFinishedCommand
from nexus.services.consumption import service as consumption_service
from tests.factories import add_media_to_library, add_test_podcast_episode_identity
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
        "consumption_completion_facts",
        "consumption_activity_spans",
        "consumption_queue_items",
        "consumption_overrides",
        "podcast_listening_states",
        "reader_media_state",
        "reader_engagement_states",
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
    episode_ref = f"episode-{media_id}"
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
                canonical_source_url=f"https://example.com/{episode_ref}",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
                provider="podcast_index",
                provider_id=episode_ref,
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.add(
            PodcastEpisode(
                media_id=media_id,
                podcast_id=podcast_id,
                published_at="2026-03-22T00:00:00Z",
                duration_seconds=600,
            )
        )
        add_test_podcast_episode_identity(
            session,
            podcast_id=podcast_id,
            media_id=media_id,
            value=episode_ref,
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
    playback_speed=1.0,
):
    return auth_client.put(
        f"/media/{media_id}/listening-state",
        headers=auth_headers(user_id),
        json={
            "positionMs": position_ms,
            "durationMs": {"kind": "Present", "value": duration_ms},
            "playbackSpeed": playback_speed,
            "expectedWriteRevision": expected_write_revision,
            "expectedResetEpoch": expected_reset_epoch,
            "heartbeatGeneration": str(uuid4()),
            "heartbeatSequence": 1,
        },
    )


def _put_reader_cursor(
    auth_client, user_id: UUID, media_id: UUID, *, locator: dict, base_revision: int
):
    return auth_client.put(
        f"/media/{media_id}/reader-state",
        headers=auth_headers(user_id),
        json={"locator": locator, "base_revision": base_revision},
    )


def _transcript_locator(*, total_progression: float = 0.5) -> dict:
    return {
        "kind": "transcript",
        "target": {"fragment_id": str(uuid4())},
        "locations": {
            "text_offset": 0,
            "progression": total_progression,
            "total_progression": total_progression,
            "position": 1,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }


def _item_by_media(items, media_id) -> dict:
    return next(item for item in items if item["mediaId"] == str(media_id))


def _completion_rows(direct_db: DirectSessionManager, *, user_id: UUID, media_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT id, created_at
                FROM consumption_completion_facts
                WHERE user_id = :user_id AND media_id = :media_id
                ORDER BY id
                """
            ),
            {"user_id": user_id, "media_id": media_id},
        ).fetchall()


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
        assert data["completionHandle"]["kind"] == "Present"
        assert len(_completion_rows(direct_db, user_id=user_id, media_id=ep1)) == 1

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
    def test_changes_status_only_and_leaves_active_progress_untouched(
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
        assert data["progressState"] == {"kind": "Absent"}
        with direct_db.session() as session:
            state = session.execute(
                text(
                    """
                    SELECT position_ms, write_revision, reset_epoch
                    FROM podcast_listening_states
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": episode},
            ).one()
        assert tuple(state) == (120_000, 2, 0)


class TestResetProgress:
    def test_inaccessible_media_is_masked_as_not_found(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A real media row outside the viewer's library remains invisible."""
        viewer_id = create_test_user_id()
        owner_id = create_test_user_id()
        _bootstrap(auth_client, viewer_id)
        owner_library_id = _bootstrap(auth_client, owner_id)
        episode = _create_podcast_episode(direct_db, title="Private episode")
        _add_to_library(direct_db, owner_library_id, episode)

        response = _consumption(
            auth_client,
            viewer_id,
            {
                "kind": "ResetProgress",
                "clientMutationId": str(uuid4()),
                "mediaId": str(episode),
            },
        )

        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_rejects_extra_command_fields(self, auth_client):
        """The ResetProgress command is a closed, discriminated request shape."""
        user_id = create_test_user_id()
        _bootstrap(auth_client, user_id)

        response = _consumption(
            auth_client,
            user_id,
            {
                "kind": "ResetProgress",
                "clientMutationId": str(uuid4()),
                "mediaId": str(uuid4()),
                "unexpected": True,
            },
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_resets_current_progress_only_and_fences_stale_writes(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=120_000,
                expected_write_revision=0,
                expected_reset_epoch=0,
                playback_speed=1.25,
            ).status_code
            == 200
        )
        locator = _transcript_locator()
        assert (
            _put_reader_cursor(
                auth_client,
                user_id,
                episode,
                locator=locator,
                base_revision=0,
            ).status_code
            == 200
        )
        finished = _consumption(
            auth_client,
            user_id,
            {
                "kind": "EnsureMediaFinished",
                "clientMutationId": str(uuid4()),
                "mediaId": str(episode),
            },
        )
        assert finished.status_code == 200, finished.text
        assert len(_completion_rows(direct_db, user_id=user_id, media_id=episode)) == 1

        cmid = str(uuid4())
        assert (
            _consumption(
                auth_client,
                user_id,
                {"kind": "SetUnread", "clientMutationId": str(uuid4()), "mediaId": str(episode)},
            ).status_code
            == 200
        )
        body = {"kind": "ResetProgress", "clientMutationId": cmid, "mediaId": str(episode)}
        first = _consumption(auth_client, user_id, body)
        assert first.status_code == 200, first.text
        data = first.json()["data"]
        assert data["outcome"] == {"kind": "StateOnly"}
        assert data["progressState"] == {
            "kind": "Present",
            "value": {
                "mediaId": str(episode),
                "readerCursor": {"state": "Empty", "revision": 2},
                "listeningState": {
                    "kind": "Present",
                    "value": {
                        "positionMs": 0,
                        "durationMs": {"kind": "Present", "value": 600_000},
                        "playbackSpeed": 1.25,
                        "writeRevision": 2,
                        "resetEpoch": 1,
                    },
                },
            },
        }
        item = _item_by_media(data["lectern"]["items"], episode)
        assert item["consumption"] == {
            "state": "Unread",
            "progress": {"kind": "Present", "value": 0.0},
            "progressResettable": False,
        }
        with direct_db.session() as session:
            assert (
                session.execute(
                    text(
                        """
                    SELECT count(*)
                    FROM consumption_overrides
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                    ),
                    {"user_id": user_id, "media_id": episode},
                ).scalar_one()
                == 0
            )
            assert (
                session.execute(
                    text(
                        """
                    SELECT count(*)
                    FROM reader_engagement_states
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                    ),
                    {"user_id": user_id, "media_id": episode},
                ).scalar_one()
                == 0
            )
            listening = session.execute(
                text(
                    """
                    SELECT position_ms, is_completed, write_revision, reset_epoch, last_engaged_at
                    FROM podcast_listening_states
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": episode},
            ).one()
        assert tuple(listening) == (0, False, 2, 1, None)
        # Reset replaces current state only: the factual completion remains
        # available to existing history/Undo flows.
        assert len(_completion_rows(direct_db, user_id=user_id, media_id=episode)) == 1

        stale_cursor = _put_reader_cursor(
            auth_client,
            user_id,
            episode,
            locator=_transcript_locator(total_progression=0.6),
            base_revision=1,
        )
        assert stale_cursor.status_code == 409
        assert stale_cursor.json()["error"]["details"]["current"] == {
            "state": "Empty",
            "revision": 2,
        }
        stale_heartbeat = _heartbeat(
            auth_client,
            user_id,
            episode,
            position_ms=5_000,
            expected_write_revision=1,
            expected_reset_epoch=0,
        )
        assert stale_heartbeat.status_code == 409

        # Freshly fenced progress may proceed. Replay must re-read this exact
        # canonical state without applying ResetProgress a second time.
        assert (
            _heartbeat(
                auth_client,
                user_id,
                episode,
                position_ms=5_000,
                expected_write_revision=2,
                expected_reset_epoch=1,
            ).status_code
            == 200
        )
        fresh_locator = _transcript_locator(total_progression=0.6)
        assert (
            _put_reader_cursor(
                auth_client,
                user_id,
                episode,
                locator=fresh_locator,
                base_revision=2,
            ).status_code
            == 200
        )

        replay = _consumption(auth_client, user_id, body)
        assert replay.status_code == 200, replay.text
        progress = replay.json()["data"]["progressState"]["value"]
        assert progress["readerCursor"] == {
            "state": "Positioned",
            "revision": 3,
            "locator": fresh_locator,
        }
        assert progress["listeningState"] == {
            "kind": "Present",
            "value": {
                "positionMs": 5_000,
                "durationMs": {"kind": "Present", "value": 600_000},
                "playbackSpeed": 1.0,
                "writeRevision": 3,
                "resetEpoch": 1,
            },
        }

    def test_absent_podcast_state_initializes_and_new_resets_advance_fences(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        episode = _create_podcast_episode(direct_db, title="No current progress")
        _add_to_library(direct_db, library_id, episode)

        first = _consumption(
            auth_client,
            user_id,
            {
                "kind": "ResetProgress",
                "clientMutationId": str(uuid4()),
                "mediaId": str(episode),
            },
        )
        assert first.status_code == 200, first.text
        assert first.json()["data"]["progressState"] == {
            "kind": "Present",
            "value": {
                "mediaId": str(episode),
                "readerCursor": {"state": "Empty", "revision": 1},
                "listeningState": {
                    "kind": "Present",
                    "value": {
                        "positionMs": 0,
                        "durationMs": {"kind": "Absent"},
                        "playbackSpeed": 1.0,
                        "writeRevision": 1,
                        "resetEpoch": 1,
                    },
                },
            },
        }

        second = _consumption(
            auth_client,
            user_id,
            {
                "kind": "ResetProgress",
                "clientMutationId": str(uuid4()),
                "mediaId": str(episode),
            },
        )
        assert second.status_code == 200, second.text
        state = second.json()["data"]["progressState"]["value"]
        assert state["readerCursor"] == {"state": "Empty", "revision": 2}
        assert state["listeningState"] == {
            "kind": "Present",
            "value": {
                "positionMs": 0,
                "durationMs": {"kind": "Absent"},
                "playbackSpeed": 1.0,
                "writeRevision": 2,
                "resetEpoch": 2,
            },
        }


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
        assert data["progressState"] == {"kind": "Absent"}

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
        assert udata["progressState"] == {"kind": "Absent"}


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
        assert result.json()["data"]["completionHandle"]["kind"] == "Present"
        assert len(_completion_rows(direct_db, user_id=user_id, media_id=ep)) == 1
        # State-only: placing the media afterwards shows Finished, no Lectern row added by finish.
        placed = _place(auth_client, user_id, [ep])
        assert _item_by_media(placed, ep)["consumption"]["state"] == "Finished"

    def test_already_finished_pre_cutover_state_never_backfills_a_fact(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep = _create_podcast_episode(direct_db, title="Pre-cutover")
        _add_to_library(direct_db, library_id, ep)
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO consumption_overrides (user_id, media_id, status)
                    VALUES (:user_id, :media_id, 'finished')
                    """
                ),
                {"user_id": user_id, "media_id": ep},
            )
            session.commit()

        for _ in range(2):
            finished = _consumption(
                auth_client,
                user_id,
                {
                    "kind": "EnsureMediaFinished",
                    "clientMutationId": str(uuid4()),
                    "mediaId": str(ep),
                },
            )
            assert finished.status_code == 200, finished.text
            assert finished.json()["data"]["completionHandle"] == {"kind": "Absent"}
        assert _completion_rows(direct_db, user_id=user_id, media_id=ep) == []

    def test_completion_handle_undo_retracts_only_the_new_fact(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, ep)

        finished = _consumption(
            auth_client,
            user_id,
            {"kind": "EnsureMediaFinished", "clientMutationId": str(uuid4()), "mediaId": str(ep)},
        )
        assert finished.status_code == 200, finished.text
        handle = finished.json()["data"]["completionHandle"]
        assert handle["kind"] == "Present"
        original_id, original_created_at = _completion_rows(
            direct_db, user_id=user_id, media_id=ep
        )[0]

        ordinary_unread = _consumption(
            auth_client,
            user_id,
            {"kind": "SetUnread", "clientMutationId": str(uuid4()), "mediaId": str(ep)},
        )
        assert ordinary_unread.status_code == 200, ordinary_unread.text
        assert _completion_rows(direct_db, user_id=user_id, media_id=ep) == [
            (original_id, original_created_at)
        ]

        re_finished = _consumption(
            auth_client,
            user_id,
            {"kind": "EnsureMediaFinished", "clientMutationId": str(uuid4()), "mediaId": str(ep)},
        )
        assert re_finished.status_code == 200, re_finished.text
        assert re_finished.json()["data"]["completionHandle"] == {"kind": "Absent"}
        assert _completion_rows(direct_db, user_id=user_id, media_id=ep) == [
            (original_id, original_created_at)
        ]

        undone = _consumption(
            auth_client,
            user_id,
            {
                "kind": "UndoCompletion",
                "clientMutationId": str(uuid4()),
                "completionHandle": handle["value"],
            },
        )
        assert undone.status_code == 200, undone.text
        assert undone.json()["data"]["completionHandle"] == {"kind": "Absent"}
        assert _completion_rows(direct_db, user_id=user_id, media_id=ep) == []

        placed = _place(auth_client, user_id, [ep])
        assert _item_by_media(placed, ep)["consumption"]["state"] == "Unread"

        finished_again = _consumption(
            auth_client,
            user_id,
            {"kind": "EnsureMediaFinished", "clientMutationId": str(uuid4()), "mediaId": str(ep)},
        )
        assert finished_again.status_code == 200, finished_again.text
        assert finished_again.json()["data"]["completionHandle"]["kind"] == "Present"
        replacement_id, _ = _completion_rows(direct_db, user_id=user_id, media_id=ep)[0]
        assert replacement_id != original_id


class TestConcurrentCompletionTransitions:
    def test_concurrent_finished_commands_create_one_fact_and_one_handle(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        ep = _create_podcast_episode(direct_db, title="Raced completion")
        _add_to_library(direct_db, library_id, ep)

        barrier = threading.Barrier(2)
        results = []
        errors: list[BaseException] = []
        result_lock = threading.Lock()

        def finish_once() -> None:
            try:
                barrier.wait(timeout=10)
                result = consumption_service.run_consumption_command(
                    user_id,
                    EnsureMediaFinishedCommand(
                        kind="EnsureMediaFinished",
                        clientMutationId=uuid4(),
                        mediaId=ep,
                    ),
                )
                with result_lock:
                    results.append(result)
            except BaseException as exc:  # pragma: no cover - re-raised below
                with result_lock:
                    errors.append(exc)

        workers = [threading.Thread(target=finish_once) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=30)
        assert all(not worker.is_alive() for worker in workers)
        assert errors == [], f"concurrent completion workers raised: {errors!r}"
        assert len(results) == 2
        assert sum(result.completion_handle.kind == "Present" for result in results) == 1
        assert len(_completion_rows(direct_db, user_id=user_id, media_id=ep)) == 1
