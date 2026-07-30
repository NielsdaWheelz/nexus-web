"""Integration tests for the revision-fenced listening heartbeat (spec §5.4).

GET/PUT /media/{id}/listening-state. The PUT is the unreplayable CAS mutation:
an exact ``(expectedWriteRevision, expectedResetEpoch)`` writes position and
advances the revision; a mismatch writes nothing.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, f"/me bootstrap failed: {response.text}"
    return UUID(response.json()["data"]["default_library_id"])


def _create_audio_media(direct_db: DirectSessionManager) -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title="Heartbeat Media",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    # Parent registered first so LIFO cleanup deletes the FK children before it.
    direct_db.register_cleanup("media", "id", media_id)
    for table in (
        "consumption_queue_items",
        "consumption_overrides",
        "podcast_listening_states",
        "reader_media_state",
        "reader_engagement_states",
        "library_entries",
    ):
        direct_db.register_cleanup(table, "media_id", media_id)
    return media_id


def _add_to_library(direct_db: DirectSessionManager, library_id: UUID, media_id: UUID) -> None:
    """Seed a physical library_entries row directly, bypassing the REST filing
    endpoint's membership-reachability gate: bare factory/direct-INSERT media
    isn't membership-reachable, so actor-authorized filing rejects it.
    Production ingest always auto-files freshly-created media into the
    creator's default library (ensure_media_in_default_library); this mirrors
    that reachability for fixture media created via a bare Media row rather
    than real ingest."""
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _heartbeat_body(
    *,
    position_ms: int,
    expected_write_revision: int,
    expected_reset_epoch: int,
    duration_ms: int = 600_000,
    episode_playback_rate: dict | None = None,
) -> dict:
    return {
        "positionMs": position_ms,
        "durationMs": {"kind": "Present", "value": duration_ms},
        "episodePlaybackRate": episode_playback_rate or {"kind": "Present", "value": 1.5},
        "expectedWriteRevision": expected_write_revision,
        "expectedResetEpoch": expected_reset_epoch,
        "heartbeatGeneration": str(uuid4()),
        "heartbeatSequence": 7,
    }


def _put(auth_client, user_id, media_id, body):
    return auth_client.put(
        f"/media/{media_id}/listening-state", headers=auth_headers(user_id), json=body
    )


def _get(auth_client, user_id, media_id):
    return auth_client.get(f"/media/{media_id}/listening-state", headers=auth_headers(user_id))


class TestGet:
    def test_default_row_when_absent(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)

        response = _get(auth_client, user_id, media_id)
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {
            "positionMs": 0,
            "durationMs": {"kind": "Absent"},
            "episodePlaybackRate": {"kind": "Absent"},
            "writeRevision": 0,
            "resetEpoch": 0,
        }


class TestPut:
    def test_happy_path_increments_revision(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)

        response = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(position_ms=60_000, expected_write_revision=0, expected_reset_epoch=0),
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["listeningState"]["writeRevision"] == 1
        assert data["listeningState"]["positionMs"] == 60_000
        assert data["listeningState"]["episodePlaybackRate"] == {
            "kind": "Present",
            "value": 1.5,
        }
        assert data["heartbeatSequence"] == 7

    def test_stale_revision_writes_nothing(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)

        # First heartbeat creates the row at revision 1.
        assert (
            _put(
                auth_client,
                user_id,
                media_id,
                _heartbeat_body(
                    position_ms=30_000,
                    expected_write_revision=0,
                    expected_reset_epoch=0,
                ),
            ).status_code
            == 200
        )
        before = _get(auth_client, user_id, media_id).json()["data"]
        with direct_db.session() as session:
            before_last_engaged_at = session.execute(
                text(
                    """
                    SELECT last_engaged_at
                    FROM podcast_listening_states
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()

        # A retry that still expects revision 0 is stale.
        stale = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(
                position_ms=90_000,
                duration_ms=120_000,
                episode_playback_rate={"kind": "Present", "value": 1.8},
                expected_write_revision=0,
                expected_reset_epoch=0,
            ),
        )
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "E_STALE_LISTENING_REVISION"

        assert _get(auth_client, user_id, media_id).json()["data"] == before
        with direct_db.session() as session:
            after_last_engaged_at = session.execute(
                text(
                    """
                    SELECT last_engaged_at
                    FROM podcast_listening_states
                    WHERE user_id = :user_id AND media_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
        assert after_last_engaged_at == before_last_engaged_at

    def test_absent_rate_inserts_null_and_preserves_an_established_rate(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)

        absent = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(
                position_ms=1_000,
                expected_write_revision=0,
                expected_reset_epoch=0,
                episode_playback_rate={"kind": "Absent"},
            ),
        )
        assert absent.status_code == 200, absent.text
        assert absent.json()["data"]["listeningState"]["episodePlaybackRate"] == {"kind": "Absent"}

        established = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(
                position_ms=2_000,
                expected_write_revision=1,
                expected_reset_epoch=0,
                episode_playback_rate={"kind": "Present", "value": 1.8},
            ),
        )
        assert established.status_code == 200, established.text

        preserving = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(
                position_ms=3_000,
                expected_write_revision=2,
                expected_reset_epoch=0,
                episode_playback_rate={"kind": "Absent"},
            ),
        )
        assert preserving.status_code == 200, preserving.text
        assert preserving.json()["data"]["listeningState"]["episodePlaybackRate"] == {
            "kind": "Present",
            "value": 1.8,
        }

    @pytest.mark.parametrize(
        "patch",
        [
            {"episodePlaybackRate": None},
            {"episodePlaybackRate": 1.5},
            {"episodePlaybackRate": {"kind": "Present", "value": 0.49}},
            {"episodePlaybackRate": {"kind": "Present", "value": 3.01}},
            {"episodePlaybackRate": {"kind": "Present", "value": "1.5"}},
            {"episodePlaybackRate": {"kind": "Present", "value": True}},
            {"playbackSpeed": 1.5},
        ],
    )
    def test_rejects_noncanonical_rate_shapes(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        patch: dict,
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)
        body = _heartbeat_body(
            position_ms=1_000,
            expected_write_revision=0,
            expected_reset_epoch=0,
        )
        if "playbackSpeed" in patch:
            body.pop("episodePlaybackRate")
        body.update(patch)

        response = _put(auth_client, user_id, media_id, body)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_stale_after_reset_progress(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)
        assert (
            _put(
                auth_client,
                user_id,
                media_id,
                _heartbeat_body(
                    position_ms=30_000, expected_write_revision=0, expected_reset_epoch=0
                ),
            ).status_code
            == 200
        )

        # ResetProgress bumps both listening fences under the viewer lock.
        reset = auth_client.post(
            "/consumption/commands",
            headers=auth_headers(user_id),
            json={
                "kind": "ResetProgress",
                "clientMutationId": str(uuid4()),
                "mediaId": str(media_id),
            },
        )
        assert reset.status_code == 200, reset.text
        assert reset.json()["data"]["progressState"]["value"]["readerCursor"] == {
            "state": "Empty",
            "revision": 1,
        }
        assert (
            reset.json()["data"]["progressState"]["value"]["listeningState"]["value"][
                "writeRevision"
            ]
            == 2
        )

        # A pre-reset heartbeat (still expecting revision 1 / epoch 0) is now stale.
        stale = _put(
            auth_client,
            user_id,
            media_id,
            _heartbeat_body(position_ms=45_000, expected_write_revision=1, expected_reset_epoch=0),
        )
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "E_STALE_LISTENING_REVISION"


class TestVisibility:
    def test_get_and_put_mask_unreadable_media(self, auth_client, direct_db: DirectSessionManager):
        owner = create_test_user_id()
        owner_library = _bootstrap(auth_client, owner)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, owner_library, media_id)
        other = create_test_user_id()
        _bootstrap(auth_client, other)

        get_resp = _get(auth_client, other, media_id)
        assert get_resp.status_code == 404, get_resp.text
        assert get_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        put_resp = _put(
            auth_client,
            other,
            media_id,
            _heartbeat_body(position_ms=1000, expected_write_revision=0, expected_reset_epoch=0),
        )
        assert put_resp.status_code == 404, put_resp.text
        assert put_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


class TestStrictDecode:
    def _valid(self) -> dict:
        return _heartbeat_body(position_ms=1000, expected_write_revision=0, expected_reset_epoch=0)

    def test_rejects_completion_field(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)
        body = self._valid() | {"isCompleted": True}
        response = _put(auth_client, user_id, media_id, body)
        # The app maps strict-decode failures to 400 E_INVALID_REQUEST.
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_rejects_null_duration(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)
        body = self._valid() | {"durationMs": None}
        response = _put(auth_client, user_id, media_id, body)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_rejects_snake_case_key(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        media_id = _create_audio_media(direct_db)
        _add_to_library(direct_db, library_id, media_id)
        body = self._valid()
        body["position_ms"] = body.pop("positionMs")
        response = _put(auth_client, user_id, media_id, body)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
