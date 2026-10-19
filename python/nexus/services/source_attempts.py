"""Source attempts: the durable obligation that one source becomes one media's content.

Owns ``media_source_attempts`` and ``media_source_supersessions``. Every attempt is
created here with its history event and enqueued here, in the caller's transaction: an
accepted attempt commits with its job (I11). A media's attempts form a chain ordered by
``attempt_no``; the latest is authoritative. A same-source recovery successor has a
derived id (``successor_id``, I10), so its retry finds its own effect. An explicit new
browser source instead retains its attempt in the upload receipt. An attempt whose source
converged on another media keeps that answer in ``media_source_supersessions`` after its
own media is torn down.

The recovery policy lives here too: one answer per latest attempt, read by Imports,
the media projection, action menus and every recovery admission.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID, uuid5

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaSourceAttempt
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import enqueue_job
from nexus.schemas.import_history import (
    SafeFailureCode,
    SourceAccepted,
    SourceFacts,
    SourceFailed,
    SourceSucceeded,
    assume_safe_failure_code,
)
from nexus.schemas.imports import RepairSourceOffer, RetrySourceOffer, SourceRecoveryInput
from nexus.schemas.x_source import XArticleContent
from nexus.services import source_types as st
from nexus.services.capabilities import SourceRecoveryAnswer, is_same_source_terminal_error
from nexus.services.import_history import append_processing_event
from nexus.services.x_identity import native_x_article_id
from nexus.services.x_source import x_article_content_facts

_LOST_STORED_SOURCE_CODES = frozenset({"E_SIGN_UPLOAD_FAILED", "E_STORAGE_MISSING"})
"""A stored source failing with these has lost its bytes: only a new source helps."""


def successor_id(attempt_id: UUID) -> UUID:
    """The one id the attempt after ``attempt_id`` may carry (retry, refresh, repair)."""
    return uuid5(attempt_id, "successor")


def lock_identity(db: Session, key: str) -> None:
    """Serialize this transaction against every holder of ``key`` (a source identity)."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key})


def latest_attempt(db: Session, media_id: UUID, *, lock: bool) -> MediaSourceAttempt | None:
    statement = (
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.media_id == media_id)
        .order_by(text(st.LATEST_ORDER_SQL))
        .limit(1)
    )
    return db.scalars(statement.with_for_update() if lock else statement).one_or_none()


def create_attempt(
    db: Session,
    *,
    id: UUID,
    media: Media,
    actor_id: UUID,
    source_type: str,
    requested_url: str | None,
    canonical_source_url: str | None,
    provider: str | None,
    provider_target_ref: str | None,
    payload: dict[str, object],
    status: Literal["accepted", "succeeded", "failed"] = "accepted",
) -> MediaSourceAttempt:
    """Append one attempt to the media's chain and record its acceptance.

    An attempt born settled (a re-added source whose media exists) mirrors the
    media's outcome, so I3 holds from its first row.
    """
    attempt_no = db.scalar(
        select(func.coalesce(func.max(MediaSourceAttempt.attempt_no), 0) + 1).where(
            MediaSourceAttempt.media_id == media.id
        )
    )
    attempt = MediaSourceAttempt(
        id=id,
        media_id=media.id,
        created_by_user_id=actor_id,
        source_type=source_type,
        attempt_no=attempt_no,
        status=status,
        requested_url=requested_url,
        canonical_source_url=canonical_source_url,
        provider=provider,
        provider_target_ref=provider_target_ref,
        source_payload=payload,
    )
    if status != st.ACCEPTED:
        attempt.finished_at = func.now()
    if status == st.FAILED:
        attempt.error_code = media.last_error_code
        attempt.error_message = media.last_error_message
    db.add(attempt)
    db.flush()
    record_event(db, attempt, SourceAccepted(source_attempt_id=id, attempt_no=attempt.attempt_no))
    if status == st.SUCCEEDED:
        record_event(db, attempt, SourceSucceeded(source_attempt_id=id))
    elif status == st.FAILED:
        record_event(
            db,
            attempt,
            SourceFailed(source_attempt_id=id, origin="Domain", terminal=True, progress=None),
            failure_code=assume_safe_failure_code(
                media.last_error_code or ApiErrorCode.E_INGEST_FAILED.value
            ),
        )
    return attempt


def enqueue_attempt(
    db: Session, attempt: MediaSourceAttempt, *, actor_id: UUID, request_id: str | None
) -> UUID:
    """Bind an accepted attempt to its one ``ingest_media_source`` job, uncommitted."""
    job = enqueue_job(
        db,
        kind="ingest_media_source",
        payload={
            "media_id": str(attempt.media_id),
            "attempt_id": str(attempt.id),
            "actor_user_id": str(actor_id),
            "request_id": request_id,
        },
    )
    attempt.job_id = job.id
    attempt.status = st.QUEUED
    attempt.updated_at = func.now()
    return job.id


def record_event(
    db: Session,
    attempt: MediaSourceAttempt,
    facts: SourceFacts,
    *,
    failure_code: SafeFailureCode | None = None,
) -> None:
    append_processing_event(
        db,
        media_id=attempt.media_id,
        facts=facts,
        stage=st.source_history_stage(
            source_type=attempt.source_type, processing_stage=attempt.processing_stage
        ),
        failure_code=failure_code,
    )


# --- supersession ---------------------------------------------------------------


def rehome_supersessions(db: Session, *, loser_media_id: UUID, winner_media_id: UUID) -> None:
    """Keep every accepted loser attempt's destination and actor before teardown.

    This includes failed attempts whose later retry found the winner, as well as
    earlier duplicates already pointing at the loser. The current destination says
    nothing about each historical attempt's processing outcome.
    """
    db.execute(
        text(
            "INSERT INTO media_source_supersessions"
            " (source_attempt_id, media_id, created_by_user_id)"
            " SELECT id, :winner, created_by_user_id FROM media_source_attempts"
            " WHERE media_id = :loser ON CONFLICT (source_attempt_id) DO NOTHING"
        ),
        {"loser": loser_media_id, "winner": winner_media_id},
    )
    db.execute(
        text("UPDATE media_source_supersessions SET media_id = :winner WHERE media_id = :loser"),
        {"loser": loser_media_id, "winner": winner_media_id},
    )


def superseding_media_id(db: Session, *, source_attempt_id: UUID) -> UUID | None:
    """The media an accepted attempt's source resolved to once its own was superseded; held
    shared so a concurrent teardown cannot move it under the caller."""
    return db.scalar(
        text(
            "SELECT media_id FROM media_source_supersessions"
            " WHERE source_attempt_id = :attempt_id FOR SHARE"
        ),
        {"attempt_id": source_attempt_id},
    )


# --- recovery policy -----------------------------------------------------------


def source_repairable_sql(media_alias: str) -> str:
    """Boolean SQL: the media's latest attempt is in flight and its exact job is dead."""
    return f"""EXISTS(
    SELECT 1
    FROM media_source_attempts latest
    JOIN background_jobs job ON job.id = latest.job_id AND job.status = 'dead'
    WHERE latest.media_id = {media_alias}.id
      AND latest.status IN ('accepted', 'queued', 'running')
      AND latest.id = (
          SELECT id FROM media_source_attempts
          WHERE media_id = {media_alias}.id
          ORDER BY {st.LATEST_ORDER_SQL}
          LIMIT 1
      )
)"""


@dataclass(frozen=True, slots=True)
class SourceRecoveryFacts:
    """What the policy decides on, for one media's latest attempt."""

    attempt_id: UUID
    attempt_status: str
    error_code: str | None
    source_type: str
    processing_status: str
    job_id: UUID | None
    repairable: bool
    is_creator: bool
    native_article_id: str | None
    article_content: XArticleContent | None


def source_recovery(facts: SourceRecoveryFacts) -> SourceRecoveryAnswer:
    """Repair a dead in-flight job, retry a failed source its creator can re-acquire (an X
    source whose refresh failed while its retained copy stays readable included), else
    nothing (or why not)."""
    source_input: SourceRecoveryInput = (
        "StoredSource" if facts.source_type in st.STORED_SOURCE_TYPES else "RefetchSource"
    )
    if facts.native_article_id is not None and (
        facts.error_code == ApiErrorCode.E_REPAIR_NOT_ALLOWED.value
        or (
            facts.source_type == st.X_ARTICLE
            and facts.article_content is not None
            and facts.article_content.representation == "browser_capture"
        )
    ):
        return "SameSourceTerminal"
    if facts.repairable and facts.job_id is not None:
        if not facts.is_creator:
            return "NotOwner"
        return RepairSourceOffer(
            expected_attempt_id=facts.attempt_id, expected_job_id=facts.job_id, input=source_input
        )
    retained_x = (
        facts.source_type in (st.X_AUTHOR_THREAD, st.X_POST, st.X_ARTICLE)
        or facts.article_content is not None
    ) and facts.processing_status == "ready_for_reading"
    if facts.attempt_status != st.FAILED or not (facts.processing_status == "failed" or retained_x):
        return None
    if not facts.is_creator:
        return "NotOwner"
    restriction = reacquisition_restriction(facts.source_type, facts.error_code)
    if restriction is not None:
        return restriction
    return RetrySourceOffer(expected_attempt_id=facts.attempt_id, input=source_input)


def source_refreshable(facts: SourceRecoveryFacts) -> bool:
    """Refresh re-acquires a settled source; the capability and the admission both ask this.
    A ready epub is published, and its reader identities are never replaced (I9)."""
    return (
        facts.is_creator
        and facts.attempt_status in (st.SUCCEEDED, st.FAILED)
        and facts.processing_status in ("ready_for_reading", "failed")
        and not (facts.source_type in st.EPUB_SOURCE_TYPES and facts.processing_status != "failed")
        and not (
            facts.native_article_id is not None
            and (
                facts.source_type == st.BROWSER_ARTICLE_CAPTURE
                or (
                    facts.article_content is not None
                    and facts.article_content.representation == "browser_capture"
                )
            )
        )
        and reacquisition_restriction(facts.source_type, facts.error_code) is None
    )


def reacquisition_restriction(
    source_type: str, error_code: str | None
) -> Literal["SameSourceTerminal", "SourceNotReacquirable"] | None:
    """Why the same source can never be re-acquired, read from the attempt's error (I3)."""
    if is_same_source_terminal_error(error_code):
        return "SameSourceTerminal"
    if source_type in st.STORED_SOURCE_TYPES and error_code in _LOST_STORED_SOURCE_CODES:
        return "SourceNotReacquirable"
    return None


def recovery_facts(
    db: Session, media: Media, attempt: MediaSourceAttempt, *, viewer_id: UUID
) -> SourceRecoveryFacts:
    """An admission's facts, read under its locks; an exact dead job stays locked."""
    dead = (
        attempt.job_id is not None
        and attempt.status in st.IN_FLIGHT
        and db.scalar(
            text("SELECT status FROM background_jobs WHERE id = :id FOR UPDATE"),
            {"id": attempt.job_id},
        )
        == "dead"
    )
    return SourceRecoveryFacts(
        attempt_id=attempt.id,
        attempt_status=attempt.status,
        error_code=attempt.error_code,
        source_type=attempt.source_type,
        processing_status=media.processing_status.value,
        job_id=attempt.job_id,
        repairable=dead,
        is_creator=media.created_by_user_id == viewer_id,
        native_article_id=native_x_article_id(
            kind=media.kind, provider=media.provider, provider_id=media.provider_id
        ),
        article_content=x_article_content_facts(db, media_ids=[media.id]).get(media.id),
    )
