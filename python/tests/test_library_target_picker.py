from uuid import UUID

import pytest
from sqlalchemy import text

from tests.factories import (
    add_library_member,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"bootstrap failed for user {user_id}: {response.status_code} {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


class TestLibraryTargetPickerOptions:
    def test_get_media_libraries_returns_current_membership_options(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, other_owner_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Picker Media")
            owned_in_library_id = create_test_library(session, viewer_id, "Owned In")
            owned_out_library_id = create_test_library(session, viewer_id, "Owned Out")
            shared_member_library_id = create_test_library(session, other_owner_id, "Shared Member")
            add_library_member(session, shared_member_library_id, viewer_id, role="member")

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("libraries", "id", owned_in_library_id)
        direct_db.register_cleanup("memberships", "library_id", owned_in_library_id)
        direct_db.register_cleanup("libraries", "id", owned_out_library_id)
        direct_db.register_cleanup("memberships", "library_id", owned_out_library_id)
        direct_db.register_cleanup("libraries", "id", shared_member_library_id)
        direct_db.register_cleanup("memberships", "library_id", shared_member_library_id)

        attach_response = auth_client.post(
            f"/libraries/{owned_in_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(viewer_id),
        )
        assert attach_response.status_code == 201, (
            "media setup attach failed unexpectedly: "
            f"{attach_response.status_code} {attach_response.text}"
        )

        response = auth_client.get(
            f"/media/{media_id}/libraries",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200, (
            f"media picker read failed unexpectedly: {response.status_code} {response.text}"
        )
        rows = {UUID(row["id"]): row for row in response.json()["data"]}

        assert default_library_id not in rows
        assert set(rows) == {
            owned_in_library_id,
            owned_out_library_id,
            shared_member_library_id,
        }
        assert rows[owned_in_library_id] == {
            "id": str(owned_in_library_id),
            "name": "Owned In",
            "color": None,
            "is_in_library": True,
            "can_add": False,
            "can_remove": True,
        }
        assert rows[owned_out_library_id] == {
            "id": str(owned_out_library_id),
            "name": "Owned Out",
            "color": None,
            "is_in_library": False,
            "can_add": True,
            "can_remove": False,
        }
        assert rows[shared_member_library_id] == {
            "id": str(shared_member_library_id),
            "name": "Shared Member",
            "color": None,
            "is_in_library": False,
            "can_add": False,
            "can_remove": False,
        }

    def test_get_podcast_libraries_returns_current_membership_options(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, other_owner_id)

        with direct_db.session() as session:
            owned_in_library_id = create_test_library(session, viewer_id, "Podcast Owned In")
            owned_out_library_id = create_test_library(session, viewer_id, "Podcast Owned Out")
            shared_member_library_id = create_test_library(
                session,
                other_owner_id,
                "Podcast Shared Member",
            )
            add_library_member(session, shared_member_library_id, viewer_id, role="member")

        direct_db.register_cleanup("libraries", "id", owned_in_library_id)
        direct_db.register_cleanup("memberships", "library_id", owned_in_library_id)
        direct_db.register_cleanup("libraries", "id", owned_out_library_id)
        direct_db.register_cleanup("memberships", "library_id", owned_out_library_id)
        direct_db.register_cleanup("libraries", "id", shared_member_library_id)
        direct_db.register_cleanup("memberships", "library_id", shared_member_library_id)

        subscribe_response = auth_client.post(
            "/podcasts/subscriptions",
            json={
                "provider_podcast_id": "picker-read-target",
                "title": "Picker Read Podcast",
                "contributors": [
                    {
                        "credited_name": "Nexus",
                        "role": "author",
                        "source": "test",
                    }
                ],
                "feed_url": "https://feeds.example.com/picker-read.xml",
                "website_url": "https://example.com/picker-read",
                "image_url": "https://example.com/picker-read.png",
                "description": "Podcast picker read test",
                "library_id": str(owned_in_library_id),
            },
            headers=auth_headers(viewer_id),
        )

        assert subscribe_response.status_code == 200, (
            "podcast setup subscribe failed unexpectedly: "
            f"{subscribe_response.status_code} {subscribe_response.text}"
        )
        podcast_id = UUID(subscribe_response.json()["data"]["podcast_id"])

        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)

        with direct_db.session() as session:
            job_ids = session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE kind = 'podcast_sync_subscription_job'
                      AND payload->>'user_id' = :user_id
                      AND payload->>'podcast_id' = :podcast_id
                    """
                ),
                {"user_id": str(viewer_id), "podcast_id": str(podcast_id)},
            ).fetchall()

        for job_id in job_ids:
            direct_db.register_cleanup("background_jobs", "id", job_id[0])

        response = auth_client.get(
            f"/podcasts/{podcast_id}/libraries",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200, (
            f"podcast picker read failed unexpectedly: {response.status_code} {response.text}"
        )
        rows = {UUID(row["id"]): row for row in response.json()["data"]}

        assert default_library_id not in rows
        assert set(rows) == {
            owned_in_library_id,
            owned_out_library_id,
            shared_member_library_id,
        }
        assert rows[owned_in_library_id] == {
            "id": str(owned_in_library_id),
            "name": "Podcast Owned In",
            "color": None,
            "is_in_library": True,
            "can_add": False,
            "can_remove": True,
        }
        assert rows[owned_out_library_id] == {
            "id": str(owned_out_library_id),
            "name": "Podcast Owned Out",
            "color": None,
            "is_in_library": False,
            "can_add": True,
            "can_remove": False,
        }
        assert rows[shared_member_library_id] == {
            "id": str(shared_member_library_id),
            "name": "Podcast Shared Member",
            "color": None,
            "is_in_library": False,
            "can_add": False,
            "can_remove": False,
        }
