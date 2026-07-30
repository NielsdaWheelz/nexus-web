"""Focused command-order and response-loss proof for the Podcast hard cutover."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4

from nexus.schemas.podcast import (
    PodcastBackfillOut,
    PodcastDiscoveryCommitTarget,
    PodcastEpisodeFromDiscoveryRequest,
    PodcastSubscribeRequest,
)
from nexus.schemas.presence import absent
from nexus.services.browse.models import ResolvedEpisode, ResolvedPodcast
from nexus.services.podcasts import backfill as backfill_service
from nexus.services.podcasts import episode_acquisition, subscriptions
from nexus.services.podcasts.backfill import cursor_digest
from nexus.services.podcasts.feed import FeedBackfillPage
from nexus.services.podcasts.ingest import SubscriptionIngestResult
from nexus.services.sealed_handles import DiscoveryTargetHandle


class _ReadOnlySession:
    def __init__(self) -> None:
        self.rollback_count = 0

    def rollback(self) -> None:
        self.rollback_count += 1


class _Rows:
    def __init__(self, row=None, *, rowcount: int = 0) -> None:
        self.row = row
        self.rowcount = rowcount

    def first(self):
        return self.row

    def mappings(self):
        return self


class _RetrySession(_ReadOnlySession):
    def __init__(self, *, failed: bool) -> None:
        super().__init__()
        self.failed = failed
        self.events: list[str] = []
        self.subscription_id = uuid4()
        self.backfill_id = uuid4()
        self.podcast_id = uuid4()
        self.cutoff = datetime(2026, 7, 29, tzinfo=UTC)

    def execute(self, statement, _params=None):
        sql = str(statement)
        if "SELECT subscription.id, backfill.id" in sql:
            return _Rows((self.subscription_id, self.backfill_id))
        if "SELECT cutoff_at, failed_at" in sql:
            self.events.append("backfill")
            return _Rows((self.cutoff, self.cutoff if self.failed else None))
        if "FROM podcast_subscriptions" in sql and "FOR UPDATE" in sql:
            self.events.append("subscription")
            return _Rows((1,))
        if "SELECT 1 FROM podcasts" in sql:
            self.events.append("podcast")
            return _Rows((1,))
        if "DELETE FROM podcast_subscription_backfills" in sql:
            self.events.append("delete")
            return _Rows(rowcount=1)
        raise AssertionError(f"unexpected retry SQL: {sql}")


class _BackfillSession(_ReadOnlySession):
    def __init__(self) -> None:
        super().__init__()
        self.events: list[str] = []
        self.subscription_id = uuid4()
        self.backfill_id = uuid4()
        self.podcast_id = uuid4()
        self.user_id = uuid4()
        self.cutoff = datetime(2026, 7, 29, tzinfo=UTC)

    def execute(self, statement, _params=None):
        sql = str(statement)
        row = {
            "subscription_id": self.subscription_id,
            "step_no": 0,
            "cursor": None,
            "cutoff_at": self.cutoff,
            "completed_at": None,
            "source_limited_at": None,
            "failed_at": None,
            "user_id": self.user_id,
            "podcast_id": self.podcast_id,
            "feed_url": "https://example.com/feed.xml",
        }
        if "FROM podcast_subscription_backfills backfill" in sql:
            if "FOR UPDATE OF backfill" in sql:
                self.events.append("backfill")
            return _Rows(row)
        if "FROM podcast_subscriptions" in sql and "FOR UPDATE" in sql:
            self.events.append("subscription")
            return _Rows((1,))
        if "UPDATE podcast_subscription_backfills" in sql:
            self.events.append("update")
            return _Rows(rowcount=1)
        raise AssertionError(f"unexpected backfill SQL: {sql}")

    def scalar(self, statement):
        assert "transaction_timestamp" in str(statement)
        return self.cutoff


def _subscribe_body() -> PodcastSubscribeRequest:
    target = PodcastDiscoveryCommitTarget.model_construct(
        target=DiscoveryTargetHandle("response-loss-podcast")
    )
    return PodcastSubscribeRequest.model_construct(
        target=target,
        named_library_ids=[],
        replacement_confirmation=absent(),
    )


def _episode_body() -> PodcastEpisodeFromDiscoveryRequest:
    return PodcastEpisodeFromDiscoveryRequest.model_construct(
        target=DiscoveryTargetHandle("response-loss-episode"),
        named_library_ids=[],
    )


def _subscribe_replay() -> dict[str, object]:
    return {
        "href": f"/podcasts/{uuid4()}",
        "podcastId": str(uuid4()),
        "outcome": "Subscribed",
        "destinations": [],
        "backfill": {
            "id": str(uuid4()),
            "state": "Pending",
            "processedCount": 0,
            "addedCount": 0,
        },
        "collectionRevision": 4,
        "libraryEntriesCollectionRevision": 7,
    }


def _episode_replay() -> dict[str, object]:
    media_id = uuid4()
    return {
        "href": f"/media/{media_id}",
        "mediaId": str(media_id),
        "destinationOutcomes": [],
        "collectionRevision": 9,
    }


def test_subscribe_response_loss_replays_before_provider_resolution(monkeypatch) -> None:
    db = _ReadOnlySession()
    provider_calls = 0

    def provider_gone(_target):
        nonlocal provider_calls
        provider_calls += 1
        raise AssertionError("provider resolution must not run for an exact replay")

    monkeypatch.setattr(
        subscriptions, "lookup_replay", lambda *_args, **_kwargs: _subscribe_replay()
    )
    monkeypatch.setattr(
        "nexus.services.browse.service.resolve_podcast_discovery_target",
        provider_gone,
    )

    out = subscriptions.subscribe_to_podcast(  # type: ignore[arg-type]
        db,
        uuid4(),
        _subscribe_body(),
        idempotency_key="lost-subscribe-response",
    )

    assert out.outcome == "Subscribed"
    assert provider_calls == 0
    assert db.rollback_count == 1


def test_episode_add_response_loss_replays_before_provider_resolution(monkeypatch) -> None:
    db = _ReadOnlySession()
    provider_calls = 0

    def provider_gone(_target):
        nonlocal provider_calls
        provider_calls += 1
        raise AssertionError("provider resolution must not run for an exact replay")

    monkeypatch.setattr(
        episode_acquisition,
        "lookup_replay",
        lambda *_args, **_kwargs: _episode_replay(),
    )
    monkeypatch.setattr(
        "nexus.services.browse.service.resolve_podcast_discovery_target",
        provider_gone,
    )

    out = episode_acquisition.acquire_episode_from_discovery(  # type: ignore[arg-type]
        db,
        viewer_id=uuid4(),
        body=_episode_body(),
        idempotency_key="lost-episode-response",
    )

    assert out.href.startswith("/media/")
    assert provider_calls == 0
    assert db.rollback_count == 1


def test_subscribe_rechecks_replay_after_relationship_lock(monkeypatch) -> None:
    db = _ReadOnlySession()
    events: list[str] = []
    lookups = iter([None, _subscribe_replay()])
    resolved = ResolvedPodcast(
        podcast_ref="show-1",
        title="Show",
        author=None,
        feed_url="https://example.com/feed.xml",
        website_url=None,
        image_url=None,
        description=None,
    )

    monkeypatch.setattr(subscriptions, "lookup_replay", lambda *_args, **_kwargs: next(lookups))
    monkeypatch.setattr(
        "nexus.services.browse.service.resolve_podcast_discovery_target",
        lambda _target: resolved,
    )
    monkeypatch.setattr(
        subscriptions,
        "_lock_subscription_command",
        lambda *_args, **_kwargs: events.append("relationship"),
    )
    monkeypatch.setattr(
        subscriptions,
        "_apply_resolved_subscription_relationship_in_current_transaction",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("domain mutation must not run after the locked replay hit")
        ),
    )
    monkeypatch.setattr(subscriptions, "retry_read_committed", lambda _db, _label, op: op())

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(subscriptions, "transaction", no_transaction)
    original_lookup = subscriptions.lookup_replay

    def ordered_lookup(*args, **kwargs):
        result = original_lookup(*args, **kwargs)
        if db.rollback_count:
            events.append("replay")
        return result

    monkeypatch.setattr(subscriptions, "lookup_replay", ordered_lookup)
    out = subscriptions.subscribe_to_podcast(  # type: ignore[arg-type]
        db,
        uuid4(),
        _subscribe_body(),
        idempotency_key="concurrent-subscribe",
    )

    assert out.outcome == "Subscribed"
    assert events == ["relationship", "replay"]


def test_episode_add_rechecks_replay_after_alias_lock(monkeypatch) -> None:
    db = _ReadOnlySession()
    events: list[str] = []
    lookups = iter([None, _episode_replay()])
    podcast = ResolvedPodcast(
        podcast_ref="show-1",
        title="Show",
        author=None,
        feed_url="https://example.com/feed.xml",
        website_url=None,
        image_url=None,
        description=None,
    )
    resolved = ResolvedEpisode(
        podcast_ref="show-1",
        episode_ref="episode-1",
        title="Episode",
        description=None,
        audio_url="https://example.com/episode.mp3",
        guid="guid-1",
        published_at=datetime(2026, 7, 29, tzinfo=UTC),
        duration_seconds=60,
        podcast=podcast,
    )

    monkeypatch.setattr(
        episode_acquisition,
        "lookup_replay",
        lambda *_args, **_kwargs: next(lookups),
    )
    monkeypatch.setattr(
        "nexus.services.browse.service.resolve_podcast_discovery_target",
        lambda _target: resolved,
    )
    monkeypatch.setattr(
        episode_acquisition,
        "lock_episode_aliases_for_podcast_identity",
        lambda *_args, **_kwargs: events.append("aliases"),
    )
    monkeypatch.setattr(
        episode_acquisition,
        "upsert_podcast",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("domain mutation must not run after the locked replay hit")
        ),
    )
    monkeypatch.setattr(
        episode_acquisition,
        "retry_read_committed",
        lambda _db, _label, op: op(),
    )

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(episode_acquisition, "transaction", no_transaction)
    original_lookup = episode_acquisition.lookup_replay

    def ordered_lookup(*args, **kwargs):
        result = original_lookup(*args, **kwargs)
        if db.rollback_count:
            events.append("replay")
        return result

    monkeypatch.setattr(episode_acquisition, "lookup_replay", ordered_lookup)
    out = episode_acquisition.acquire_episode_from_discovery(  # type: ignore[arg-type]
        db,
        viewer_id=uuid4(),
        body=_episode_body(),
        idempotency_key="concurrent-episode",
    )

    assert out.href.startswith("/media/")
    assert events == ["aliases", "replay"]


def test_failed_backfill_retry_replaces_one_fence_under_total_lock_order(monkeypatch) -> None:
    db = _RetrySession(failed=True)
    new_backfill_id = uuid4()

    monkeypatch.setattr(subscriptions, "lookup_replay", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        subscriptions,
        "_subscription_command_identity",
        lambda *_args, **_kwargs: "podcast_index:show",
    )
    monkeypatch.setattr(
        subscriptions,
        "_lock_subscription_command",
        lambda *_args, **_kwargs: db.events.append("relationship"),
    )
    monkeypatch.setattr(
        subscriptions,
        "seed_subscription_backfill_in_current_transaction",
        lambda *_args, **_kwargs: db.events.append("seed") or new_backfill_id,
    )
    monkeypatch.setattr(
        subscriptions,
        "_load_backfill_out",
        lambda *_args, **_kwargs: PodcastBackfillOut(
            id=new_backfill_id,
            state="Pending",
            processed_count=0,
            added_count=0,
        ),
    )
    monkeypatch.setattr(
        subscriptions,
        "record_replay",
        lambda *_args, **_kwargs: db.events.append("record"),
    )
    monkeypatch.setattr(subscriptions, "retry_read_committed", lambda _db, _label, op: op())

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(subscriptions, "transaction", no_transaction)
    out = subscriptions.retry_subscription_backfill(  # type: ignore[arg-type]
        db,
        uuid4(),
        db.podcast_id,
        idempotency_key="retry-failed-backfill",
    )

    assert out.outcome == "Retried"
    assert out.backfill.id == new_backfill_id
    assert "collectionRevision" not in out.model_dump(mode="json", by_alias=True)
    assert db.events == [
        "relationship",
        "backfill",
        "subscription",
        "podcast",
        "delete",
        "seed",
        "record",
    ]


def test_nonfailed_backfill_retry_is_closed_not_eligible(monkeypatch) -> None:
    db = _RetrySession(failed=False)

    monkeypatch.setattr(subscriptions, "lookup_replay", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        subscriptions,
        "_subscription_command_identity",
        lambda *_args, **_kwargs: "podcast_index:show",
    )
    monkeypatch.setattr(
        subscriptions,
        "_lock_subscription_command",
        lambda *_args, **_kwargs: db.events.append("relationship"),
    )
    monkeypatch.setattr(
        subscriptions,
        "seed_subscription_backfill_in_current_transaction",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("nonfailed backfill must not seed a replacement")
        ),
    )
    monkeypatch.setattr(
        subscriptions,
        "_load_backfill_out",
        lambda *_args, **_kwargs: PodcastBackfillOut(
            id=db.backfill_id,
            state="SourceLimited",
            processed_count=5,
            added_count=3,
        ),
    )
    monkeypatch.setattr(subscriptions, "record_replay", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(subscriptions, "retry_read_committed", lambda _db, _label, op: op())

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(subscriptions, "transaction", no_transaction)
    out = subscriptions.retry_subscription_backfill(  # type: ignore[arg-type]
        db,
        uuid4(),
        db.podcast_id,
        idempotency_key="retry-source-limited-backfill",
    )

    assert out.outcome == "NotEligible"
    assert out.backfill.state == "SourceLimited"
    assert "seed" not in db.events


def test_backfill_worker_locks_fence_before_aliases_and_enqueues_one_successor(
    monkeypatch,
) -> None:
    db = _BackfillSession()
    next_cursor = {
        "kind": "RssPage",
        "url": "https://example.com/page-2.xml",
        "visited": ["https://example.com/feed.xml"],
    }
    episode = {
        "guid": "episode-guid",
        "audio_url": "https://example.com/episode.mp3",
        "published_at": "2026-07-01T00:00:00Z",
    }

    monkeypatch.setattr(
        backfill_service,
        "fetch_feed_backfill_page",
        lambda **_kwargs: FeedBackfillPage((episode,), next_cursor, False),
    )
    monkeypatch.setattr(
        backfill_service,
        "lock_and_renew_running_job_claim",
        lambda *_args, **_kwargs: db.events.append("job") or object(),
    )
    monkeypatch.setattr(
        backfill_service,
        "lock_subscription_ingest_parent_in_current_transaction",
        lambda *_args, **_kwargs: db.events.append("aliases"),
    )
    monkeypatch.setattr(
        backfill_service,
        "sync_subscription_ingest",
        lambda **_kwargs: db.events.append("ingest") or SubscriptionIngestResult(1, 0, 1, False),
    )
    monkeypatch.setattr(
        backfill_service,
        "enqueue_backfill_step_in_current_transaction",
        lambda *_args, **_kwargs: db.events.append("enqueue") or True,
    )
    monkeypatch.setattr(
        backfill_service,
        "retry_read_committed",
        lambda _db, _label, op: op(),
    )
    monkeypatch.setattr(backfill_service, "CursorResult", _Rows)

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(backfill_service, "transaction", no_transaction)
    result = backfill_service.run_backfill_step(  # type: ignore[arg-type]
        db,
        payload={
            "backfillId": str(db.backfill_id),
            "expectedStepNo": 0,
            "expectedCursorDigest": cursor_digest(None),
        },
        context=object(),  # type: ignore[arg-type]
    )

    assert result == {
        "status": "Applied",
        "processedCount": 1,
        "addedCount": 1,
        "terminal": False,
    }
    assert db.events == [
        "job",
        "backfill",
        "subscription",
        "aliases",
        "ingest",
        "update",
        "enqueue",
    ]


def test_opml_resolved_db_phase_uses_retrying_relationship_primitive(monkeypatch) -> None:
    db = _ReadOnlySession()
    viewer_id = uuid4()
    podcast_id = uuid4()
    events: list[str] = []

    monkeypatch.setattr(
        subscriptions,
        "validate_writable_library_destinations",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        subscriptions,
        "select_podcast_id_by_feed_url",
        lambda *_args, **_kwargs: podcast_id,
    )
    monkeypatch.setattr(
        subscriptions,
        "get_podcast_index_client",
        lambda: object(),
    )
    monkeypatch.setattr(
        subscriptions,
        "_subscription_command_identity",
        lambda *_args, **_kwargs: "podcast_index:show",
    )
    monkeypatch.setattr(
        subscriptions,
        "_apply_resolved_subscription_relationship_in_current_transaction",
        lambda *_args, **_kwargs: events.append("relationship")
        or (podcast_id, uuid4(), True, (), ()),
    )

    def retry(_db, label, op):
        events.append(label)
        return op()

    monkeypatch.setattr(subscriptions, "retry_read_committed", retry)

    @contextmanager
    def no_transaction(_db):
        yield

    monkeypatch.setattr(subscriptions, "transaction", no_transaction)
    result = subscriptions.import_subscriptions_from_opml(  # type: ignore[arg-type]
        db,
        viewer_id,
        opml_xml=(
            '<?xml version="1.0"?>'
            '<opml version="2.0"><body>'
            '<outline type="rss" text="Show" xmlUrl="https://example.com/feed.xml"/>'
            "</body></opml>"
        ),
        default_library_ids=[],
        per_feed_library_ids={},
    )

    assert result.imported == 1
    assert events == ["apply_opml_subscription_relationship", "relationship"]
