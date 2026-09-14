"""Compact locator resolution identifies document readers without opening bodies."""

from uuid import uuid4

from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import Media
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def test_reader_body_classification_preserves_timeline_and_visibility(
    db_session: Session, authenticated_client: TestClient, test_user: UserRecord
) -> None:
    outsider = uuid4()
    ensure_user_and_default_library(db_session, outsider, f"reader-body-{outsider}@example.invalid")
    cases: list[tuple[str, bool]] = []
    for kind, document in (
        ("web_article", True),
        ("epub", True),
        ("pdf", True),
        ("podcast_episode", False),
        ("video", False),
    ):
        media_id = uuid4()
        db_session.add(
            Media(
                id=media_id,
                kind=kind,
                title="Compact reader kind",
                processing_status="ready_for_reading",
                created_by_user_id=test_user.id,
            )
        )
        db_session.flush()
        ensure_media_in_default_library(db_session, test_user.id, media_id)
        cases.append((f"media:{media_id}", document))
    private_id = uuid4()
    db_session.add(
        Media(
            id=private_id,
            kind="pdf",
            title="Private document",
            processing_status="ready_for_reading",
            created_by_user_id=outsider,
        )
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, outsider, private_id)
    cases.extend(
        (
            (f"media:{private_id}", False),
            (f"media:{uuid4()}", False),
            (f"library:{test_user.default_library_id}", False),
        )
    )
    locators = [{"kind": "resource_ref", "ref": ref} for ref, _expected in cases]
    response = authenticated_client.post(
        "/resource-items/locators/resolve", json={"locators": locators}
    )
    assert response.status_code == 200, response.text
    rows = response.json()["data"]["resolutions"]
    assert [(row["locator"], row["documentReader"]) for row in rows] == [
        (locator, expected) for locator, (_ref, expected) in zip(locators, cases, strict=True)
    ], "compact reader classification changed timeline or private resource behavior"
    assert rows[5]["resourceItem"]["missing"] is True
    assert rows[6]["resourceItem"]["missing"] is True
