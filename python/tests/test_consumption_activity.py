"""Integration coverage for replayable Consumption activity capture."""

from datetime import UTC, datetime, timedelta
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
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _article(direct_db: DirectSessionManager) -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Activity article",
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    for table in (
        "media",
        "library_entries",
        "consumption_activity_spans",
        "consumption_completion_facts",
        "user_media_deletions",
    ):
        direct_db.register_cleanup(table, "media_id" if table != "media" else "id", media_id)
    return media_id


def _grant_library_media(direct_db: DirectSessionManager, library_id: UUID, media_id: UUID) -> None:
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _body(media_id: UUID, mutation_id: UUID, *, occurred_at: datetime) -> dict:
    return {
        "clientMutationId": str(mutation_id),
        "mediaId": str(media_id),
        "deviceId": "server-injected-device",
        "deviceClass": "Desktop",
        "batch": {
            "modality": "Reading",
            "spans": [
                {
                    "occurredAt": occurred_at.isoformat(),
                    "durationMs": 10_000,
                    "progressStart": {"kind": "Present", "value": 0.1},
                    "progressEnd": {"kind": "Present", "value": 0.2},
                    "wordStart": {"kind": "Present", "value": 10},
                    "wordEnd": {"kind": "Present", "value": 20},
                }
            ],
        },
    }


def _span_count(direct_db: DirectSessionManager, *, user_id: UUID, media_id: UUID) -> int:
    with direct_db.session() as session:
        return int(
            session.execute(
                text(
                    "SELECT count(*) FROM consumption_activity_spans"
                    " WHERE user_id = :user_id AND media_id = :media_id"
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
        )


def test_activity_capture_replays_exact_payload_once(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    library_id = _bootstrap(auth_client, user_id)
    media_id = _article(direct_db)
    _grant_library_media(direct_db, library_id, media_id)
    body = _body(media_id, uuid4(), occurred_at=datetime.now(UTC) - timedelta(seconds=1))

    first = auth_client.post("/consumption/activity", headers=auth_headers(user_id), json=body)
    assert first.status_code == 204, first.text
    assert first.headers["cache-control"] == "private, no-store"
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO user_media_deletions (user_id, media_id)
                VALUES (:user_id, :media_id)
                """
            ),
            {"user_id": user_id, "media_id": media_id},
        )
        session.commit()
    replay = auth_client.post("/consumption/activity", headers=auth_headers(user_id), json=body)
    assert replay.status_code == 204, replay.text
    assert _span_count(direct_db, user_id=user_id, media_id=media_id) == 1


def test_activity_capture_rejects_replay_payload_mismatch(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    library_id = _bootstrap(auth_client, user_id)
    media_id = _article(direct_db)
    _grant_library_media(direct_db, library_id, media_id)
    mutation_id = uuid4()
    body = _body(media_id, mutation_id, occurred_at=datetime.now(UTC) - timedelta(seconds=1))
    assert (
        auth_client.post(
            "/consumption/activity", headers=auth_headers(user_id), json=body
        ).status_code
        == 204
    )
    body["deviceClass"] = "Mobile"
    conflict = auth_client.post("/consumption/activity", headers=auth_headers(user_id), json=body)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"
    assert _span_count(direct_db, user_id=user_id, media_id=media_id) == 1


@pytest.mark.parametrize(
    "occurred_at",
    [
        datetime.now(UTC) - timedelta(days=2),
        datetime.now(UTC) + timedelta(minutes=6),
    ],
)
def test_activity_capture_rejects_out_of_window_spans(
    auth_client, direct_db: DirectSessionManager, occurred_at: datetime
):
    user_id = create_test_user_id()
    library_id = _bootstrap(auth_client, user_id)
    media_id = _article(direct_db)
    _grant_library_media(direct_db, library_id, media_id)
    response = auth_client.post(
        "/consumption/activity",
        headers=auth_headers(user_id),
        json=_body(media_id, uuid4(), occurred_at=occurred_at),
    )
    assert response.status_code == 400, response.text
    assert _span_count(direct_db, user_id=user_id, media_id=media_id) == 0
