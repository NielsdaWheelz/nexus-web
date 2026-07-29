"""Build-scoped Web Article acceptance and read for Dossier research.

The caller may select only an opaque result id from its frozen web-search
receipt.  URL resolution stays in the research owner; this service accepts that
exact resolved result through the existing source-ingest and Web Article read
owners, then returns a body only in memory.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from nexus.db.models import MediaSourceAttempt, MediaSourceAttemptStatus
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import JobRow, current_dead_job_for_payload, get_job
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.artifacts.coordination import (
    Completed,
    decode_step_result,
    read_step_states,
)
from nexus.services.media_read_map import DocumentRead, load_media_document
from nexus.services.media_source_ingest import accept_url_source
from nexus.services.resource_graph.refs import ResourceRef

_AWAIT_READY_LIMIT = timedelta(minutes=10)


class WebPageOmissionReason(StrEnum):
    Gone = "Gone"
    Unsupported = "Unsupported"
    Unreadable = "Unreadable"
    SsrfBlocked = "SsrfBlocked"
    Deadline = "Deadline"


class _StrictStepResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class PageAcceptResult(_StrictStepResult):
    result_id: str = Field(min_length=1, max_length=64)
    status: Literal["Accepted", "Omitted"]
    source_attempt_id: Presence[UUID]
    media_ref: Presence[str]
    accepted_at: Presence[datetime]
    ready_deadline: Presence[datetime]
    omission_reason: Presence[WebPageOmissionReason]

    @model_validator(mode="after")
    def _exact_variant(self) -> PageAcceptResult:
        accepted_fields = (
            self.source_attempt_id,
            self.media_ref,
            self.accepted_at,
            self.ready_deadline,
        )
        if self.status == "Accepted":
            if not all(isinstance(field, Present) for field in accepted_fields) or isinstance(
                self.omission_reason, Present
            ):
                raise ValueError("Accepted page result has an invalid field union")
        elif any(isinstance(field, Present) for field in accepted_fields) or not isinstance(
            self.omission_reason, Present
        ):
            raise ValueError("Omitted page result has an invalid field union")
        return self


class PageReadyResult(_StrictStepResult):
    result_id: str = Field(min_length=1, max_length=64)
    status: Literal["Ready", "Pending", "Omitted"]
    omission_reason: Presence[WebPageOmissionReason]

    @model_validator(mode="after")
    def _exact_variant(self) -> PageReadyResult:
        has_reason = isinstance(self.omission_reason, Present)
        if (self.status == "Omitted") != has_reason:
            raise ValueError("page readiness result has an invalid field union")
        return self


class PageReadReceipt(_StrictStepResult):
    result_id: str = Field(min_length=1, max_length=64)
    media_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


class WebSearchItem(_StrictStepResult):
    result_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    title: str = Field(min_length=1, max_length=1_000)
    canonical_url: str = Field(min_length=1, max_length=4_096)
    domain: str = Field(max_length=255)
    rank: int = Field(ge=1)


class WebSearchResult(_StrictStepResult):
    query_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[WebSearchItem]


@dataclass(frozen=True, slots=True)
class ReadWebPage:
    receipt: PageReadReceipt
    body: str


class WebPageReadDefect(RuntimeError):
    """The required page dependency exhausted or violated its owned contract."""


def accept_web_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    build_id: UUID,
    job: JobRow,
    result_id: str,
) -> PageAcceptResult:
    """Accept the exact URL resolved from one build-owned search receipt."""

    item = _resolve_build_search_result(job, result_id=result_id)
    try:
        accepted = accept_url_source(
            db=db,
            viewer_id=viewer_id,
            url=item.canonical_url,
            library_ids=[],
            idempotency_key=f"artifact-research:{build_id}:{result_id}",
            ingest_purpose="artifact_research",
        )
    except InvalidRequestError as exc:
        reason = (
            WebPageOmissionReason.SsrfBlocked
            if exc.code is ApiErrorCode.E_SSRF_BLOCKED
            or "hostname" in exc.message.lower()
            and "not allowed" in exc.message.lower()
            else WebPageOmissionReason.Unsupported
        )
        return omitted_web_search_result(result_id=result_id, reason=reason)
    attempt = db.get(MediaSourceAttempt, accepted.source_attempt_id)
    if attempt is None:
        # justify-defect: acceptance returns only after creating or replaying
        # its durable source-attempt row.
        raise WebPageReadDefect("accepted Web Article source attempt disappeared")
    accepted_at = attempt.created_at
    return PageAcceptResult(
        result_id=result_id,
        status="Accepted",
        source_attempt_id=present(accepted.source_attempt_id),
        media_ref=present(ResourceRef(scheme="media", id=accepted.media_id).uri),
        accepted_at=present(accepted_at),
        ready_deadline=present(accepted_at + _AWAIT_READY_LIMIT),
        omission_reason=absent(),
    )


def _resolve_build_search_result(job: JobRow, *, result_id: str) -> WebSearchItem:
    matches: list[WebSearchItem] = []
    states = read_step_states(job)
    for index in range(3):
        state = states.get(f"research/web-search/{index}")
        if state is None:
            continue
        if state.dispatch_phase is not Completed or not isinstance(state.terminal_result, Present):
            raise AssertionError("Web page read observed an incomplete search step")
        result = decode_step_result(state.terminal_result.value, WebSearchResult)
        matches.extend(item for item in result.items if item.result_id == result_id)
    if not matches:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Web search result is not owned by this Dossier build.",
        )
    first = matches[0]
    if any(item.canonical_url != first.canonical_url for item in matches[1:]):
        raise AssertionError("one build-scoped Web result id resolved to multiple URLs")
    return first


def omitted_web_search_result(
    *,
    result_id: str,
    reason: WebPageOmissionReason,
) -> PageAcceptResult:
    return PageAcceptResult(
        result_id=result_id,
        status="Omitted",
        source_attempt_id=absent(),
        media_ref=absent(),
        accepted_at=absent(),
        ready_deadline=absent(),
        omission_reason=present(reason),
    )


def observe_web_page(
    db: Session,
    *,
    accepted: PageAcceptResult,
    now: datetime | None = None,
) -> PageReadyResult:
    """Observe readiness once; callers yield/requeue on the Pending variant."""

    observed_at = now or datetime.now(UTC)
    if accepted.status != "Accepted":
        raise AssertionError("cannot observe an omitted Web search result")
    if not isinstance(accepted.source_attempt_id, Present) or not isinstance(
        accepted.ready_deadline, Present
    ):
        raise AssertionError("accepted Web search result is incomplete")
    attempt = db.get(MediaSourceAttempt, accepted.source_attempt_id.value)
    if attempt is None:
        # justify-defect: the completed acceptance receipt owns this durable row.
        raise WebPageReadDefect("accepted Web Article source attempt disappeared")
    if attempt.status == MediaSourceAttemptStatus.succeeded.value:
        return PageReadyResult(
            result_id=accepted.result_id,
            status="Ready",
            omission_reason=absent(),
        )
    if attempt.status == MediaSourceAttemptStatus.failed.value:
        reason = _terminal_omission_reason(
            attempt.error_code,
            attempt.error_message,
        )
        if reason is None:
            # justify-defect: a persistent source/provider dependency failure is
            # not a soft content omission.
            raise WebPageReadDefect(
                f"Web Article source failed outside the omission contract: {attempt.error_code}"
            )
        return PageReadyResult(
            result_id=accepted.result_id,
            status="Omitted",
            omission_reason=present(reason),
        )
    if attempt.status == MediaSourceAttemptStatus.superseded.value:
        # justify-defect: canonical URL dedupe rehomes the accepted attempt onto
        # the winner before the common terminal publication.
        raise WebPageReadDefect("Web Article attempt stopped at superseded")
    if observed_at < accepted.ready_deadline.value:
        return PageReadyResult(
            result_id=accepted.result_id,
            status="Pending",
            omission_reason=absent(),
        )
    dead_job = current_dead_job_for_payload(
        db,
        kind="ingest_media_source",
        expected_payload_match={"attempt_id": str(attempt.id)},
    )
    if dead_job is not None:
        # justify-defect: the required source dependency exhausted the queue's
        # retry budget; errors.md forbids downgrading it to a content omission.
        raise WebPageReadDefect("Web Article source job exhausted its retry budget")
    return PageReadyResult(
        result_id=accepted.result_id,
        status="Omitted",
        omission_reason=present(WebPageOmissionReason.Deadline),
    )


def read_web_page(
    db: Session,
    *,
    viewer_id: UUID,
    accepted: PageAcceptResult,
) -> ReadWebPage:
    """Read one ready page through the viewer boundary and freeze its receipt."""

    if accepted.status != "Accepted" or not isinstance(accepted.source_attempt_id, Present):
        raise AssertionError("cannot read an unaccepted Web search result")
    attempt = db.get(MediaSourceAttempt, accepted.source_attempt_id.value)
    if attempt is None:
        raise WebPageReadDefect("accepted Web Article source attempt disappeared")
    if attempt.status != MediaSourceAttemptStatus.succeeded.value:
        raise WebPageReadDefect("Web Article read ran before source readiness")
    document = load_media_document(db, viewer_id, attempt.media_id)
    if document is None:
        document = _load_canonical_dedupe_winner(
            db,
            viewer_id=viewer_id,
            attempt=attempt,
        )
    if document is None:
        raise WebPageReadDefect("succeeded Web Article has no readable document")
    if not document.body.strip():
        raise WebPageReadDefect("succeeded Web Article has an empty document")
    body = document.body
    return ReadWebPage(
        receipt=PageReadReceipt(
            result_id=accepted.result_id,
            media_ref=ResourceRef(scheme="media", id=document.media_id).uri,
            title=document.title,
            content_fingerprint=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        ),
        body=body,
    )


def _load_canonical_dedupe_winner(
    db: Session,
    *,
    viewer_id: UUID,
    attempt: MediaSourceAttempt,
) -> DocumentRead | None:
    """Follow the source job's exact canonical-dedupe result when present."""

    if attempt.job_id is None:
        raise WebPageReadDefect("succeeded Web Article attempt has no source job")
    job = get_job(db, attempt.job_id)
    if job is None:
        raise WebPageReadDefect("succeeded Web Article source job disappeared")
    if job.status != "succeeded":
        if job.status in {"pending", "running", "failed"}:
            return None
        raise WebPageReadDefect(
            f"succeeded Web Article source job has terminal status {job.status}"
        )
    raw_winner = (job.result or {}).get("superseded_by_media_id")
    if raw_winner is None:
        raise WebPageReadDefect("succeeded Web Article did not publish its accepted media")
    try:
        winner_id = UUID(str(raw_winner))
    except ValueError as exc:
        raise WebPageReadDefect("Web Article dedupe winner is malformed") from exc
    document = load_media_document(db, viewer_id, winner_id)
    if document is None:
        raise WebPageReadDefect("canonical Web Article winner is not readable")
    return document


def _terminal_omission_reason(
    error_code: str | None,
    error_message: str | None,
) -> WebPageOmissionReason | None:
    if error_code is None:
        return None
    if error_code == "E_SOURCE_FETCH_FAILED":
        # The source owner uses one code for stable HTTP absence and dependency
        # failures. Only explicit 404/410 terminals are modeled omissions;
        # timeout, network, redirect, 429, and 5xx failures remain defects.
        if error_message in {"HTTP error: 404", "HTTP error: 410"}:
            return WebPageOmissionReason.Gone
        return None
    return {
        "E_INVALID_REQUEST": WebPageOmissionReason.Unsupported,
        "E_INVALID_KIND": WebPageOmissionReason.Unsupported,
        "E_INVALID_CONTENT_TYPE": WebPageOmissionReason.Unsupported,
        "E_SOURCE_TOO_LARGE": WebPageOmissionReason.Unsupported,
        "E_SOURCE_ACCESS_DENIED": WebPageOmissionReason.Unreadable,
        "E_SOURCE_NOT_READABLE": WebPageOmissionReason.Unreadable,
        "E_SSRF_BLOCKED": WebPageOmissionReason.SsrfBlocked,
        "E_SANITIZATION_FAILED": WebPageOmissionReason.Unreadable,
    }.get(error_code)
