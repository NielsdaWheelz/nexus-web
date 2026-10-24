"""Suggestion publication: cheap current reads and one coalesced background build.

The input counter records relevance changes. The queue owns execution and failure.
Only a fenced successful build replaces the latest publication; readers never rank.
Ranking holds shared expensive-read admission through snapshot cleanup; its
backend retires before the separate fenced publication transaction.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import SuggestionFeed, SuggestionShortlist
from nexus.db.retries import retry_serializable
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs import queue
from nexus.schemas.suggestions import (
    SuggestionExplicitRefreshIn,
    SuggestionPublicationMetaOut,
    SuggestionPublicationOut,
    SuggestionRefreshAtOut,
    SuggestionRefreshIn,
    SuggestionRefreshNowOut,
    SuggestionRefreshStoppedOut,
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import suggestion_changes, suggestions
from nexus.services.consumption.lectern import has_capacity
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.search.admission import search_session

_MAX_AGE = timedelta(minutes=15)
_MIN_BUILD_INTERVAL = timedelta(seconds=30)


def _feed(db: Session, *, viewer_id: UUID, library_id: UUID | None) -> SuggestionFeed | None:
    return db.scalar(
        select(SuggestionFeed).where(
            SuggestionFeed.user_id == viewer_id,
            SuggestionFeed.library_id.is_not_distinct_from(library_id),
        )
    )


def _read(
    db: Session, *, viewer_id: UUID, library_id: UUID | None
) -> tuple[SuggestionStateOut, SuggestionShortlist | None, datetime]:
    surface = suggestions.suggestion_surface(db, viewer_id=viewer_id, library_id=library_id)
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
    feed = _feed(db, viewer_id=viewer_id, library_id=library_id)
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
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> SuggestionStateOut:
    """State only, without a moving observation clock, for snapshot/diff streams."""
    state, _, _ = _read(db, viewer_id=viewer_id, library_id=library_id)
    return state


def read_suggestions(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> SuggestionsOut:
    """One read-only repeatable-read snapshot of latest ranking and current eligibility."""
    state, publication, observed_at = _read(db, viewer_id=viewer_id, library_id=library_id)
    hydrated = None
    if publication is not None:
        # The owned stored value has the same bounded canonical-ref contract as a view.
        refs = SuggestionViewIn(refs=publication.target_refs).refs
        items = suggestions.hydrate_current_suggestions(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            refs=[assert_resource_ref(ref) for ref in refs],
        )
        hydrated = SuggestionPublicationOut(id=publication.id, items=items)
    return SuggestionsOut(observed_at=observed_at, state=state, publication=hydrated)


def reconcile_suggestions_view(
    db: Session, *, viewer_id: UUID, request: SuggestionViewIn, library_id: UUID | None = None
) -> SuggestionViewOut:
    """An adopted old pool remains independently readable after latest is replaced."""
    state, _, observed_at = _read(db, viewer_id=viewer_id, library_id=library_id)
    items = suggestions.hydrate_current_suggestions(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        refs=[assert_resource_ref(ref) for ref in request.refs],
    )
    return SuggestionViewOut(observed_at=observed_at, state=state, items=items)


def request_suggestions_refresh(
    db: Session, *, viewer_id: UUID, request: SuggestionRefreshIn, library_id: UUID | None = None
) -> SuggestionStateOut:
    """Authorize and admit on a fresh session; queued/dead work always keeps its budget."""

    def attempt() -> SuggestionStateOut:
        state, publication, observed_at = _read(db, viewer_id=viewer_id, library_id=library_id)
        if state.capability == "NotApplicable" or state.work is not None:
            return state
        if isinstance(request, SuggestionExplicitRefreshIn):
            matches = request.observed_publication_id == (
                None if publication is None else publication.id
            )
            if not matches:
                return state
        elif publication is not None and (
            publication.ranked_revision == state.input_revision
            and observed_at < publication.ranked_at + _MAX_AGE
        ):
            return state
        feed = _feed(db, viewer_id=viewer_id, library_id=library_id)
        if feed is None:
            feed = SuggestionFeed(id=new_uuid7(), user_id=viewer_id, library_id=library_id)
            db.add(feed)
            db.flush()
        available_at = (
            observed_at
            if publication is None
            else max(
                observed_at,
                publication.ranked_at + _MIN_BUILD_INTERVAL,
            )
        )
        job = queue.enqueue_job(
            db,
            kind="suggestion_shortlist_refresh",
            payload={"feed_id": str(feed.id)},
            available_at=available_at,
        )
        feed.current_job_id = job.id
        db.flush()
        suggestion_changes.notify_suggestions(db)
        state = read_suggestion_state(db, viewer_id=viewer_id, library_id=library_id)
        return state

    return retry_serializable(db, "suggestions.refresh", attempt)


class _RefreshPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feed_id: UUID


def _authorized(db: Session, feed: SuggestionFeed) -> bool:
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


def run_suggestion_refresh_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    """Compute outside the publication transaction; only the current claim may publish."""
    feed_id = _RefreshPayload.model_validate(payload).feed_id
    with search_session() as db:
        get_repeatable_read_db(db)
        ranked_revision = suggestion_changes.input_revision(db)
        ranked_at = db.scalar(text("SELECT now()"))
        feed = db.get(SuggestionFeed, feed_id)
        can_publish = feed is not None and _authorized(db, feed)
        refs = (
            suggestions.rank_suggestion_refs(
                db,
                viewer_id=feed.user_id,
                library_id=feed.library_id,
            )
            if feed is not None and can_publish
            else []
        )
        target_refs = SuggestionViewIn(refs=[ref.uri for ref in refs]).refs

    with get_session_factory()() as db:

        def publish() -> Mapping[str, Any]:
            if queue.lock_running_job_claim(db, context=context) is None:
                return {"status": "superseded"}
            feed = db.get(SuggestionFeed, feed_id)
            result: dict[str, Any] = {"status": "superseded"}
            if feed is not None and feed.current_job_id == context.job_id:
                if can_publish and _authorized(db, feed):
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
                        ranked_at=ranked_at,
                        ranked_revision=ranked_revision,
                        target_refs=target_refs,
                    )
                    db.add(publication)
                    result = {"status": "published", "publication_id": str(publication.id)}
                feed.current_job_id = None
                db.flush()
            finished = queue.finish_job(db, context=context, result=result)
            assert finished is not None  # the claim stays locked through settlement
            suggestion_changes.notify_suggestions(db)
            return result

        return retry_serializable(db, "suggestions.publish", publish)
