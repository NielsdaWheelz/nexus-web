"""Proof: the Lectern wire reports each row's recorded membership instant.

Risk: ``addedAt`` is the fact the Added views order by. Fabricating it from the
queue position, from ``now()``, or from any other row would present a truthful
looking but wrong reading order.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.db.models import ConsumptionQueueItem, Media, MediaKind, ProcessingStatus
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def _queue_article(
    db: Session,
    *,
    viewer_id: UUID,
    title: str,
    position: int,
    added_at: datetime,
) -> UUID:
    """One visible article on the viewer's Lectern at an exact stored instant.

    ``added_at`` is written directly because the placement owner always stamps
    ``now()``; an exact historical instant is unreachable through it.
    """
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title=title,
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=viewer_id,
        )
    )
    db.flush()
    ensure_media_in_default_library(db, viewer_id, media_id)
    db.add(
        ConsumptionQueueItem(
            user_id=viewer_id,
            media_id=media_id,
            position=position,
            added_at=added_at,
            source="manual",
        )
    )
    db.flush()
    return media_id


def test_lectern_snapshot_reports_each_rows_stored_added_at_instant(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    """Membership instants are echoed per row, opposite to the queue order."""
    # Deliberately opposed to `position` so a projection that read the ordering,
    # the wall clock, or a neighbouring row cannot pass.
    newest = datetime(2025, 11, 17, 21, 5, 45, tzinfo=UTC)
    oldest = datetime(2024, 3, 1, 9, 30, tzinfo=UTC)
    added_last = _queue_article(
        db_session,
        viewer_id=test_user.id,
        title="Queued first, added last",
        position=0,
        added_at=newest,
    )
    added_first = _queue_article(
        db_session,
        viewer_id=test_user.id,
        title="Queued last, added first",
        position=1,
        added_at=oldest,
    )

    response = authenticated_client.get("/lectern")

    assert response.status_code == 200, f"GET /lectern failed: {response.text}"
    items = response.json()["data"]["items"]
    reported = {item["mediaId"]: datetime.fromisoformat(item["addedAt"]) for item in items}
    assert reported == {str(added_last): newest, str(added_first): oldest}, (
        "GET /lectern must report each queue row's stored added_at; "
        f"expected {{{added_last}: {newest.isoformat()}, "
        f"{added_first}: {oldest.isoformat()}}}, got {reported}"
    )
