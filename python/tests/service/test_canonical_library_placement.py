"""Real-API proof for the canonical Libraries relationship editor contract.

The independent oracle is the approved product contract: Media has one physical
``SavedInNexus`` destination plus every visible Library; relation and authority
are tagged facts, and the public placement command can remove a Default-backed
direct relation when another Library keeps the Media reachable.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    Library,
    Media,
    MediaKind,
    Membership,
    Podcast,
    PodcastEpisode,
    PodcastSubscription,
    ProcessingStatus,
)
from nexus.services.library_entries import (
    ensure_entry,
    ensure_media_in_default_library,
    list_item_libraries,
    media_target,
    podcast_target,
)
from nexus.services.podcasts.subscriptions import unsubscribe_from_podcast
from tests.testkit.auth import UserRecord


def _seed_saved_article(db: Session, *, viewer_id: UUID) -> UUID:
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Canonical placement proof",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=viewer_id,
        )
    )
    db.flush()
    ensure_media_in_default_library(db, viewer_id, media_id)
    db.flush()
    return media_id


def _placements(client: TestClient, media_id: UUID) -> list[dict]:
    response = client.get(f"/media/{media_id}/libraries")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_media_placement_includes_typed_saved_in_nexus_destination(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id = _seed_saved_article(db_session, viewer_id=test_user.id)

    placements = _placements(authenticated_client, media_id)

    assert placements == [
        {
            "destination": {"kind": "SavedInNexus"},
            "relation": {"kind": "Direct"},
            "availability": {"kind": "Available"},
        }
    ]


def test_default_backed_saved_relation_can_be_removed_through_public_command(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id = _seed_saved_article(db_session, viewer_id=test_user.id)
    named_library_id = uuid4()
    created = authenticated_client.post(
        "/libraries",
        json={"library_id": str(named_library_id), "name": "Retaining Library"},
    )
    assert created.status_code == 201, created.text
    added = authenticated_client.post(
        f"/media/{media_id}/libraries",
        json={"library_ids": [str(named_library_id)]},
    )
    assert added.status_code == 204, added.text

    removed = authenticated_client.delete(f"/media/{media_id}/saved-in-nexus")

    assert removed.status_code == 200, removed.text
    placements = _placements(authenticated_client, media_id)
    saved = next(row for row in placements if row["destination"]["kind"] == "SavedInNexus")
    named = next(
        row
        for row in placements
        if row["destination"]
        == {
            "kind": "Library",
            "library": {
                "id": str(named_library_id),
                "name": "Retaining Library",
                "color": None,
            },
        }
    )
    assert saved["relation"] == {"kind": "Absent"}
    assert named["relation"] == {"kind": "Direct"}

    added_saved = authenticated_client.put(f"/media/{media_id}/saved-in-nexus")
    assert added_saved.status_code == 204, added_saved.text
    saved_after_add = next(
        row
        for row in _placements(authenticated_client, media_id)
        if row["destination"]["kind"] == "SavedInNexus"
    )
    assert saved_after_add["relation"] == {"kind": "Direct"}


def test_episode_placement_reports_inherited_and_system_provenance(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    podcast_id = uuid4()
    media_id = uuid4()
    named_library_id = uuid4()
    system_library_id = uuid4()
    db_session.add(
        Podcast(
            id=podcast_id,
            provider="test",
            provider_podcast_id=str(uuid4()),
            title="Placement parent",
            feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
        )
    )
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.podcast_episode.value,
            title="Inherited episode",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    db_session.add(PodcastEpisode(media_id=media_id, podcast_id=podcast_id))
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    created = authenticated_client.post(
        "/libraries",
        json={"library_id": str(named_library_id), "name": "Parent placement"},
    )
    assert created.status_code == 201, created.text
    ensure_entry(db_session, named_library_id, podcast_target(podcast_id))
    db_session.add(
        Library(
            id=system_library_id,
            owner_user_id=test_user.id,
            name="System corpus",
            system_key=f"placement-proof-{uuid4()}",
        )
    )
    db_session.flush()
    db_session.add(Membership(library_id=system_library_id, user_id=test_user.id, role="admin"))
    ensure_entry(db_session, system_library_id, media_target(media_id))
    db_session.flush()

    placements = _placements(authenticated_client, media_id)
    named = next(
        row
        for row in placements
        if row["destination"].get("library", {}).get("id") == str(named_library_id)
    )
    system = next(
        row
        for row in placements
        if row["destination"].get("library", {}).get("id") == str(system_library_id)
    )

    assert named["relation"] == {
        "kind": "Inherited",
        "provenance": [
            {
                "id": str(named_library_id),
                "name": "Parent placement",
                "color": None,
            }
        ],
    }
    assert named["availability"] == {"kind": "Blocked", "reason": "Inherited"}
    assert system["relation"] == {"kind": "Direct"}
    assert system["availability"] == {
        "kind": "Blocked",
        "reason": "SystemManaged",
    }


def test_unsubscribed_podcast_has_no_saved_destination_and_explains_placement_block(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    podcast_id = uuid4()
    named_library_id = uuid4()
    db_session.add(
        Podcast(
            id=podcast_id,
            provider="test",
            provider_podcast_id=str(uuid4()),
            title="Unsubscribed placement proof",
            feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
        )
    )
    db_session.flush()
    created = authenticated_client.post(
        "/libraries",
        json={"library_id": str(named_library_id), "name": "Podcast destination"},
    )
    assert created.status_code == 201, created.text

    placements = [
        row.model_dump(mode="json", by_alias=True)
        for row in list_item_libraries(
            db_session,
            viewer_id=test_user.id,
            target=podcast_target(podcast_id),
        )
    ]

    assert all(row["destination"]["kind"] != "SavedInNexus" for row in placements)
    assert placements == [
        {
            "destination": {
                "kind": "Library",
                "library": {
                    "id": str(named_library_id),
                    "name": "Podcast destination",
                    "color": None,
                },
            },
            "relation": {"kind": "Absent"},
            "availability": {
                "kind": "Blocked",
                "reason": "RequiresSubscription",
            },
        }
    ]


def test_subscribed_podcast_can_be_added_to_one_named_library_without_resubscribing(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    podcast_id = uuid4()
    library_id = uuid4()
    db_session.add(
        Podcast(
            id=podcast_id,
            provider="test",
            provider_podcast_id=str(uuid4()),
            title="Subscribed placement proof",
            feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
        )
    )
    db_session.add(
        PodcastSubscription(
            id=uuid4(),
            user_id=test_user.id,
            podcast_id=podcast_id,
            next_sync_at=datetime.now(UTC),
        )
    )
    db_session.flush()
    created = authenticated_client.post(
        "/libraries",
        json={"library_id": str(library_id), "name": "Subscribed destination"},
    )
    assert created.status_code == 201, created.text

    added = authenticated_client.put(
        f"/libraries/{library_id}/podcasts/{podcast_id}",
        headers={"Idempotency-Key": str(uuid4())},
    )

    assert added.status_code == 200, added.text
    assert set(added.json()["data"]) == {
        "outcome",
        "libraryEntriesCollectionRevision",
    }
    assert added.json()["data"]["outcome"] == "Added"
    placements = authenticated_client.get(f"/podcasts/{podcast_id}/libraries")
    assert placements.status_code == 200, placements.text
    assert placements.json()["data"] == [
        {
            "destination": {
                "kind": "Library",
                "library": {
                    "id": str(library_id),
                    "name": "Subscribed destination",
                    "color": None,
                },
            },
            "relation": {"kind": "Direct"},
            "availability": {"kind": "Available"},
        }
    ]


def test_podcast_placement_reauthorizes_subscription_after_available_inventory(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    podcast_id = uuid4()
    library_id = uuid4()
    db_session.add(
        Podcast(
            id=podcast_id,
            provider="test",
            provider_podcast_id=str(uuid4()),
            title="Stale placement proof",
            feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
        )
    )
    db_session.add(
        PodcastSubscription(
            id=uuid4(),
            user_id=test_user.id,
            podcast_id=podcast_id,
            next_sync_at=datetime.now(UTC),
        )
    )
    db_session.flush()
    created = authenticated_client.post(
        "/libraries",
        json={"library_id": str(library_id), "name": "Race destination"},
    )
    assert created.status_code == 201, created.text
    before = authenticated_client.get(f"/podcasts/{podcast_id}/libraries")
    assert before.status_code == 200, before.text
    assert before.json()["data"][0]["availability"] == {"kind": "Available"}

    # This proof runs with the optional provider-backed Podcast router disabled;
    # change the authoritative subscription through its domain command, then
    # prove the always-available Library placement API reauthorizes that state.
    unsubscribe_from_podcast(
        db_session,
        test_user.id,
        podcast_id,
        idempotency_key=str(uuid4()),
    )
    stale_add = authenticated_client.put(
        f"/libraries/{library_id}/podcasts/{podcast_id}",
        headers={"Idempotency-Key": str(uuid4())},
    )

    assert stale_add.status_code == 409, stale_add.text
    assert stale_add.json()["error"]["code"] == "E_PODCAST_SUBSCRIPTION_REQUIRED"
    after = authenticated_client.get(f"/podcasts/{podcast_id}/libraries")
    assert after.status_code == 200, after.text
    assert after.json()["data"][0]["relation"] == {"kind": "Absent"}
    assert after.json()["data"][0]["availability"] == {
        "kind": "Blocked",
        "reason": "RequiresSubscription",
    }
