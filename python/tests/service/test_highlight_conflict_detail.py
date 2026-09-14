"""Equal-range conflicts identify only the viewer's existing authored detail."""

from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Highlight, HighlightFragmentAnchor, Media
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def test_duplicate_highlight_returns_authorized_detail_without_relisting(
    db_session: Session, test_user: UserRecord, authenticated_client: TestClient
) -> None:
    media_id, fragment_id, own_id, foreign_id, other_user = (uuid4() for _ in range(5))
    ensure_user_and_default_library(db_session, other_user, "other-highlight@example.invalid")
    db_session.add(
        Media(
            id=media_id,
            kind="web_article",
            title="Source",
            processing_status="ready_for_reading",
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    db_session.add(
        Fragment(
            id=fragment_id,
            media_id=media_id,
            idx=0,
            canonical_text="one two",
            html_sanitized="<p>one two</p>",
        )
    )
    # A different user's identical selection must never become conflict details.
    for highlight_id, owner in ((foreign_id, other_user), (own_id, test_user.id)):
        db_session.add(
            Highlight(
                id=highlight_id,
                user_id=owner,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact="one",
                prefix="",
                suffix=" two",
            )
        )
        db_session.flush()
        db_session.add(
            HighlightFragmentAnchor(
                highlight_id=highlight_id, fragment_id=fragment_id, start_offset=0, end_offset=3
            )
        )
    db_session.flush()
    response = authenticated_client.post(
        f"/fragments/{fragment_id}/highlights",
        json={"start_offset": 0, "end_offset": 3, "color": "blue"},
    )
    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "E_HIGHLIGHT_CONFLICT"
    assert error["details"] == {"existing_highlight_id": str(own_id)}
    detail = authenticated_client.get(f"/highlights/{error['details']['existing_highlight_id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["data"]["id"] == str(own_id)
    assert detail.json()["data"]["exact"] == "one"
    assert (
        db_session.scalar(
            select(func.count()).select_from(Highlight).where(Highlight.anchor_media_id == media_id)
        )
        == 2
    )
    assert db_session.get(Highlight, own_id).color == "yellow"
