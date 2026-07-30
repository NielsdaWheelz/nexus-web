"""Real-Postgres fault-injection proofs for Podcast backfill fencing."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    claim_job,
    complete_job,
    enqueue_job,
)
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_observation_seam import ContributorObservation
from nexus.services.podcasts import backfill, ingest
from nexus.services.podcasts.backfill import (
    BACKFILL_JOB_KIND,
    cursor_digest,
    run_backfill_step,
    seed_subscription_backfill_in_current_transaction,
)
from nexus.services.podcasts.feed import FeedBackfillPage
from nexus.services.podcasts.ingest import SubscriptionIngestResult
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_NEXT_CURSOR = {
    "kind": "RssPage",
    "url": "https://feeds.example.com/history/page-2.xml",
    "visited": ["https://feeds.example.com/history.xml"],
}
_EPISODE = {
    "guid": "history-episode-1",
    "audio_url": "https://cdn.example.com/history-episode-1.mp3",
    "published_at": "2026-01-01T00:00:00Z",
    "title": "History Episode",
}


@dataclass(frozen=True, slots=True)
class _BackfillFixture:
    user_id: UUID
    podcast_id: UUID
    subscription_id: UUID
    backfill_id: UUID
    job_id: UUID
    payload: dict[str, object]


def _seed_backfill(direct_db: DirectSessionManager) -> _BackfillFixture:
    user_id = new_uuid7()
    podcast_id = new_uuid7()
    subscription_id = new_uuid7()
    cutoff_at = datetime(2026, 7, 29, tzinfo=UTC)

    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("podcast_subscriptions", "id", subscription_id)

    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        db.execute(
            text(
                """
                INSERT INTO podcasts (
                    id,
                    provider,
                    provider_podcast_id,
                    title,
                    feed_url
                )
                VALUES (
                    :id,
                    'podcast_index',
                    :provider_podcast_id,
                    'Backfill Fence Podcast',
                    :feed_url
                )
                """
            ),
            {
                "id": podcast_id,
                "provider_podcast_id": f"backfill-fence-{podcast_id}",
                "feed_url": f"https://feeds.example.com/{podcast_id}.xml",
            },
        )
        db.execute(
            text(
                """
                INSERT INTO podcast_subscriptions (
                    id,
                    user_id,
                    podcast_id,
                    auto_queue,
                    sync_status
                )
                VALUES (
                    :id,
                    :user_id,
                    :podcast_id,
                    false,
                    'pending'
                )
                """
            ),
            {
                "id": subscription_id,
                "user_id": user_id,
                "podcast_id": podcast_id,
            },
        )
        backfill_id = seed_subscription_backfill_in_current_transaction(
            db,
            subscription_id=subscription_id,
            cutoff_at=cutoff_at,
        )
        row = (
            db.execute(
                text(
                    """
                    SELECT id, payload
                    FROM background_jobs
                    WHERE dedupe_key = :dedupe_key
                    """
                ),
                {"dedupe_key": f"podcast-backfill:{backfill_id}:0"},
            )
            .mappings()
            .one()
        )
        db.commit()

    job_id = UUID(str(row["id"]))
    direct_db.register_cleanup(
        "podcast_subscription_backfills",
        "id",
        backfill_id,
    )
    direct_db.register_cleanup(
        "background_jobs",
        "dedupe_key",
        f"podcast-backfill:{backfill_id}:0",
    )
    direct_db.register_cleanup(
        "background_jobs",
        "dedupe_key",
        f"podcast-backfill:{backfill_id}:1",
    )
    return _BackfillFixture(
        user_id=user_id,
        podcast_id=podcast_id,
        subscription_id=subscription_id,
        backfill_id=backfill_id,
        job_id=job_id,
        payload=dict(row["payload"]),
    )


def _claim(
    direct_db: DirectSessionManager,
    fixture: _BackfillFixture,
    *,
    worker_id: str,
    job_id: UUID | None = None,
) -> tuple[JobRow, JobExecutionContext]:
    claimed_job_id = job_id or fixture.job_id
    with direct_db.session() as db:
        claimed = claim_job(
            db,
            job_id=claimed_job_id,
            worker_id=worker_id,
            lease_seconds=60,
            allowed_kinds=(BACKFILL_JOB_KIND,),
        )
        db.commit()
    assert claimed is not None
    return (
        claimed,
        JobExecutionContext(
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
        ),
    )


def _install_ingest_seam(
    monkeypatch: pytest.MonkeyPatch,
    *,
    next_cursor: dict[str, object] | None,
    fetch_barrier: threading.Barrier | None = None,
) -> list[str]:
    ingest_calls: list[str] = []
    calls_lock = threading.Lock()

    def fetch(**_kwargs: object) -> FeedBackfillPage:
        if fetch_barrier is not None:
            fetch_barrier.wait(timeout=10)
        return FeedBackfillPage(
            episodes=(_EPISODE,),
            next_cursor=next_cursor,
            source_limited=False,
        )

    def ingest(**_kwargs: object) -> SubscriptionIngestResult:
        with calls_lock:
            ingest_calls.append("ingest")
        return SubscriptionIngestResult(
            ingested_episode_count=1,
            reused_episode_count=0,
            added_to_subscriber_all_count=1,
            source_limited=False,
        )

    monkeypatch.setattr(backfill, "fetch_feed_backfill_page", fetch)
    monkeypatch.setattr(backfill, "sync_subscription_ingest", ingest)
    return ingest_calls


def _backfill_state(
    direct_db: DirectSessionManager,
    backfill_id: UUID,
) -> dict[str, object]:
    with direct_db.session() as db:
        return dict(
            db.execute(
                text(
                    """
                    SELECT
                        step_no,
                        cursor,
                        processed_count,
                        added_count,
                        completed_at,
                        failed_at,
                        error_code
                    FROM podcast_subscription_backfills
                    WHERE id = :backfill_id
                    """
                ),
                {"backfill_id": backfill_id},
            )
            .mappings()
            .one()
        )


def _install_boundary_fault(
    monkeypatch: pytest.MonkeyPatch,
    *,
    db: Session,
    boundary: str,
) -> list[str]:
    boundary_calls: list[str] = []
    armed = True

    def fail_after_boundary() -> None:
        nonlocal armed
        boundary_calls.append(boundary)
        if armed:
            armed = False
            raise RuntimeError(f"injected failure after {boundary}")

    if boundary == "episode materialization":
        original = ingest.ensure_media_transcript_state_row

        def materialize(
            session: Session,
            *,
            media_id: UUID,
            now: datetime,
        ) -> None:
            original(session, media_id=media_id, now=now)
            fail_after_boundary()

        monkeypatch.setattr(ingest, "ensure_media_transcript_state_row", materialize)
    elif boundary == "contributor observation":
        original_observe = ingest.apply_contributor_observation_in_current_transaction

        def observe(session: Session, observation: ContributorObservation) -> None:
            original_observe(session, observation)
            fail_after_boundary()

        monkeypatch.setattr(
            ingest,
            "apply_contributor_observation_in_current_transaction",
            observe,
        )
    elif boundary == "step advance":
        original_execute = db.execute

        def execute(
            statement: Any,
            params: Any = None,
            *args: Any,
            **kwargs: Any,
        ) -> Any:
            result = original_execute(statement, params, *args, **kwargs)
            sql = " ".join(str(statement).split())
            if (
                sql.startswith("UPDATE podcast_subscription_backfills")
                and "processed_count = processed_count" in sql
            ):
                fail_after_boundary()
            return result

        monkeypatch.setattr(db, "execute", execute)
    elif boundary == "successor enqueue":
        original_enqueue = backfill.enqueue_backfill_step_in_current_transaction

        def enqueue_successor(
            session: Session,
            *,
            backfill_id: UUID,
            step_no: int,
            cursor: Mapping[str, object] | None,
        ) -> bool:
            inserted = original_enqueue(
                session,
                backfill_id=backfill_id,
                step_no=step_no,
                cursor=cursor,
            )
            if step_no == 1:
                fail_after_boundary()
            return inserted

        monkeypatch.setattr(
            backfill,
            "enqueue_backfill_step_in_current_transaction",
            enqueue_successor,
        )
    else:
        raise AssertionError(f"unknown boundary: {boundary}")

    return boundary_calls


def _artifact_counts(
    direct_db: DirectSessionManager,
    fixture: _BackfillFixture,
    *,
    author_name: str,
) -> dict[str, int]:
    with direct_db.session() as db:
        row = (
            db.execute(
                text(
                    """
                    SELECT
                        (
                            SELECT count(*)
                            FROM media
                            WHERE created_by_user_id = :user_id
                              AND kind = 'podcast_episode'
                        ) AS media_count,
                        (
                            SELECT count(*)
                            FROM podcast_episodes
                            WHERE podcast_id = :podcast_id
                        ) AS episode_count,
                        (
                            SELECT count(*)
                            FROM podcast_episode_identities
                            WHERE podcast_id = :podcast_id
                        ) AS alias_count,
                        (
                            SELECT count(*)
                            FROM library_entries entry
                            JOIN media ON media.id = entry.media_id
                            WHERE media.created_by_user_id = :user_id
                              AND media.kind = 'podcast_episode'
                        ) AS library_entry_count,
                        (
                            SELECT count(*)
                            FROM contributor_credits credit
                            JOIN media ON media.id = credit.media_id
                            WHERE media.created_by_user_id = :user_id
                              AND media.kind = 'podcast_episode'
                        ) AS credit_count,
                        (
                            SELECT count(*)
                            FROM contributors
                            WHERE display_name = :author_name
                        ) AS contributor_count,
                        (
                            SELECT count(*)
                            FROM background_jobs
                            WHERE dedupe_key = :successor_dedupe_key
                        ) AS successor_count
                    """
                ),
                {
                    "user_id": fixture.user_id,
                    "podcast_id": fixture.podcast_id,
                    "author_name": author_name,
                    "successor_dedupe_key": (f"podcast-backfill:{fixture.backfill_id}:1"),
                },
            )
            .mappings()
            .one()
        )
    return {key: int(value) for key, value in row.items()}


def _register_ingest_cleanup(
    direct_db: DirectSessionManager,
    fixture: _BackfillFixture,
) -> None:
    with direct_db.session() as db:
        rows = db.execute(
            text(
                """
                SELECT episode.media_id, credit.contributor_id
                FROM podcast_episodes episode
                LEFT JOIN contributor_credits credit
                  ON credit.media_id = episode.media_id
                WHERE episode.podcast_id = :podcast_id
                """
            ),
            {"podcast_id": fixture.podcast_id},
        ).all()

    media_ids = {UUID(str(row.media_id)) for row in rows}
    contributor_ids = {
        UUID(str(row.contributor_id)) for row in rows if row.contributor_id is not None
    }
    for contributor_id in contributor_ids:
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup(
            "contributor_external_ids",
            "contributor_id",
            contributor_id,
        )
        direct_db.register_cleanup(
            "contributor_aliases",
            "contributor_id",
            contributor_id,
        )
    for media_id in media_ids:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
        direct_db.register_cleanup(
            "background_jobs",
            "dedupe_key",
            f"enrich-metadata:{media_id}",
        )


@pytest.mark.parametrize(
    "boundary",
    [
        "episode materialization",
        "contributor observation",
        "step advance",
        "successor enqueue",
    ],
)
def test_each_backfill_write_boundary_rolls_back_and_retries_exactly_once(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
    boundary: str,
) -> None:
    fixture = _seed_backfill(direct_db)
    _, context = _claim(
        direct_db,
        fixture,
        worker_id=f"backfill-boundary-{boundary.replace(' ', '-')}",
    )
    author_name = f"Boundary Author {fixture.backfill_id}"
    episode = {
        **_EPISODE,
        "guid": f"history-episode-{fixture.backfill_id}",
        "audio_url": f"https://cdn.example.com/{fixture.backfill_id}.mp3",
        "authors": [author_name],
    }
    monkeypatch.setattr(
        backfill,
        "fetch_feed_backfill_page",
        lambda **_kwargs: FeedBackfillPage(
            episodes=(episode,),
            next_cursor=_NEXT_CURSOR,
            source_limited=False,
        ),
    )

    with direct_db.session() as db:
        boundary_calls = _install_boundary_fault(
            monkeypatch,
            db=db,
            boundary=boundary,
        )
        with pytest.raises(RuntimeError, match=f"injected failure after {boundary}"):
            run_backfill_step(db, payload=fixture.payload, context=context)

        state_after_failure = _backfill_state(direct_db, fixture.backfill_id)
        assert (
            state_after_failure["step_no"],
            state_after_failure["cursor"],
            state_after_failure["processed_count"],
            state_after_failure["added_count"],
        ) == (0, None, 0, 0)
        assert _artifact_counts(
            direct_db,
            fixture,
            author_name=author_name,
        ) == {
            "media_count": 0,
            "episode_count": 0,
            "alias_count": 0,
            "library_entry_count": 0,
            "credit_count": 0,
            "contributor_count": 0,
            "successor_count": 0,
        }

        retried = run_backfill_step(db, payload=fixture.payload, context=context)

    _register_ingest_cleanup(direct_db, fixture)
    assert retried == {
        "status": "Applied",
        "processedCount": 1,
        "addedCount": 1,
        "terminal": False,
    }
    assert boundary_calls == [boundary, boundary]
    state_after_retry = _backfill_state(direct_db, fixture.backfill_id)
    assert (
        state_after_retry["step_no"],
        state_after_retry["processed_count"],
        state_after_retry["added_count"],
    ) == (1, 1, 1)
    assert state_after_retry["cursor"] == _NEXT_CURSOR
    assert _artifact_counts(
        direct_db,
        fixture,
        author_name=author_name,
    ) == {
        "media_count": 1,
        "episode_count": 1,
        "alias_count": 2,
        "library_entry_count": 1,
        "credit_count": 1,
        "contributor_count": 1,
        "successor_count": 1,
    }


def test_domain_commit_replay_does_not_recount_or_duplicate_successor(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_backfill(direct_db)
    _, context = _claim(direct_db, fixture, worker_id="backfill-domain-commit")
    ingest_calls = _install_ingest_seam(monkeypatch, next_cursor=_NEXT_CURSOR)

    with direct_db.session() as db:
        first = run_backfill_step(db, payload=fixture.payload, context=context)
    # Fault injection: the domain transaction committed, but the worker never
    # performed its separate queue-terminal transition. Re-dispatch the same job.
    with direct_db.session() as db:
        replay = run_backfill_step(db, payload=fixture.payload, context=context)
    with direct_db.session() as db:
        assert complete_job(
            db,
            job_id=fixture.job_id,
            worker_id=context.worker_id,
            result_payload=replay,
        )
        db.commit()

    assert first["status"] == "Applied"
    assert replay == {"status": "AlreadyApplied"}
    assert ingest_calls == ["ingest"]
    state = _backfill_state(direct_db, fixture.backfill_id)
    assert (state["step_no"], state["processed_count"], state["added_count"]) == (1, 1, 1)
    assert state["cursor"] == _NEXT_CURSOR
    with direct_db.session() as db:
        original_status = db.execute(
            text("SELECT status FROM background_jobs WHERE id = :job_id"),
            {"job_id": fixture.job_id},
        ).scalar_one()
        successor_rows = db.execute(
            text(
                """
                SELECT payload
                FROM background_jobs
                WHERE dedupe_key = :dedupe_key
                """
            ),
            {"dedupe_key": f"podcast-backfill:{fixture.backfill_id}:1"},
        ).all()
    assert original_status == "succeeded"
    assert len(successor_rows) == 1
    assert successor_rows[0][0]["expectedStepNo"] == 1
    assert successor_rows[0][0]["expectedCursorDigest"] == cursor_digest(_NEXT_CURSOR)


def test_distinct_jobs_for_same_step_serialize_on_locked_fence(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_backfill(direct_db)
    _, first_context = _claim(
        direct_db,
        fixture,
        worker_id="backfill-duplicate-first",
    )
    with direct_db.session() as db:
        duplicate = enqueue_job(
            db,
            kind=BACKFILL_JOB_KIND,
            payload=fixture.payload,
            max_attempts=3,
        )
        db.commit()
    direct_db.register_cleanup("background_jobs", "id", duplicate.id)
    _, duplicate_context = _claim(
        direct_db,
        fixture,
        job_id=duplicate.id,
        worker_id="backfill-duplicate-second",
    )
    ingest_calls = _install_ingest_seam(
        monkeypatch,
        next_cursor=_NEXT_CURSOR,
        fetch_barrier=threading.Barrier(2),
    )

    def run_duplicate(context: JobExecutionContext) -> dict[str, object]:
        with direct_db.session() as db:
            return run_backfill_step(db, payload=fixture.payload, context=context)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run_duplicate, (first_context, duplicate_context)))

    assert sorted(result["status"] for result in results) == [
        "AlreadyApplied",
        "Applied",
    ]
    assert ingest_calls == ["ingest"]
    state = _backfill_state(direct_db, fixture.backfill_id)
    assert (state["step_no"], state["processed_count"], state["added_count"]) == (1, 1, 1)
    with direct_db.session() as db:
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM background_jobs
                    WHERE dedupe_key = :dedupe_key
                    """
                ),
                {"dedupe_key": f"podcast-backfill:{fixture.backfill_id}:1"},
            ).scalar_one()
            == 1
        )


def test_expired_zombie_is_rejected_and_reclaimed_attempt_applies_once(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_backfill(direct_db)
    _, zombie_context = _claim(direct_db, fixture, worker_id="backfill-zombie")
    with direct_db.session() as db:
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET lease_expires_at = now() - interval '1 minute'
                WHERE id = :job_id
                """
            ),
            {"job_id": fixture.job_id},
        )
        db.commit()
    _, reclaimed_context = _claim(
        direct_db,
        fixture,
        worker_id="backfill-reclaimed",
    )
    ingest_calls = _install_ingest_seam(monkeypatch, next_cursor=None)

    with direct_db.session() as db:
        zombie = run_backfill_step(
            db,
            payload=fixture.payload,
            context=zombie_context,
        )
    with direct_db.session() as db:
        reclaimed = run_backfill_step(
            db,
            payload=fixture.payload,
            context=reclaimed_context,
        )

    assert zombie == {"status": "StaleJobAttempt"}
    assert reclaimed["status"] == "Applied"
    assert ingest_calls == ["ingest"]
    state = _backfill_state(direct_db, fixture.backfill_id)
    assert (state["step_no"], state["processed_count"], state["added_count"]) == (1, 1, 1)
    assert state["completed_at"] is not None


def test_unsubscribed_backfill_job_is_a_typed_noop_without_provider_io(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_backfill(direct_db)
    _, context = _claim(direct_db, fixture, worker_id="backfill-unsubscribed")
    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM background_jobs WHERE id = :job_id"),
            {"job_id": fixture.job_id},
        )
        db.execute(
            text("DELETE FROM podcast_subscription_backfills WHERE id = :backfill_id"),
            {"backfill_id": fixture.backfill_id},
        )
        db.execute(
            text("DELETE FROM podcast_subscriptions WHERE id = :subscription_id"),
            {"subscription_id": fixture.subscription_id},
        )
        db.commit()

    monkeypatch.setattr(
        backfill,
        "fetch_feed_backfill_page",
        lambda **_kwargs: pytest.fail("unsubscribed jobs must perform no provider I/O"),
    )
    with direct_db.session() as db:
        result = run_backfill_step(db, payload=fixture.payload, context=context)

    assert result == {"status": "StaleOrUnsubscribed"}


def test_dead_letter_finalization_is_fenced_to_the_current_step(
    direct_db: DirectSessionManager,
) -> None:
    current = _seed_backfill(direct_db)
    stale = _seed_backfill(direct_db)
    with direct_db.session() as db:
        db.execute(
            text(
                """
                UPDATE podcast_subscription_backfills
                SET
                    step_no = 1,
                    cursor = CAST(:cursor AS jsonb),
                    updated_at = now()
                WHERE id = :backfill_id
                """
            ),
            {
                "backfill_id": stale.backfill_id,
                "cursor": '{"kind":"advanced"}',
            },
        )
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET
                    status = 'running',
                    attempts = max_attempts,
                    claimed_by = 'expired-worker',
                    lease_expires_at = now() - interval '100 years'
                WHERE id = ANY(:job_ids)
                """
            ),
            {"job_ids": [current.job_id, stale.job_id]},
        )
        db.commit()

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="backfill-dead-letter",
        registry=get_default_registry(),
        allowed_kinds=(BACKFILL_JOB_KIND,),
    )
    assert worker.run_once() is True
    assert worker.run_once() is True

    current_state = _backfill_state(direct_db, current.backfill_id)
    stale_state = _backfill_state(direct_db, stale.backfill_id)
    assert current_state["failed_at"] is not None
    assert current_state["error_code"] == "E_JOB_LEASE_EXPIRED"
    assert stale_state["failed_at"] is None
    assert stale_state["error_code"] is None
    with direct_db.session() as db:
        statuses = dict(
            db.execute(
                text(
                    """
                    SELECT id, status
                    FROM background_jobs
                    WHERE id = ANY(:job_ids)
                    """
                ),
                {"job_ids": [current.job_id, stale.job_id]},
            ).all()
        )
    assert statuses == {
        current.job_id: "dead",
        stale.job_id: "dead",
    }
