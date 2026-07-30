"""Post-acquisition transfer from ephemeral Preview audio into owned progress."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _owned_episode(auth_client, direct_db: DirectSessionManager, user_id: UUID) -> UUID:
    bootstrap = auth_client.get("/me", headers=auth_headers(user_id))
    assert bootstrap.status_code == 200, bootstrap.text
    library_id = UUID(bootstrap.json()["data"]["default_library_id"])
    media_id = uuid4()
    with direct_db.session() as db:
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title="Preview transfer",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        db.flush()
        add_media_to_library(db, library_id, media_id)
        db.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    for table in ("podcast_listening_states", "library_entries"):
        direct_db.register_cleanup(table, "media_id", media_id)
    return media_id


def _post(auth_client, user_id: UUID, media_id: UUID, key: UUID, position_ms: int):
    return auth_client.post(
        f"/media/{media_id}/preview-position",
        headers={**auth_headers(user_id), "Idempotency-Key": str(key)},
        json={
            "positionMs": position_ms,
            "durationMs": {"kind": "Present", "value": 30_000},
        },
    )


def _state(auth_client, user_id: UUID, media_id: UUID) -> dict:
    response = auth_client.get(
        f"/media/{media_id}/listening-state",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_transfer_clamps_and_never_overwrites_progress(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    media_id = _owned_episode(auth_client, direct_db, user_id)

    first_key = uuid4()
    first = _post(auth_client, user_id, media_id, first_key, 45_000)
    assert first.status_code == 204, first.text
    assert _state(auth_client, user_id, media_id)["positionMs"] == 30_000

    replay = _post(auth_client, user_id, media_id, first_key, 45_000)
    assert replay.status_code == 204, replay.text

    later = _post(auth_client, user_id, media_id, uuid4(), 5_000)
    assert later.status_code == 204, later.text
    assert _state(auth_client, user_id, media_id)["positionMs"] == 30_000


def test_same_key_with_different_position_is_rejected(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    media_id = _owned_episode(auth_client, direct_db, user_id)
    key = uuid4()

    assert _post(auth_client, user_id, media_id, key, 10_000).status_code == 204
    mismatch = _post(auth_client, user_id, media_id, key, 20_000)
    assert mismatch.status_code == 409, mismatch.text
    assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"
    assert _state(auth_client, user_id, media_id)["positionMs"] == 10_000


def test_invisible_episode_is_not_found(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    media_id = uuid4()
    with direct_db.session() as db:
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title="Unowned preview transfer",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        db.commit()
    direct_db.register_cleanup("media", "id", media_id)

    response = _post(auth_client, user_id, media_id, uuid4(), 10_000)
    assert response.status_code == 404, response.text
    with direct_db.session() as db:
        assert (
            db.execute(
                text(
                    """
                    SELECT 1
                    FROM podcast_listening_states
                    WHERE user_id = :viewer_id AND media_id = :media_id
                    """
                ),
                {"viewer_id": user_id, "media_id": media_id},
            ).scalar_one_or_none()
            is None
        )
