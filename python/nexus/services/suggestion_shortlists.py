"""Suggestion publication: cheap current reads and one coalesced background build.

The input counter records relevance changes. The queue owns execution and failure.
Only a fenced successful build replaces the latest publication; readers never rank.
Admission retries recheck freshness; existing work retains its job and attempt budget.
Only observed admission contention refunds an attempt. Setup and computation expiry
spend the queue's ordinary failure budget.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.engine import async_database_scope
from nexus.db.models import SuggestionFeed, SuggestionShortlist, User
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs import queue
from nexus.logging import get_logger
from nexus.schemas.suggestions import (
    DailyEditionOut,
    SuggestionPublicationMetaOut,
    SuggestionPublicationOut,
    SuggestionRefreshAtOut,
    SuggestionRefreshNowOut,
    SuggestionRefreshStoppedOut,
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import daily_selection, suggestion_changes, suggestions, users
from nexus.services.consumption.lectern import has_capacity
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.search.admission import SearchAdmissionBusy, search_session_async
from nexus.services.search.policy import background_computation_deadline
from nexus.services.search.service import read_snapshot

logger = get_logger(__name__)

_MAX_AGE = timedelta(minutes=15)
_MIN_BUILD_INTERVAL = timedelta(seconds=30)
Mode = Literal["suggestions", "daily"]


def _feed(
    db: Session, *, viewer_id: UUID, library_id: UUID | None, mode: Mode
) -> SuggestionFeed | None:
    return db.scalar(
        select(SuggestionFeed).where(
            SuggestionFeed.user_id == viewer_id,
            SuggestionFeed.mode == mode,
            SuggestionFeed.library_id.is_not_distinct_from(library_id),
        )
    )


def _read(
    db: Session, *, viewer_id: UUID, library_id: UUID | None, mode: Mode
) -> tuple[SuggestionStateOut, SuggestionShortlist | None, datetime]:
    surface = (
        "daily"
        if mode == "daily"
        else suggestions.suggestion_surface(db, viewer_id=viewer_id, library_id=library_id)
    )
    observed_at = db.scalar(text("SELECT now()"))
    revision = suggestion_changes.input_revision(db)
    capability = "Available"
    if surface is None:
        return (
            SuggestionStateOut(
                input_revision=revision,
                latest=None,
                work=None,
                capability="NotApplicable",
                automatic_refresh=SuggestionRefreshStoppedOut(),
            ),
            None,
            observed_at,
        )
    if surface == "lectern" and not has_capacity(db, viewer_id=viewer_id):
        capability = "LecternFull"
    feed = _feed(db, viewer_id=viewer_id, library_id=library_id, mode=mode)
    publication = (
        None
        if feed is None
        else db.scalar(select(SuggestionShortlist).where(SuggestionShortlist.feed_id == feed.id))
    )
    work: queue.DurableExecutionPhase | None = None
    if feed is not None and feed.current_job_id is not None:
        job = queue.get_job(db, feed.current_job_id)
        assert job is not None  # the feed's queue foreign key proves reachability
        work = queue.project_execution_phase(
            job_status=job.status,
            attempts=job.attempts,
            error_code=job.error_code,
        )
    latest = None if publication is None else SuggestionPublicationMetaOut(id=publication.id)
    if work is not None:
        advice = SuggestionRefreshStoppedOut()
    elif mode == "daily":
        time_zone = db.scalars(select(User.calendar_time_zone).where(User.id == viewer_id)).one()
        due = daily_selection.due_window(
            observed_at=observed_at,
            time_zone=time_zone,
            previous_cutoff=None if publication is None else publication.window_end,
        )
        advice = (
            SuggestionRefreshNowOut()
            if due is not None
            else SuggestionRefreshAtOut(
                at=daily_selection.next_cutoff(observed_at=observed_at, time_zone=time_zone)
            )
        )
    elif publication is None:
        advice = SuggestionRefreshNowOut()
    else:
        delay = _MIN_BUILD_INTERVAL if revision != publication.ranked_revision else _MAX_AGE
        advice = SuggestionRefreshAtOut(at=publication.ranked_at + delay)
    return (
        SuggestionStateOut(
            input_revision=revision,
            latest=latest,
            work=work,
            capability=capability,
            automatic_refresh=advice,
        ),
        publication,
        observed_at,
    )


def read_suggestion_state(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None, mode: Mode = "suggestions"
) -> SuggestionStateOut:
    """Current eligibility and refresh advice without loading publication items."""
    state, _, _ = _read(db, viewer_id=viewer_id, library_id=library_id, mode=mode)
    return state


def read_suggestions(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None, mode: Mode = "suggestions"
) -> SuggestionsOut:
    """One read-only repeatable-read snapshot of latest ranking and current eligibility."""
    state, publication, observed_at = _read(
        db, viewer_id=viewer_id, library_id=library_id, mode=mode
    )
    hydrated = None
    if publication is not None:
        # The owned stored value has the same bounded canonical-ref contract as a view.
        refs = SuggestionViewIn(refs=publication.target_refs).refs
        items = suggestions.hydrate_current_suggestions(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            refs=[assert_resource_ref(ref) for ref in refs],
            daily=mode == "daily",
        )
        edition = None
        if mode == "daily":
            assert publication.edition_date is not None and publication.time_zone is not None
            assert publication.window_start is not None and publication.window_end is not None
            assert publication.coverage is not None
            edition = DailyEditionOut(
                local_date=publication.edition_date,
                time_zone=publication.time_zone,
                window_start=publication.window_start,
                window_end=publication.window_end,
                checked_source_count=publication.coverage["checked_source_count"],
                source_count=publication.coverage["source_count"],
            )
        hydrated = SuggestionPublicationOut(id=publication.id, edition=edition, items=items)
    return SuggestionsOut(observed_at=observed_at, state=state, publication=hydrated)


def reconcile_suggestions_view(
    db: Session,
    *,
    viewer_id: UUID,
    request: SuggestionViewIn,
    library_id: UUID | None = None,
    mode: Mode = "suggestions",
) -> SuggestionViewOut:
    """An adopted old pool remains independently readable after latest is replaced."""
    if mode == "daily" and (
        len(request.refs) > 5 or any(not ref.startswith("media:") for ref in request.refs)
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "daily views contain at most five media refs"
        )
    state, _, observed_at = _read(db, viewer_id=viewer_id, library_id=library_id, mode=mode)
    items = suggestions.hydrate_current_suggestions(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        refs=[assert_resource_ref(ref) for ref in request.refs],
        daily=mode == "daily",
    )
    return SuggestionViewOut(observed_at=observed_at, state=state, items=items)


def request_suggestions_refresh(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID | None = None,
    mode: Mode = "suggestions",
    due_context: queue.JobExecutionContext | None = None,
) -> SuggestionStateOut:
    """Authorize and admit on a fresh session; queued/dead work always keeps its budget."""

    def attempt() -> SuggestionStateOut:
        users.lock_viewer(db, viewer_id)
        state, publication, observed_at = _read(
            db, viewer_id=viewer_id, library_id=library_id, mode=mode
        )
        if (
            due_context is not None
            and queue.lock_running_job_claim(db, context=due_context) is None
        ):
            return state
        if state.capability == "NotApplicable":
            return state
        feed = _feed(db, viewer_id=viewer_id, library_id=library_id, mode=mode)
        edition = None
        if mode == "daily":
            time_zone = db.scalars(
                select(User.calendar_time_zone).where(User.id == viewer_id)
            ).one()
            edition = daily_selection.due_window(
                observed_at=observed_at,
                time_zone=time_zone,
                previous_cutoff=None if publication is None else publication.window_end,
            )
            if edition is None:
                if publication is not None:
                    _prefetch_daily(
                        db,
                        viewer_id=viewer_id,
                        edition_id=publication.id,
                        refs=publication.target_refs,
                    )
                return state
            if feed is not None and feed.current_job_id is not None:
                job = queue.get_job(db, feed.current_job_id)
                assert job is not None
                if _RefreshPayload.model_validate(job.payload).edition == edition:
                    return state
        elif state.work is not None:
            return state
        elif publication is not None and (
            publication.ranked_revision == state.input_revision
            and observed_at < publication.ranked_at + _MAX_AGE
        ):
            return state
        if feed is None:
            feed = SuggestionFeed(
                id=new_uuid7(), user_id=viewer_id, library_id=library_id, mode=mode
            )
            db.add(feed)
            db.flush()
        available_at = (
            observed_at
            if publication is None or mode == "daily"
            else max(
                observed_at,
                publication.ranked_at + _MIN_BUILD_INTERVAL,
            )
        )
        job = queue.enqueue_job(
            db,
            kind="suggestion_shortlist_refresh",
            payload=_RefreshPayload(feed_id=feed.id, edition=edition).model_dump(mode="json"),
            available_at=available_at,
        )
        feed.current_job_id = job.id
        db.flush()
        state = read_suggestion_state(db, viewer_id=viewer_id, library_id=library_id, mode=mode)
        return state

    return retry_serializable(db, "suggestions.refresh", attempt)


class _RefreshPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feed_id: UUID
    edition: daily_selection.DailyWindow | None = None


def _prefetch_daily(db: Session, *, viewer_id: UUID, edition_id: UUID, refs: list[str]) -> None:
    """Re-offer visible retained nominations using the edition's same attempt ids.

    A feed-body attempt may still be running at publication; the minute due sweep
    completes nomination after it settles. Catalogue point access alone is not a
    retained daily audience. The source owner preserves in-flight and spent budgets.
    """
    from nexus.services.feed_articles import enqueue_linked_articles

    if not refs:
        return
    media_ids = list(
        db.scalars(
            text(f"""SELECT media_id FROM ({visible_media_ids_cte_sql()}) visible
                WHERE media_id=ANY(CAST(:ids AS uuid[]))"""),
            {"viewer_id": viewer_id, "ids": [assert_resource_ref(ref).id for ref in refs]},
        )
    )
    enqueue_linked_articles(db, viewer_id=viewer_id, media_ids=media_ids, edition_id=edition_id)


def _authorized(db: Session, feed: SuggestionFeed) -> bool:
    if feed.mode == "daily":
        return True
    try:
        return (
            suggestions.suggestion_surface(
                db,
                viewer_id=feed.user_id,
                library_id=feed.library_id,
            )
            is not None
        )
    except NotFoundError as exc:
        if exc.code != ApiErrorCode.E_LIBRARY_NOT_FOUND:
            raise
        return False


@dataclass(frozen=True, slots=True)
class _RefreshRead:
    revision: int
    ranked_at: datetime
    can_publish: bool
    target_refs: list[str]
    coverage: dict[str, int] | None


def _current_edition(db: Session, feed: SuggestionFeed, request: _RefreshPayload) -> bool:
    if feed.mode == "suggestions":
        assert request.edition is None
        return True
    assert request.edition is not None
    time_zone = db.scalars(select(User.calendar_time_zone).where(User.id == feed.user_id)).one()
    previous = db.scalar(
        select(SuggestionShortlist.window_end).where(SuggestionShortlist.feed_id == feed.id)
    )
    due = daily_selection.due_window(
        observed_at=db.scalar(text("SELECT now()")), time_zone=time_zone, previous_cutoff=previous
    )
    return due == request.edition


def run_suggestion_refresh_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    """One complete admitted read; only a current claim atomically publishes it.

    Admission refusal reschedules unchanged work after retirement. Setup and
    computation expiry spend the queue's failure budget. Publication is
    a separate short serializable transaction; a failed read never replaces it.
    """
    request = _RefreshPayload.model_validate(payload)
    feed_id = request.feed_id

    async def read() -> _RefreshRead:
        async with async_database_scope():
            deadline = background_computation_deadline()

            def snapshot(db: Session) -> _RefreshRead:
                revision = suggestion_changes.input_revision(db)
                ranked_at = db.scalar(text("SELECT now()"))
                feed = db.get(SuggestionFeed, feed_id)
                can_publish = (
                    feed is not None
                    and feed.current_job_id == context.job_id
                    and _authorized(db, feed)
                    and _current_edition(db, feed, request)
                )
                refs = (
                    suggestions.select_refs(
                        db,
                        viewer_id=feed.user_id,
                        selection=suggestions.SuggestionsSelection(feed.library_id)
                        if request.edition is None
                        else suggestions.DailySelection(request.edition),
                    )
                    if feed is not None and can_publish
                    else []
                )
                return _RefreshRead(
                    revision,
                    ranked_at,
                    can_publish,
                    SuggestionViewIn(refs=[ref.uri for ref in refs]).refs,
                    daily_selection.head_coverage(
                        db, viewer_id=feed.user_id, window=request.edition
                    )
                    if feed is not None and can_publish and request.edition is not None
                    else None,
                )

            async with search_session_async(deadline=deadline, purpose="background") as database:
                return await database.run_sync(
                    lambda db: read_snapshot(db, snapshot, deadline=deadline)
                )

    try:
        ranked = asyncio.run(read())
    except SearchAdmissionBusy:
        with get_session_factory()() as control:
            if not queue.running_job_claim_is_current(control, context=context):
                return {"status": "superseded"}
            job = queue.get_job(control, context.job_id)
            assert job is not None
            observed_at = control.scalar(text("SELECT now()"))
            logger.info(
                "suggestions.refresh.rescheduled",
                job_id=str(context.job_id),
                execution_id=str(context.execution_id),
                reason="admission_busy",
                phase="admission",
                job_age_ms=(observed_at - job.created_at).total_seconds() * 1000,
            )
            return queue.RescheduleRequested(observed_at + timedelta(seconds=5), payload=payload)

    with get_session_factory()() as db:

        def publish() -> Mapping[str, Any]:
            feed = db.get(SuggestionFeed, feed_id)
            if feed is not None and feed.mode == "daily":
                # Account lock serializes the captured zone against profile changes.
                users.lock_viewer(db, feed.user_id)
            if queue.lock_running_job_claim(db, context=context) is None:
                return {"status": "superseded"}
            result: dict[str, Any] = {"status": "superseded"}
            if feed is not None and feed.current_job_id == context.job_id:
                if (
                    ranked.can_publish
                    and _authorized(db, feed)
                    and _current_edition(db, feed, request)
                ):
                    previous = db.scalar(
                        select(SuggestionShortlist).where(
                            SuggestionShortlist.feed_id == feed.id,
                        )
                    )
                    if previous is not None:
                        db.delete(previous)
                        db.flush()
                    publication = SuggestionShortlist(
                        id=new_uuid7(),
                        feed_id=feed.id,
                        ranked_at=ranked.ranked_at,
                        ranked_revision=ranked.revision,
                        target_refs=ranked.target_refs,
                        edition_date=None
                        if request.edition is None
                        else request.edition.local_date,
                        time_zone=None if request.edition is None else request.edition.time_zone,
                        window_start=None
                        if request.edition is None
                        else request.edition.window_start,
                        window_end=None if request.edition is None else request.edition.window_end,
                        coverage=ranked.coverage,
                    )
                    db.add(publication)
                    if request.edition is not None:
                        _prefetch_daily(
                            db,
                            viewer_id=feed.user_id,
                            edition_id=publication.id,
                            refs=ranked.target_refs,
                        )
                    result = {"status": "published", "publication_id": str(publication.id)}
                feed.current_job_id = None
                db.flush()
            finished = queue.finish_job(db, context=context, result=result)
            assert finished is not None  # the claim stays locked through settlement
            return result

        return retry_serializable(db, "suggestions.publish", publish)


def run_daily_due_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    """Register and ensure each account's latest due edition without an observer."""
    with get_session_factory()() as db:
        viewers = db.scalars(select(User.id).order_by(User.id)).all()
    for viewer_id in viewers:
        with get_session_factory()() as db:
            request_suggestions_refresh(db, viewer_id=viewer_id, mode="daily", due_context=context)
    return {"account_count": len(viewers)}
