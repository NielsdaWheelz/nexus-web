"""Priority proof: publication, not capability freshness, resolves an upload obligation.

A published session keeps its durable identity row and its long-expired PUT
capability. If publication stopped resolving the obligation, every successful
import would reappear forever as a Needs Attention item whose Remove button can
only ever answer E_UPLOAD_ALREADY_PUBLISHED.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import MediaKind, ProcessingStatus
from tests.testkit.auth import UserRecord
from tests.testkit.media_activity import create_source_media, create_upload_session


def test_activity_is_silent_for_published_upload_sessions(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    published_media_id, published_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published upload",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    published_attempt.status = "succeeded"
    published = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="published.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = published_media_id
    published.published_source_attempt_id = published_attempt.id
    published.published_at = now - timedelta(minutes=6)
    # One unresolved obligation with the same expired capability is the control: it
    # proves the projection is live and that only publication silences a session.
    create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="unpublished.epub",
        expires_at=now - timedelta(minutes=7),
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert [item["filename"] for item in payload["items"]] == ["unpublished.epub"]
    assert payload["needs_attention_count"] == 1
    assert payload["active_count"] == 0
    assert payload["has_more"] is False
    assert "Published upload" not in {item.get("title") for item in payload["items"]}
