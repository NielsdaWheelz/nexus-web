"""Focused API-contract coverage for Consumption personal-history reads."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from nexus.db.models import Media, MediaKind, ProcessingStatus
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _setup_visible_article(auth_client, direct_db: DirectSessionManager) -> tuple[UUID, UUID]:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id))
    assert me.status_code == 200, me.text
    library_id = UUID(me.json()["data"]["default_library_id"])
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Stats contract",
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.flush()
        add_media_to_library(session, library_id, media_id)
        session.commit()
    direct_db.register_cleanup("media", "id", media_id)
    for table in (
        "library_entries",
        "consumption_completion_facts",
        "consumption_activity_spans",
    ):
        direct_db.register_cleanup(table, "media_id", media_id)
    return user_id, media_id


def _record_reading(auth_client, *, user_id: UUID, media_id: UUID, at: datetime) -> None:
    response = auth_client.post(
        "/consumption/activity",
        headers=auth_headers(user_id),
        json={
            "clientMutationId": str(uuid4()),
            "mediaId": str(media_id),
            "deviceId": "private-device-value",
            "deviceClass": "Desktop",
            "batch": {
                "modality": "Reading",
                "spans": [
                    {
                        "occurredAt": at.isoformat(),
                        "durationMs": 10_000,
                        "progressStart": {"kind": "Present", "value": 0.25},
                        "progressEnd": {"kind": "Present", "value": 0.5},
                        "wordStart": {"kind": "Present", "value": 10},
                        "wordEnd": {"kind": "Present", "value": 30},
                    }
                ],
            },
        },
    )
    assert response.status_code == 204, response.text


def test_stats_and_sessions_return_enriched_private_contract(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id, media_id = _setup_visible_article(auth_client, direct_db)
    now = datetime.now(UTC)
    _record_reading(
        auth_client,
        user_id=user_id,
        media_id=media_id,
        at=now - timedelta(minutes=2),
    )
    query = {
        "start": (now - timedelta(hours=1)).isoformat(),
        "end": (now + timedelta(hours=1)).isoformat(),
        "bucket": "Hour",
        "timeZone": "America/Los_Angeles",
        "currentDeviceId": "private-device-value",
    }
    response = auth_client.get("/consumption/stats", headers=auth_headers(user_id), params=query)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    payload = response.json()["data"]
    assert payload["activity"]["totals"]["activeMs"] == 10_000
    assert payload["activity"]["totals"]["forwardWordPosition"] == 20
    assert len(payload["activity"]["localHours"]) == 24
    assert sum(row["activeMs"] for row in payload["activity"]["timeline"]) == 10_000
    assert payload["activity"]["devices"][0]["label"] == "This device"
    session = payload["activity"]["sessions"]["rows"][0]
    assert session["firstProgress"] == {"kind": "Present", "value": 0.25}
    assert session["lastProgress"] == {"kind": "Present", "value": 0.5}
    assert session["forwardWordPosition"] == 20
    assert "private-device-value" not in response.text

    sessions_query = {key: value for key, value in query.items() if key != "bucket"}
    sessions = auth_client.get(
        "/consumption/sessions",
        headers=auth_headers(user_id),
        params={**sessions_query, "limit": 1},
    )
    assert sessions.status_code == 200, sessions.text
    assert sessions.headers["cache-control"] == "private, no-store"
    assert sessions.json()["data"]["sessions"][0] == session
    assert "private-device-value" not in sessions.text


@pytest.mark.parametrize(
    "params",
    [
        {"end": "2026-01-02T00:00:00+00:00", "bucket": "Day", "timeZone": "UTC"},
        {
            "end": "2026-01-02T00:00:00+00:00",
            "bucket": "Day",
            "timeZone": "Not/A_Zone",
            "currentDeviceId": "d",
        },
        {
            "end": "2026-01-02T00:00:00+00:00",
            "bucket": "Day",
            "timeZone": "UTC",
            "currentDeviceId": "d",
            "mediaRef": str(uuid4()),
        },
        {
            "end": "2026-01-02T00:00:00+00:00",
            "bucket": "Day",
            "timeZone": "UTC",
            "currentDeviceId": "d",
            "unknown": "value",
        },
        {
            "end": "2026-01-02T00:00:00+00:00",
            "bucket": "Day",
            "timeZone": "UTC",
            "currentDeviceId": "d",
            "contributorHandle": "Bad Handle",
        },
    ],
)
def test_stats_rejects_noncanonical_query(
    auth_client, direct_db: DirectSessionManager, params: dict[str, str]
) -> None:
    user_id, _media_id = _setup_visible_article(auth_client, direct_db)
    response = auth_client.get("/consumption/stats", headers=auth_headers(user_id), params=params)
    assert response.status_code == 400, response.text
    assert response.headers["cache-control"] == "private, no-store"


def test_stats_rejects_duplicate_query_keys(auth_client, direct_db: DirectSessionManager) -> None:
    user_id, _media_id = _setup_visible_article(auth_client, direct_db)
    response = auth_client.get(
        "/consumption/stats"
        "?end=2026-01-02T00%3A00%3A00%2B00%3A00"
        "&bucket=Day"
        "&bucket=Hour"
        "&timeZone=UTC"
        "&currentDeviceId=d",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 400, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["error"]["message"] == ("Duplicate Consumption query params: bucket")
