"""Build-scoped web article acceptance, readiness, and read.

The research owner may select only an opaque result id from its own frozen
web-search receipt. That exact URL is accepted through the shared source-ingest
owner; the article body is then read in memory and never stored by this module.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal
from urllib.parse import urlparse
from uuid import UUID, uuid5

from llm_tools import WEB_SEARCH_SPEC
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaSourceAttempt, MediaSourceAttemptStatus, ProcessingStatus
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import JobRow, current_dead_job_for_payload
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.capabilities import is_document_status_ready
from nexus.services.durable_step_journal import Completed, read_step_states
from nexus.services.import_history import source_supersession_media_id
from nexus.services.media_read_map import load_media_document
from nexus.services.media_source_ingest import accept_url_source
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

_AWAIT_READY_LIMIT = timedelta(minutes=10)
_WEB_SEARCH_SUCCESS_ADAPTER = TypeAdapter(WEB_SEARCH_SPEC.success_type)


class WebPageOmissionReason(StrEnum):
    Gone = "Gone"
    Unsupported = "Unsupported"
    Unreadable = "Unreadable"
    SsrfBlocked = "SsrfBlocked"
    Deadline = "Deadline"


class WebPageReadDefect(RuntimeError):
    """A required page dependency exhausted or violated its owned contract."""


class _StepResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class PageAcceptResult(_StepResult):
    result_id: str = Field(min_length=1, max_length=64)
    status: Literal["Accepted", "Omitted"]
    source_attempt_id: Presence[UUID]
    media_ref: Presence[str]
    accepted_at: Presence[datetime]
    ready_deadline: Presence[datetime]
    omission_reason: Presence[WebPageOmissionReason]


class PageReadyResult(_StepResult):
    result_id: str = Field(min_length=1, max_length=64)
    status: Literal["Ready", "Pending", "Omitted"]
    omission_reason: Presence[WebPageOmissionReason]


class PageReadReceipt(_StepResult):
    result_id: str = Field(min_length=1, max_length=64)
    media_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


class WebSearchItem(_StepResult):
    result_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    title: str = Field(min_length=1, max_length=1_000)
    canonical_url: str = Field(min_length=1, max_length=4_096)
    domain: str = Field(max_length=255)
    rank: int = Field(ge=1)


class WebSearchResult(_StepResult):
    query_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[WebSearchItem]


@dataclass(frozen=True, slots=True)
class ReadWebPage:
    receipt: PageReadReceipt
    body: str


def web_search_items(raw: str, *, build_id: UUID) -> tuple[WebSearchItem, ...]:
    """Project one portable ``web.search`` Success into build-owned results."""
    terminal = json.loads(raw)
    if not isinstance(terminal, dict) or terminal.get("type") != "Success":
        raise AssertionError("Dossier Web search did not complete successfully")
    try:
        success = _WEB_SEARCH_SUCCESS_ADAPTER.validate_python(terminal["value"], strict=True)
    except ValidationError as exc:
        raise AssertionError("Dossier Web search Success is malformed") from exc
    items: list[WebSearchItem] = []
    for hit in success.results:
        try:
            validate_requested_url(hit.url)
        except (InvalidRequestError, ValueError):
            # Preserve invalid provider output for the acceptance owner to reject.
            canonical_url = hit.url
        else:
            canonical_url = normalize_url_for_display(hit.url)
        try:
            domain = (urlparse(canonical_url).hostname or "").lower()
        except ValueError:
            domain = ""
        items.append(
            WebSearchItem(
                result_id=uuid5(build_id, canonical_url).hex,
                title=hit.title,
                canonical_url=canonical_url,
                domain=domain,
                rank=hit.rank,
            )
        )
    return tuple(items)


def accept_web_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    build_id: UUID,
    job: JobRow,
    result_id: str,
) -> PageAcceptResult:
    """Accept the exact URL resolved from one build-owned search receipt."""
    item = _build_search_result(job, build_id=build_id, result_id=result_id)
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
            or ("hostname" in exc.message.lower() and "not allowed" in exc.message.lower())
            else WebPageOmissionReason.Unsupported
        )
        return omitted_web_page(result_id=result_id, reason=reason)
    attempt = db.get(MediaSourceAttempt, accepted.source_attempt_id)
    if attempt is None:
        raise WebPageReadDefect("accepted Web Article source attempt disappeared")
    return PageAcceptResult(
        result_id=result_id,
        status="Accepted",
        source_attempt_id=present(accepted.source_attempt_id),
        media_ref=present(ResourceRef(scheme="media", id=accepted.media_id).uri),
        accepted_at=present(attempt.created_at),
        ready_deadline=present(attempt.created_at + _AWAIT_READY_LIMIT),
        omission_reason=absent(),
    )


def omitted_web_page(*, result_id: str, reason: WebPageOmissionReason) -> PageAcceptResult:
    return PageAcceptResult(
        result_id=result_id,
        status="Omitted",
        source_attempt_id=absent(),
        media_ref=absent(),
        accepted_at=absent(),
        ready_deadline=absent(),
        omission_reason=present(reason),
    )


def _build_search_result(job: JobRow, *, build_id: UUID, result_id: str) -> WebSearchItem:
    states = read_step_states(job)
    for index in range(3):
        state = states.get(f"research/web-search/{index}")
        if state is None:
            continue
        if state.dispatch_phase is not Completed or not isinstance(state.terminal_result, Present):
            raise AssertionError("Web page read observed an incomplete search step")
        for item in web_search_items(state.terminal_result.value, build_id=build_id):
            if item.result_id == result_id:
                return item
    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST,
        "Web search result is not owned by this Dossier build.",
    )


def observe_web_page(db: Session, *, accepted: PageAcceptResult) -> PageReadyResult:
    """Observe readiness once; the caller yields and requeues on ``Pending``."""
    if not isinstance(accepted.source_attempt_id, Present) or not isinstance(
        accepted.ready_deadline, Present
    ):
        raise AssertionError("cannot observe an omitted Web search result")
    # Hold the accepted attempt against supersession until its history is read.
    attempt = db.scalar(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.id == accepted.source_attempt_id.value)
        .with_for_update(read=True)
    )
    winner = source_supersession_media_id(db, source_attempt_id=accepted.source_attempt_id.value)
    if isinstance(winner, Present):
        media = db.get(Media, winner.value)
        if media is None:
            raise WebPageReadDefect("canonical Web Article winner disappeared")
        ready = is_document_status_ready(media.processing_status)
        failed = media.processing_status == ProcessingStatus.failed
        error_code, error_message = media.last_error_code, media.last_error_message
    else:
        if attempt is None:
            raise WebPageReadDefect("accepted Web Article source attempt disappeared")
        ready = attempt.status == MediaSourceAttemptStatus.succeeded.value
        failed = attempt.status == MediaSourceAttemptStatus.failed.value
        error_code, error_message = attempt.error_code, attempt.error_message
    if ready:
        return PageReadyResult(
            result_id=accepted.result_id, status="Ready", omission_reason=absent()
        )
    if failed:
        reason = _terminal_omission_reason(error_code, error_message)
        if reason is None:
            raise WebPageReadDefect(
                f"Web Article source failed outside the omission contract: {error_code}"
            )
        return PageReadyResult(
            result_id=accepted.result_id, status="Omitted", omission_reason=present(reason)
        )
    if datetime.now(UTC) < accepted.ready_deadline.value:
        return PageReadyResult(
            result_id=accepted.result_id, status="Pending", omission_reason=absent()
        )
    if (
        attempt is not None
        and not isinstance(winner, Present)
        and current_dead_job_for_payload(
            db,
            kind="ingest_media_source",
            expected_payload_match={"attempt_id": str(attempt.id)},
        )
        is not None
    ):
        raise WebPageReadDefect("Web Article source job exhausted its retry budget")
    return PageReadyResult(
        result_id=accepted.result_id,
        status="Omitted",
        omission_reason=present(WebPageOmissionReason.Deadline),
    )


def read_web_page(db: Session, *, viewer_id: UUID, accepted: PageAcceptResult) -> ReadWebPage:
    """Read one ready page through the viewer boundary and freeze its receipt."""
    if not isinstance(accepted.source_attempt_id, Present):
        raise AssertionError("cannot read an unaccepted Web search result")
    attempt = db.scalar(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.id == accepted.source_attempt_id.value)
        .with_for_update(read=True)
    )
    winner = source_supersession_media_id(db, source_attempt_id=accepted.source_attempt_id.value)
    if isinstance(winner, Present):
        media_id = winner.value
    else:
        if attempt is None:
            raise WebPageReadDefect("accepted Web Article source attempt disappeared")
        if attempt.status != MediaSourceAttemptStatus.succeeded.value:
            raise WebPageReadDefect("Web Article read ran before source readiness")
        media_id = attempt.media_id
    document = load_media_document(db, viewer_id, media_id)
    if document is None or not document.body.strip():
        raise WebPageReadDefect("succeeded Web Article has no readable document")
    return ReadWebPage(
        receipt=PageReadReceipt(
            result_id=accepted.result_id,
            media_ref=ResourceRef(scheme="media", id=document.media_id).uri,
            title=document.title,
            content_fingerprint=hashlib.sha256(document.body.encode("utf-8")).hexdigest(),
        ),
        body=document.body,
    )


def _terminal_omission_reason(
    error_code: str | None,
    error_message: str | None,
) -> WebPageOmissionReason | None:
    if error_code is None:
        return None
    if error_code == "E_SOURCE_FETCH_FAILED":
        # One code covers stable HTTP absence and dependency failure; only an
        # explicit 404/410 is a modeled omission.
        return (
            WebPageOmissionReason.Gone
            if error_message in {"HTTP error: 404", "HTTP error: 410"}
            else None
        )
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
