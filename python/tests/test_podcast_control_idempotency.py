"""Real-Postgres proof for the shared Podcast control/replay protocol."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import bootstrap, library_entries
from nexus.services.browse.models import episode_target, seal_target
from nexus.services.podcasts import subscriptions
from nexus.services.podcasts.control_replay import PODCAST_CONTROL_REPLAY_SCOPE
from tests import factories
from tests.helpers import auth_headers
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


@dataclass(frozen=True, slots=True)
class _ControlFixture:
    viewer_id: UUID
    podcast_id: UUID
    library_id: UUID


def _seed_control_fixture(direct_db: DirectSessionManager) -> _ControlFixture:
    viewer_id = uuid4()
    podcast_id = uuid4()
    with direct_db.session() as db:
        default_library_id = bootstrap.ensure_user_and_default_library(db, viewer_id)
        library_id = factories.create_test_library(db, viewer_id, name="Podcast Controls")
        db.execute(
            text(
                """
                INSERT INTO podcasts (
                    id, provider, provider_podcast_id, title, feed_url
                )
                VALUES (
                    :podcast_id,
                    'podcast_index',
                    :provider_podcast_id,
                    'Control Protocol',
                    :feed_url
                )
                """
            ),
            {
                "podcast_id": podcast_id,
                "provider_podcast_id": f"control-{podcast_id}",
                "feed_url": f"https://example.com/{podcast_id}.xml",
            },
        )
        factories.add_test_podcast_subscription(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )
        library_entries.ensure_entry(
            db,
            library_id,
            library_entries.podcast_target(podcast_id),
        )
        db.commit()

    direct_db.register_cleanup("users", "id", viewer_id)
    for registered_library_id in (default_library_id, library_id):
        direct_db.register_cleanup("libraries", "id", registered_library_id)
        direct_db.register_cleanup("memberships", "library_id", registered_library_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
    direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
    direct_db.register_cleanup("resource_mutations", "user_id", viewer_id)
    return _ControlFixture(viewer_id, podcast_id, library_id)


def test_podcast_controls_share_one_key_namespace_and_bind_method_path(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch,
):
    fixture = _seed_control_fixture(direct_db)
    mutation_key = f"podcast-control-{uuid4()}"
    headers = {
        **auth_headers(fixture.viewer_id),
        "Idempotency-Key": mutation_key,
    }
    remove_path = f"/libraries/{fixture.library_id}/podcasts/{fixture.podcast_id}"

    first = auth_client.delete(remove_path, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["data"]["outcome"] == "Removed"
    exact_replay = auth_client.delete(remove_path, headers=headers)
    assert exact_replay.status_code == 200, exact_replay.text
    assert exact_replay.json() == first.json()

    def provider_call_is_a_defect(*_args, **_kwargs):
        raise AssertionError("idempotency mismatch must precede provider I/O")

    monkeypatch.setattr(
        "nexus.services.podcasts.provider.PodcastIndexClient.browse_podcast_payload",
        provider_call_is_a_defect,
    )
    monkeypatch.setattr(
        "nexus.services.podcasts.provider.PodcastIndexClient.browse_episode_payload",
        provider_call_is_a_defect,
    )
    episode_handle = str(seal_target(episode_target("never-resolve-show", "never-resolve-episode")))
    mismatches = [
        auth_client.post(
            "/podcast-episodes/from-discovery",
            json={"target": episode_handle, "namedLibraryIds": []},
            headers=headers,
        ),
        auth_client.post(
            "/podcasts/subscriptions",
            json={
                "target": {
                    "kind": "Canonical",
                    "podcastId": str(fixture.podcast_id),
                },
                "namedLibraryIds": [],
                "replacementConfirmation": {"kind": "Absent"},
            },
            headers=headers,
        ),
        auth_client.delete(
            f"/podcasts/subscriptions/{fixture.podcast_id}",
            headers=headers,
        ),
        auth_client.post(
            f"/podcasts/subscriptions/{fixture.podcast_id}/backfill/retry",
            headers=headers,
        ),
    ]
    for response in mismatches:
        assert response.status_code == 409, response.text
        assert response.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"


def test_same_key_concurrent_library_removal_replays_one_frozen_result(
    direct_db: DirectSessionManager,
):
    fixture = _seed_control_fixture(direct_db)
    mutation_key = f"podcast-remove-race-{uuid4()}"
    barrier = threading.Barrier(2)
    results = []
    errors: list[BaseException] = []

    def remove() -> None:
        try:
            with direct_db.session() as db:
                barrier.wait(timeout=10)
                results.append(
                    library_entries.remove_podcast_from_library(
                        db,
                        fixture.viewer_id,
                        fixture.library_id,
                        fixture.podcast_id,
                        idempotency_key=mutation_key,
                    )
                )
        except BaseException as exc:  # noqa: BLE001 - asserted by the parent thread
            errors.append(exc)

    workers = [threading.Thread(target=remove) for _ in range(2)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=20)
        assert not worker.is_alive(), "Podcast removal race deadlocked"

    assert errors == []
    assert [result.outcome for result in results] == ["Removed", "Removed"]
    assert len({result.library_entries_collection_revision for result in results}) == 1
    with direct_db.session() as db:
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND podcast_id = :podcast_id
                    """
                ),
                {
                    "library_id": fixture.library_id,
                    "podcast_id": fixture.podcast_id,
                },
            ).scalar_one()
            == 0
        )
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM resource_mutations
                    WHERE user_id = :viewer_id
                      AND mutation_scope = :scope
                      AND client_mutation_id = :mutation_key
                    """
                ),
                {
                    "viewer_id": fixture.viewer_id,
                    "scope": PODCAST_CONTROL_REPLAY_SCOPE,
                    "mutation_key": mutation_key,
                },
            ).scalar_one()
            == 1
        )


def test_unsubscribe_racing_agent_placement_converges_without_late_entry(
    direct_db: DirectSessionManager,
):
    fixture = _seed_control_fixture(direct_db)
    with direct_db.session() as db:
        db.execute(
            text(
                """
                DELETE FROM library_entries
                WHERE library_id = :library_id
                  AND podcast_id = :podcast_id
                """
            ),
            {
                "library_id": fixture.library_id,
                "podcast_id": fixture.podcast_id,
            },
        )
        db.commit()

    barrier = threading.Barrier(2)
    errors: list[BaseException] = []
    unsubscribe_outcomes = []

    def place() -> None:
        try:
            with direct_db.session() as db:
                barrier.wait(timeout=10)
                with transaction(db):
                    library_entries.place_subscribed_podcast_in_named_library_in_current_transaction(
                        db,
                        viewer_id=fixture.viewer_id,
                        library_id=fixture.library_id,
                        podcast_id=fixture.podcast_id,
                    )
        except ApiError as exc:
            if exc.code != ApiErrorCode.E_NOT_FOUND:
                errors.append(exc)
        except BaseException as exc:  # noqa: BLE001 - asserted by the parent thread
            errors.append(exc)

    def unsubscribe() -> None:
        try:
            with direct_db.session() as db:
                barrier.wait(timeout=10)
                unsubscribe_outcomes.append(
                    subscriptions.unsubscribe_from_podcast(
                        db,
                        fixture.viewer_id,
                        fixture.podcast_id,
                        idempotency_key=f"unsubscribe-race-{uuid4()}",
                    )
                )
        except BaseException as exc:  # noqa: BLE001 - asserted by the parent thread
            errors.append(exc)

    workers = [threading.Thread(target=place), threading.Thread(target=unsubscribe)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=20)
        assert not worker.is_alive(), "Podcast placement/unsubscribe race deadlocked"

    assert errors == []
    assert [outcome.outcome for outcome in unsubscribe_outcomes] == ["Unsubscribed"]
    with direct_db.session() as db:
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM podcast_subscriptions
                    WHERE user_id = :viewer_id
                      AND podcast_id = :podcast_id
                    """
                ),
                {
                    "viewer_id": fixture.viewer_id,
                    "podcast_id": fixture.podcast_id,
                },
            ).scalar_one()
            == 0
        )
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND podcast_id = :podcast_id
                    """
                ),
                {
                    "library_id": fixture.library_id,
                    "podcast_id": fixture.podcast_id,
                },
            ).scalar_one()
            == 0
        )
