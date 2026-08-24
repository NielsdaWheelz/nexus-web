"""Priority proof: the upload half is page-bounded, but the badge counts the whole backlog.

Both halves of the union are bounded by the caller's page limit so an unbounded
backlog of abandoned sessions cannot be hydrated on one request; the badge is a
separate aggregate, so bounding must not silently truncate what it reports.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from tests.testkit.auth import UserRecord
from tests.testkit.media_activity import create_upload_session


def test_activity_upload_badge_counts_every_unresolved_obligation(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    for index in range(3):
        create_upload_session(
            db_session,
            viewer_id=test_user.id,
            filename=f"backlog-{index}.epub",
            expires_at=now - timedelta(minutes=10 - index),
        )
    db_session.flush()

    bounded = authenticated_client.get("/media/activity?limit=2")

    assert bounded.status_code == 200, bounded.text
    payload = bounded.json()["data"]
    assert [item["filename"] for item in payload["items"]] == [
        "backlog-0.epub",
        "backlog-1.epub",
    ]
    assert payload["needs_attention_count"] == 3
    assert payload["active_count"] == 0
    assert payload["has_more"] is True
