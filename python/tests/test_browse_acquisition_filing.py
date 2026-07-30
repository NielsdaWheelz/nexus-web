"""Real-DB/API proof for §12 parent/child Podcast filing and Unsubscribe replay.

Covers the acquisition-filing acceptance criteria the cutover left unproven:

- AC10 / §5.2: the batch Subscribe command's typed
  ``E_PODCAST_REPLACES_EPISODES`` 409 (payload shape, no-write on absent/stale
  fingerprint, one-way compaction under a confirming fingerprint, and a fresh
  409 when the child set changes between conflict and confirmation).
- AC11 / §6.2: every generic episode-Media filing entry point returns
  ``IncludedThroughPodcast`` and writes no child row when the destination
  Library already holds the parent Podcast (via ``POST
  /podcast-episodes/from-discovery`` and via ``ensure_media_in_library``).
- §12 / AC14: Unsubscribe idempotent replay returns the frozen response, applies
  the domain side effect and its queue-owner revocation round-trip exactly once,
  and an absent subscription reports ``AlreadyUnsubscribed``.

Each test runs against the real migrated Postgres schema.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, Podcast, PodcastEpisode, ProcessingStatus
from nexus.jobs.queue import enqueue_job
from nexus.services import bootstrap, library_entries
from nexus.services.browse.models import episode_target, podcast_target, seal_target
from nexus.services.podcasts.control_replay import PODCAST_CONTROL_REPLAY_SCOPE
from tests.factories import (
    add_media_to_library,
    add_test_podcast_subscription,
    create_test_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Seeding helpers
# ---------------------------------------------------------------------------


def _feed_url(provider_podcast_id: str) -> str:
    return f"https://feeds.example.com/{provider_podcast_id}.xml"


def _seed_podcast(session: Session, *, provider_podcast_id: str, title: str) -> UUID:
    podcast_id = uuid4()
    session.add(
        Podcast(
            id=podcast_id,
            provider="podcast_index",
            provider_podcast_id=provider_podcast_id,
            title=title,
            feed_url=_feed_url(provider_podcast_id),
            image_url="https://img.example.com/show.jpg",
        )
    )
    session.flush()
    return podcast_id


def _seed_episode_media(session: Session, *, podcast_id: UUID, title: str) -> UUID:
    media_id = uuid4()
    episode_ref = f"episode-{media_id}"
    session.add(
        Media(
            id=media_id,
            kind=MediaKind.podcast_episode.value,
            title=title,
            canonical_source_url=f"https://example.com/{episode_ref}",
            external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
            provider="podcast_index",
            provider_id=episode_ref,
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    session.add(
        PodcastEpisode(
            media_id=media_id,
            podcast_id=podcast_id,
            published_at="2026-03-22T00:00:00Z",
            duration_seconds=600,
        )
    )
    session.flush()
    return media_id


def _seed_web_article(session: Session, *, title: str) -> UUID:
    media_id = uuid4()
    session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title=title,
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    session.flush()
    return media_id


def _register_podcast_fixture_cleanup(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    default_library_id: UUID,
    named_library_ids: tuple[UUID, ...],
    podcast_id: UUID,
) -> None:
    """Register cleanup in the LIFO order the non-cascading FKs require.

    ``users`` is registered first so it is deleted last; the podcast entries and
    subscription rows (non-cascading FKs to ``podcasts``) are registered after
    ``podcasts`` so they are deleted first. Library drops cascade their
    ``library_entries``; the podcast drop cascades ``podcast_episodes``.
    """
    direct_db.register_cleanup("users", "id", user_id)
    for library_id in (default_library_id, *named_library_ids):
        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
    direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)


def _library_rows(session: Session, library_id: UUID) -> list[tuple[UUID | None, UUID | None, int]]:
    return [
        (
            UUID(str(row[0])) if row[0] is not None else None,
            UUID(str(row[1])) if row[1] is not None else None,
            int(row[2]),
        )
        for row in session.execute(
            text(
                """
                SELECT media_id, podcast_id, position
                FROM library_entries
                WHERE library_id = :library_id
                ORDER BY position ASC
                """
            ),
            {"library_id": library_id},
        ).all()
    ]


def _subscription_exists(session: Session, *, user_id: UUID, podcast_id: UUID) -> bool:
    return (
        session.execute(
            text(
                """
                SELECT 1
                FROM podcast_subscriptions
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                """
            ),
            {"user_id": user_id, "podcast_id": podcast_id},
        ).first()
        is not None
    )


def _entry_count(
    session: Session,
    *,
    library_id: UUID,
    media_id: UUID | None = None,
    podcast_id: UUID | None = None,
) -> int:
    if media_id is not None:
        column, value = "media_id", media_id
    else:
        assert podcast_id is not None
        column, value = "podcast_id", podcast_id
    return int(
        session.execute(
            text(
                f"""
                SELECT count(*)
                FROM library_entries
                WHERE library_id = :library_id AND {column} = :value
                """
            ),
            {"library_id": library_id, "value": value},
        ).scalar_one()
    )


# ---------------------------------------------------------------------------
# Parent-over-child conflict (AC10 / §5.2 409)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _ConflictFixture:
    user_id: UUID
    default_library_id: UUID
    named_library_id: UUID
    named_library_name: str
    provider_podcast_id: str
    podcast_id: UUID
    head_media_id: UUID
    tail_media_id: UUID
    episode_media_ids: tuple[UUID, ...]


def _build_conflict_fixture(
    auth_client,
    direct_db: DirectSessionManager,
    *,
    episode_count: int,
) -> _ConflictFixture:
    """Seed a named Library holding filler + direct child-episode entries whose
    parent Podcast is not yet placed. Order in the Library is
    ``head, episode..., tail`` at dense positions ``0..n+1``."""
    user_id = create_test_user_id()
    bootstrap_response = auth_client.get("/me", headers=auth_headers(user_id))
    assert bootstrap_response.status_code == 200, bootstrap_response.text
    default_library_id = UUID(bootstrap_response.json()["data"]["default_library_id"])

    provider_podcast_id = f"conflict-{uuid4()}"
    named_library_name = "Conflict Destination"
    with direct_db.session() as session:
        named_library_id = create_test_library(session, user_id, named_library_name)
        podcast_id = _seed_podcast(
            session,
            provider_podcast_id=provider_podcast_id,
            title="Conflict Show",
        )
        head_media_id = _seed_web_article(session, title="Head Filler")
        episode_media_ids = tuple(
            _seed_episode_media(session, podcast_id=podcast_id, title=f"Child Episode {index}")
            for index in range(episode_count)
        )
        tail_media_id = _seed_web_article(session, title="Tail Filler")
        add_media_to_library(session, named_library_id, head_media_id)
        for episode_media_id in episode_media_ids:
            add_media_to_library(session, named_library_id, episode_media_id)
        add_media_to_library(session, named_library_id, tail_media_id)
        session.commit()

    _register_podcast_fixture_cleanup(
        direct_db,
        user_id=user_id,
        default_library_id=default_library_id,
        named_library_ids=(named_library_id,),
        podcast_id=podcast_id,
    )
    return _ConflictFixture(
        user_id=user_id,
        default_library_id=default_library_id,
        named_library_id=named_library_id,
        named_library_name=named_library_name,
        provider_podcast_id=provider_podcast_id,
        podcast_id=podcast_id,
        head_media_id=head_media_id,
        tail_media_id=tail_media_id,
        episode_media_ids=episode_media_ids,
    )


def _mock_browse_feed(monkeypatch, *, provider_podcast_id: str) -> None:
    monkeypatch.setattr(
        "nexus.services.podcasts.provider.PodcastIndexClient.browse_podcast_payload",
        lambda _self, _ref: {
            "feed": {
                "id": provider_podcast_id,
                "title": "Conflict Show",
                "url": _feed_url(provider_podcast_id),
                "author": "The Author",
                "link": None,
                "image": None,
                "description": None,
            }
        },
    )


def _subscribe_body(
    *,
    provider_podcast_id: str,
    named_library_ids: list[UUID],
    confirmation: str | None,
) -> dict[str, object]:
    return {
        "target": {
            "kind": "Discovery",
            "target": str(seal_target(podcast_target(provider_podcast_id))),
        },
        "namedLibraryIds": [str(library_id) for library_id in named_library_ids],
        "replacementConfirmation": (
            {"kind": "Present", "value": {"conflictFingerprint": confirmation}}
            if confirmation is not None
            else {"kind": "Absent"}
        ),
    }


def _post_subscribe(auth_client, fixture: _ConflictFixture, *, confirmation: str | None):
    return auth_client.post(
        "/podcasts/subscriptions",
        json=_subscribe_body(
            provider_podcast_id=fixture.provider_podcast_id,
            named_library_ids=[fixture.named_library_id],
            confirmation=confirmation,
        ),
        headers={
            **auth_headers(fixture.user_id),
            "Idempotency-Key": f"conflict-subscribe-{uuid4()}",
        },
    )


class TestParentOverChildConflict:
    """Batch Subscribe placing a Podcast over its direct child episodes (§5.2)."""

    def test_absent_and_stale_fingerprint_return_409_and_write_nothing(
        self, auth_client, direct_db, monkeypatch
    ):
        fixture = _build_conflict_fixture(auth_client, direct_db, episode_count=2)
        _mock_browse_feed(monkeypatch, provider_podcast_id=fixture.provider_podcast_id)

        original_rows = [
            (fixture.head_media_id, None, 0),
            (fixture.episode_media_ids[0], None, 1),
            (fixture.episode_media_ids[1], None, 2),
            (fixture.tail_media_id, None, 3),
        ]

        absent = _post_subscribe(auth_client, fixture, confirmation=None)
        assert absent.status_code == 409, absent.text
        error = absent.json()["error"]
        assert error["code"] == "E_PODCAST_REPLACES_EPISODES"
        details = error["details"]
        assert details["conflicts"] == [
            {
                "libraryId": str(fixture.named_library_id),
                "libraryName": fixture.named_library_name,
                "episodeCount": 2,
            }
        ]
        fingerprint = details["conflictFingerprint"]
        assert len(fingerprint) == 64
        assert all(character in "0123456789abcdef" for character in fingerprint)

        stale = _post_subscribe(auth_client, fixture, confirmation="0" * 64)
        assert stale.status_code == 409, stale.text
        stale_details = stale.json()["error"]["details"]
        # An unchanged child set recomputes the same fingerprint under the lock.
        assert stale_details["conflictFingerprint"] == fingerprint
        assert stale_details["conflicts"] == details["conflicts"]

        with direct_db.session() as session:
            assert not _subscription_exists(
                session, user_id=fixture.user_id, podcast_id=fixture.podcast_id
            )
            assert _library_rows(session, fixture.named_library_id) == original_rows
            assert (
                _entry_count(
                    session, library_id=fixture.named_library_id, podcast_id=fixture.podcast_id
                )
                == 0
            )
            for episode_media_id in fixture.episode_media_ids:
                assert (
                    _entry_count(
                        session, library_id=fixture.default_library_id, media_id=episode_media_id
                    )
                    == 0
                )
            replay_records = session.execute(
                text(
                    """
                    SELECT count(*)
                    FROM resource_mutations
                    WHERE user_id = :user_id AND mutation_scope = :scope
                    """
                ),
                {"user_id": fixture.user_id, "scope": PODCAST_CONTROL_REPLAY_SCOPE},
            ).scalar_one()
            assert replay_records == 0

    def test_confirming_fingerprint_compacts_children_at_earliest_position(
        self, auth_client, direct_db, monkeypatch
    ):
        fixture = _build_conflict_fixture(auth_client, direct_db, episode_count=2)
        _mock_browse_feed(monkeypatch, provider_podcast_id=fixture.provider_podcast_id)

        conflict = _post_subscribe(auth_client, fixture, confirmation=None)
        assert conflict.status_code == 409, conflict.text
        fingerprint = conflict.json()["error"]["details"]["conflictFingerprint"]

        confirmed = _post_subscribe(auth_client, fixture, confirmation=fingerprint)
        assert confirmed.status_code == 200, confirmed.text
        confirmed_data = confirmed.json()["data"]
        assert confirmed_data["outcome"] == "Subscribed"

        with direct_db.session() as session:
            assert _subscription_exists(
                session, user_id=fixture.user_id, podcast_id=fixture.podcast_id
            )
            # The Podcast entry lands at the earliest removed child position (1),
            # between the head (0) and tail fillers, and positions renormalize to
            # a dense 0..n-1.
            assert _library_rows(session, fixture.named_library_id) == [
                (fixture.head_media_id, None, 0),
                (None, fixture.podcast_id, 1),
                (fixture.tail_media_id, None, 2),
            ]
            for episode_media_id in fixture.episode_media_ids:
                assert (
                    _entry_count(
                        session, library_id=fixture.named_library_id, media_id=episode_media_id
                    )
                    == 0
                )
                # Removed children survive as direct Default entries.
                assert (
                    _entry_count(
                        session, library_id=fixture.default_library_id, media_id=episode_media_id
                    )
                    == 1
                )

    def test_changed_child_set_between_conflict_and_confirm_returns_fresh_409(
        self, auth_client, direct_db, monkeypatch
    ):
        fixture = _build_conflict_fixture(auth_client, direct_db, episode_count=2)
        _mock_browse_feed(monkeypatch, provider_podcast_id=fixture.provider_podcast_id)

        conflict = _post_subscribe(auth_client, fixture, confirmation=None)
        assert conflict.status_code == 409, conflict.text
        stale_fingerprint = conflict.json()["error"]["details"]["conflictFingerprint"]

        # The child set shrinks between the 409 and the confirmation: one direct
        # episode entry leaves the named Library.
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    DELETE FROM library_entries
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {
                    "library_id": fixture.named_library_id,
                    "media_id": fixture.episode_media_ids[1],
                },
            )
            session.commit()

        confirmed = _post_subscribe(auth_client, fixture, confirmation=stale_fingerprint)
        assert confirmed.status_code == 409, confirmed.text
        fresh_details = confirmed.json()["error"]["details"]
        assert fresh_details["conflicts"] == [
            {
                "libraryId": str(fixture.named_library_id),
                "libraryName": fixture.named_library_name,
                "episodeCount": 1,
            }
        ]
        assert fresh_details["conflictFingerprint"] != stale_fingerprint

        with direct_db.session() as session:
            assert not _subscription_exists(
                session, user_id=fixture.user_id, podcast_id=fixture.podcast_id
            )
            assert (
                _entry_count(
                    session, library_id=fixture.named_library_id, podcast_id=fixture.podcast_id
                )
                == 0
            )
            # The still-present child was not compacted.
            assert (
                _entry_count(
                    session,
                    library_id=fixture.named_library_id,
                    media_id=fixture.episode_media_ids[0],
                )
                == 1
            )


# ---------------------------------------------------------------------------
# IncludedThroughPodcast filing (AC11 / §6.2)
# ---------------------------------------------------------------------------


class TestIncludedThroughPodcastFiling:
    """Filing an episode into a Library already holding its parent Podcast."""

    def test_from_discovery_files_included_through_podcast(
        self, auth_client, direct_db, monkeypatch
    ):
        user_id = create_test_user_id()
        bootstrap_response = auth_client.get("/me", headers=auth_headers(user_id))
        assert bootstrap_response.status_code == 200, bootstrap_response.text
        default_library_id = UUID(bootstrap_response.json()["data"]["default_library_id"])

        provider_podcast_id = f"itp-discovery-{uuid4()}"
        episode_ref = f"itp-episode-{uuid4()}"
        with direct_db.session() as session:
            named_library_id = create_test_library(session, user_id, "Parent-Held Library")
            podcast_id = _seed_podcast(
                session,
                provider_podcast_id=provider_podcast_id,
                title="Parent Show",
            )
            # The parent Podcast already occupies the named Library.
            library_entries.ensure_entry(
                session, named_library_id, library_entries.podcast_target(podcast_id)
            )
            session.commit()

        _register_podcast_fixture_cleanup(
            direct_db,
            user_id=user_id,
            default_library_id=default_library_id,
            named_library_ids=(named_library_id,),
            podcast_id=podcast_id,
        )

        _mock_browse_feed(monkeypatch, provider_podcast_id=provider_podcast_id)
        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.browse_episode_payload",
            lambda _self, _ref: {
                "episode": {
                    "id": episode_ref,
                    "feedId": provider_podcast_id,
                    "title": "Included Episode",
                    "enclosureUrl": "https://cdn.example.com/itp-episode.mp3",
                    "guid": f"guid-{episode_ref}",
                    "datePublished": 1_700_000_000,
                    "duration": 600,
                }
            },
        )

        response = auth_client.post(
            "/podcast-episodes/from-discovery",
            json={
                "target": str(seal_target(episode_target(provider_podcast_id, episode_ref))),
                "namedLibraryIds": [str(named_library_id)],
            },
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": f"itp-discovery-{uuid4()}",
            },
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["destinationOutcomes"] == [
            {
                "libraryId": str(named_library_id),
                "outcome": "IncludedThroughPodcast",
            }
        ]
        media_id = UUID(data["mediaId"])

        with direct_db.session() as session:
            # No child Media row is created in the parent-held Library.
            assert _entry_count(session, library_id=named_library_id, media_id=media_id) == 0
            # Only the parent Podcast row remains there.
            assert _entry_count(session, library_id=named_library_id, podcast_id=podcast_id) == 1
            # The episode still projects through Default.
            assert _entry_count(session, library_id=default_library_id, media_id=media_id) == 1

    def test_ensure_media_in_library_returns_included_through_podcast(self, direct_db):
        user_id = create_test_user_id()
        provider_podcast_id = f"itp-ensure-{uuid4()}"
        with direct_db.session() as session:
            default_library_id = bootstrap.ensure_user_and_default_library(session, user_id)
            named_library_id = create_test_library(session, user_id, "Ensure Parent-Held")
            podcast_id = _seed_podcast(
                session,
                provider_podcast_id=provider_podcast_id,
                title="Ensure Parent Show",
            )
            episode_media_id = _seed_episode_media(
                session, podcast_id=podcast_id, title="Ensure Episode"
            )
            # The media is reachable through Default (mirrors ingest auto-file).
            add_media_to_library(session, default_library_id, episode_media_id)
            # The parent Podcast already occupies the named Library.
            library_entries.ensure_entry(
                session, named_library_id, library_entries.podcast_target(podcast_id)
            )
            session.commit()

        _register_podcast_fixture_cleanup(
            direct_db,
            user_id=user_id,
            default_library_id=default_library_id,
            named_library_ids=(named_library_id,),
            podcast_id=podcast_id,
        )

        with direct_db.session() as session:
            outcome = library_entries.ensure_media_in_library(
                session, user_id, named_library_id, episode_media_id
            )
        assert outcome.kind == "IncludedThroughPodcast"

        with direct_db.session() as session:
            assert (
                _entry_count(session, library_id=named_library_id, media_id=episode_media_id) == 0
            )
            assert _entry_count(session, library_id=named_library_id, podcast_id=podcast_id) == 1
            assert (
                _entry_count(session, library_id=default_library_id, media_id=episode_media_id) == 1
            )


# ---------------------------------------------------------------------------
# Unsubscribe idempotent replay (§12 / AC14)
# ---------------------------------------------------------------------------


class TestUnsubscribeReplay:
    """Frozen-response replay and once-only queue revocation for Unsubscribe."""

    def test_unsubscribe_replay_is_frozen_and_revokes_jobs_once(self, auth_client, direct_db):
        user_id = create_test_user_id()
        provider_podcast_id = f"unsub-replay-{uuid4()}"
        with direct_db.session() as session:
            default_library_id = bootstrap.ensure_user_and_default_library(session, user_id)
            podcast_id = _seed_podcast(
                session,
                provider_podcast_id=provider_podcast_id,
                title="Unsubscribe Replay Show",
            )
            subscription_id = add_test_podcast_subscription(
                session, user_id=user_id, podcast_id=podcast_id
            )
            backfill_id = UUID(
                str(
                    session.execute(
                        text(
                            """
                            SELECT id
                            FROM podcast_subscription_backfills
                            WHERE subscription_id = :subscription_id
                            """
                        ),
                        {"subscription_id": subscription_id},
                    ).scalar_one()
                )
            )
            # The live sync and backfill jobs the awaited revocation must reap.
            enqueue_job(
                session,
                kind="podcast_sync_subscription_job",
                payload={"user_id": str(user_id), "podcast_id": str(podcast_id)},
            )
            enqueue_job(
                session,
                kind="podcast_backfill_subscription",
                payload={"backfillId": str(backfill_id)},
            )
            session.commit()

        _register_podcast_fixture_cleanup(
            direct_db,
            user_id=user_id,
            default_library_id=default_library_id,
            named_library_ids=(),
            podcast_id=podcast_id,
        )

        mutation_key = f"unsubscribe-replay-{uuid4()}"
        headers = {**auth_headers(user_id), "Idempotency-Key": mutation_key}

        first = auth_client.delete(f"/podcasts/subscriptions/{podcast_id}", headers=headers)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert first_body["data"]["outcome"] == "Unsubscribed"

        with direct_db.session() as session:
            assert not _subscription_exists(session, user_id=user_id, podcast_id=podcast_id)
            assert (
                session.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM podcast_subscription_backfills
                        WHERE subscription_id = :subscription_id
                        """
                    ),
                    {"subscription_id": subscription_id},
                ).scalar_one()
                == 0
            )
            # The queue-owner revocation round-trip reaped both orphaned jobs.
            assert _job_count(session, kind="podcast_sync_subscription_job", user_id=user_id) == 0
            assert _backfill_job_count(session, backfill_id=backfill_id) == 0

        replay = auth_client.delete(f"/podcasts/subscriptions/{podcast_id}", headers=headers)
        assert replay.status_code == 200, replay.text
        # The replay returns the byte-identical frozen response.
        assert replay.json() == first_body

        with direct_db.session() as session:
            # No double side effect: the subscription stays gone and exactly one
            # replay record was written for the key.
            assert not _subscription_exists(session, user_id=user_id, podcast_id=podcast_id)
            assert _job_count(session, kind="podcast_sync_subscription_job", user_id=user_id) == 0
            assert (
                session.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM resource_mutations
                        WHERE user_id = :user_id
                          AND mutation_scope = :scope
                          AND client_mutation_id = :mutation_key
                        """
                    ),
                    {
                        "user_id": user_id,
                        "scope": PODCAST_CONTROL_REPLAY_SCOPE,
                        "mutation_key": mutation_key,
                    },
                ).scalar_one()
                == 1
            )

    def test_unsubscribe_absent_subscription_reports_already_unsubscribed(
        self, auth_client, direct_db
    ):
        user_id = create_test_user_id()
        provider_podcast_id = f"unsub-absent-{uuid4()}"
        with direct_db.session() as session:
            default_library_id = bootstrap.ensure_user_and_default_library(session, user_id)
            podcast_id = _seed_podcast(
                session,
                provider_podcast_id=provider_podcast_id,
                title="Never Subscribed Show",
            )
            session.commit()

        _register_podcast_fixture_cleanup(
            direct_db,
            user_id=user_id,
            default_library_id=default_library_id,
            named_library_ids=(),
            podcast_id=podcast_id,
        )

        response = auth_client.delete(
            f"/podcasts/subscriptions/{podcast_id}",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": f"unsubscribe-absent-{uuid4()}",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["outcome"] == "AlreadyUnsubscribed"


def _job_count(session: Session, *, kind: str, user_id: UUID) -> int:
    return int(
        session.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = :kind
                  AND payload @> CAST(:match AS jsonb)
                """
            ),
            {"kind": kind, "match": f'{{"user_id": "{user_id}"}}'},
        ).scalar_one()
    )


def _backfill_job_count(session: Session, *, backfill_id: UUID) -> int:
    return int(
        session.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = 'podcast_backfill_subscription'
                  AND payload @> CAST(:match AS jsonb)
                """
            ),
            {"match": f'{{"backfillId": "{backfill_id}"}}'},
        ).scalar_one()
    )
