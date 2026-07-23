"""Per-media intelligence units: the sole writer of media_summaries/media_claims.

A *media unit* is a reusable per-document summary plus a set of grounded claims,
each claim bound to an existing ``evidence_span``. Units are produced once per
content version (keyed on a content fingerprint), cached, and reused by the
aggregate Dossier reduce, ``app_search`` result cards, the reader, and the
library list.

**Grounding by construction (AC-2).** The build offers the model an ordered list
of candidate units (each content chunk plus its ``primary_evidence_span_id``) and
instructs it to cite a candidate only by integer index. After the call each
returned claim's ``candidate_index`` maps back to that candidate's
``evidence_span_id``; out-of-range indices are dropped. ``media_claims`` has a
NOT NULL ``evidence_span_id``, so an ungrounded claim is physically
unpersistable.

The lower-level unit machinery (``ensure_media_unit``, ``get_media_unit``,
``run_media_unit_build`` and the fingerprint/candidate/persist helpers) is
permission-free: it is driven by ingest, teardown and the worker, which enforce
visibility upstream. The **owner facade** — ``read_single``, ``ensure_current``
and ``ensure_current_many`` — is audience-gated: it masks unreadable media with a
404 *before* resolving any ids and never selects or keys a different summary.
Routes, agents, search, Synapse, citation enrichment and Dossier bindings consume
the facade (single / batch / bounded-many) and STOP reading ``media_summaries`` /
``media_claims`` directly.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any, Literal, assert_never, cast
from uuid import UUID

from provider_runtime import Succeeded
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import MediaSummary
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import (
    JobExecutionContext,
    enqueue_unique_job,
    get_job,
    requeue_dead_job,
    revoke_jobs_by_dedupe_keys,
    running_job_claim_is_current,
)
from nexus.logging import get_logger
from nexus.schemas.media import MediaUnitStatus
from nexus.schemas.presence import Presence, Present, absent, nullable_from_presence, present
from nexus.services.artifacts import coordination
from nexus.services.llm_execution import ExecutionRuntime, GenerationRequest, execute_generation
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StructuredSynthesisError,
    build_synthesis_intent,
    build_synthesis_prompt,
    build_synthesis_user_content,
    decode_structured_synthesis,
    ground_indices,
    outcome_failure_facts,
)

logger = get_logger(__name__)

MEDIA_UNIT_OPERATION = "media_summary"
MEDIA_UNIT_MAX_OUTPUT_TOKENS = 2000
_MEDIA_UNIT_JOB_KIND = "media_unit_build"
_MEDIA_UNIT_STEP_PATH = "synthesis"
# Budget the candidate context to leave output headroom inside the model window.
# Approximated in characters (~4 chars/token); chunks past the budget are dropped
# with a warning rather than silently capped.
MEDIA_UNIT_INPUT_CHAR_BUDGET = 60_000

# Default bound for ``ensure_current_many``: the binding-owned ceiling on how many
# per-media build durable ops an aggregate collect may fan out in one pass. The
# fan-out is always non-blocking (deduped find-or-create + enqueue, never an
# awaited N-call), so this only guards against an unbounded/degenerate request.
ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY = 8


# ---------- public contract -------------------------------------------------


@dataclass(frozen=True)
class MediaUnitRef:
    """The find-or-create outcome of ``ensure_media_unit``."""

    media_id: UUID
    summary_id: UUID
    status: MediaUnitStatus
    content_fingerprint: str
    enqueued: bool


@dataclass(frozen=True)
class MediaClaimView:
    """One grounded claim in a ready unit."""

    claim_text: str
    evidence_span_id: UUID
    ordinal: int


@dataclass(frozen=True)
class MediaUnit:
    """A ready per-media unit: summary prose plus its grounded claims."""

    media_id: UUID
    summary_md: str
    model_name: str
    content_fingerprint: str
    claims: list[MediaClaimView]


class NotReady(Enum):
    """Why a unit cannot be returned as a :class:`MediaUnit`."""

    Missing = "missing"
    Building = "building"
    Failed = "failed"
    Stale = "stale"


# The Media Abstract status (spec §252): the compact, current-only projection the
# owner facade returns. ``not_available`` == no unit head yet (never built).
MediaAbstractStatus = Literal[
    "building",
    "ready",
    "stale",
    "failed",
    "suspended",
    "not_available",
]


@dataclass(frozen=True)
class MediaProjection:
    """The authorized, compact, current-only per-media projection (Media Abstract).

    Returned by the owner facade (``read_single`` / ``ensure_current`` /
    ``read_batch`` / usable ``ensure_current_many`` items). ``summary_md`` /
    ``model_name`` are populated only when ``status == "ready"``. Grounded claims
    are NOT carried here (the abstract is compact); callers that need the claim
    set read the internal :func:`get_current` (``MediaUnit``).
    """

    media_id: UUID
    status: MediaAbstractStatus
    content_fingerprint: str
    summary_md: str | None
    model_name: str | None


class MediaOmissionReason(Enum):
    """Why an ``ensure_current_many`` subject yielded no usable projection."""

    NotAudienceVisible = "not_audience_visible"
    NoReadyUnit = "no_ready_unit"
    ProjectionPending = "projection_pending"
    ProjectionFailed = "projection_failed"
    ProjectionSuspended = "projection_suspended"
    Budget = "budget"


@dataclass(frozen=True)
class MediaOmission:
    """A per-item omission from ``ensure_current_many`` (feeds binding coverage)."""

    media_id: UUID
    reason: MediaOmissionReason


# One ``ensure_current_many`` result item: a usable projection or a typed omission.
MediaProjectionOrOmission = MediaProjection | MediaOmission


def ensure_media_unit(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the current unit head and enqueue a build when needed.

    Standalone entry (the on-demand route): owns the SERIALIZABLE transaction +
    commit + bounded serialization retry. Idempotent on ``content_fingerprint``:
    a head already at the current fingerprint and in ('ready', 'building') is
    returned untouched (``enqueued=False``). Otherwise the head is (re)set to
    ``building`` at the new fingerprint, prior claims are cleared, and a deduped
    build job is enqueued.
    """

    def op() -> MediaUnitRef:
        ref = _ensure_media_unit_core(db, media_id=media_id)
        db.commit()
        return ref

    return retry_serializable(db, "ensure_media_unit", op)


def ensure_media_unit_in_tx(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the unit head inside the caller's open transaction.

    The ingest hook: flushes but does not commit and does not switch isolation,
    so the unit (re)build enqueue is committed atomically with the caller's
    content-index writes (per concurrency.md, do not widen/split a caller-owned
    transaction). The enqueue is a DB-only insert + ``pg_notify``.
    """
    return _ensure_media_unit_core(db, media_id=media_id)


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """Delete this media's unit claims so its evidence spans can be re-extracted.

    Called by the content-index teardown (sole owner of the chunk/span lifecycle)
    inside its transaction, before it deletes the ``evidence_spans`` the claims
    reference (the FK is non-cascading). The summary head is left in place; the
    re-ingest hook re-points it to ``building`` at the new fingerprint.
    """
    db.execute(
        text(
            """
            DELETE FROM media_claims
            WHERE summary_id IN (
                SELECT id FROM media_summaries WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """Tear down this media's whole unit (claims then head) inside the caller's tx.

    The canonical unit teardown for media deletion: claims (child, FK the head and
    ``evidence_spans``) are deleted before the ``media_summaries`` head, and both
    must run before the ``media`` row and the media's ``evidence_spans`` go (both
    FKs are non-cascading per database.md). Idempotent: a no-op when no unit
    exists. The sole writer of these tables; media_deletion calls this rather than
    deleting the owned tables directly (cleanliness.md).
    """
    db.execute(
        text("DELETE FROM media_claims WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_summaries WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def media_summary_orm_or_none(db: Session, *, media_id: UUID) -> MediaSummary | None:
    """Load the unit head ORM by media id (the single home for head-ORM access)."""
    return db.scalars(
        select(MediaSummary)
        .where(MediaSummary.media_id == media_id)
        .execution_options(populate_existing=True)
    ).first()


def _ensure_media_unit_core(db: Session, *, media_id: UUID) -> MediaUnitRef:
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )

    if summary is not None:
        summary_id = UUID(str(summary["id"]))
        if summary["content_fingerprint"] == fingerprint and summary["status"] in (
            "ready",
            "building",
        ):
            return MediaUnitRef(
                media_id=media_id,
                summary_id=summary_id,
                status=cast("MediaUnitStatus", summary["status"]),
                content_fingerprint=fingerprint,
                enqueued=False,
            )
        db.execute(
            text(
                """
                UPDATE media_summaries
                SET content_fingerprint = :fingerprint,
                    summary_md = '',
                    model_name = :model_name,
                    status = 'building',
                    error_code = NULL,
                    error_detail = NULL,
                    updated_at = now()
                WHERE id = :summary_id
                """
            ),
            {
                "fingerprint": fingerprint,
                "model_name": operation_profile(MEDIA_UNIT_OPERATION).target.model,
                "summary_id": summary_id,
            },
        )
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
            {"summary_id": summary_id},
        )
    else:
        summary_id = db.execute(
            text(
                """
                INSERT INTO media_summaries (
                    media_id, content_fingerprint, summary_md, model_name, status
                )
                VALUES (:media_id, :fingerprint, '', :model_name, 'building')
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "fingerprint": fingerprint,
                "model_name": operation_profile(MEDIA_UNIT_OPERATION).target.model,
            },
        ).scalar_one()
        summary_id = UUID(str(summary_id))

    dedupe_key = f"media_unit_build:{media_id}:{fingerprint}"
    # Drop any terminal/stale build row holding this dedupe_key so enqueue_unique_job
    # inserts a fresh runnable row. A unit failure completes its background_jobs row
    # as SUCCEEDED (or FAILED/DEAD), which would otherwise own the partial-unique key
    # and make enqueue_unique_job no-op, leaving the re-set 'building' head stuck.
    # No-op for the new-head branch (no prior row) and the changed-fingerprint case
    # (the old row's key differs). An in-flight build never reaches here: a head in
    # ('ready', 'building') at the current fingerprint short-circuits above.
    revoke_jobs_by_dedupe_keys(
        db,
        kind="media_unit_build",
        dedupe_keys=[dedupe_key],
    )
    _, inserted = enqueue_unique_job(
        db,
        kind=_MEDIA_UNIT_JOB_KIND,
        dedupe_key=dedupe_key,
        payload={
            "media_id": str(media_id),
            "content_fingerprint": fingerprint,
        },
    )
    db.flush()
    return MediaUnitRef(
        media_id=media_id,
        summary_id=summary_id,
        status="building",
        content_fingerprint=fingerprint,
        enqueued=inserted,
    )


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Return the ready unit, or a :class:`NotReady` reason. Permission-free."""
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if summary is None:
        return NotReady.Missing
    status = cast("MediaUnitStatus", summary["status"])
    if status == "building":
        return NotReady.Building
    if status == "failed":
        return NotReady.Failed
    if status != "ready":
        # The ck_media_summaries_status CHECK constrains status to these three.
        assert_never(status)
    current_fingerprint = current_content_fingerprint(db, media_id=media_id)
    if summary["content_fingerprint"] != current_fingerprint:
        return NotReady.Stale

    claim_rows = (
        db.execute(
            text(
                """
            SELECT claim_text, evidence_span_id, ordinal
            FROM media_claims
            WHERE summary_id = :summary_id
            ORDER BY ordinal
            """
            ),
            {"summary_id": summary["id"]},
        )
        .mappings()
        .all()
    )
    return MediaUnit(
        media_id=media_id,
        summary_md=str(summary["summary_md"]),
        model_name=str(summary["model_name"]),
        content_fingerprint=str(summary["content_fingerprint"]),
        claims=[
            MediaClaimView(
                claim_text=str(row["claim_text"]),
                evidence_span_id=UUID(str(row["evidence_span_id"])),
                ordinal=int(row["ordinal"]),
            )
            for row in claim_rows
        ],
    )


def get_current(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Internal, permission-free single read: the current unit or a NotReady reason.

    The canonical owner-facing name for the internal media-unit read; the retained
    :func:`get_media_unit` is its untouched implementation (referenced by the
    media-unit-build worker/test seam). Consumers that hold their own visibility
    (e.g. Synapse) read the current unit through here.
    """
    return get_media_unit(db, media_id=media_id)


def read_batch(db: Session, *, media_ids: list[UUID]) -> dict[UUID, MediaProjection]:
    """Batch projection read for search / retrieval, keyed by media id.

    The set-based read model behind result-card and citation-chip enrichment:
    yields a ready :class:`MediaProjection` (``status='ready'``) only for media
    whose ``ready`` head still matches the freshly recomputed content fingerprint,
    applying the same staleness gate as :func:`get_current` so a
    re-ingested-but-not-yet-rebuilt unit is withheld. Keeps populating
    ``summary_md`` so the FE consumers that read it off search / citation DTOs do
    not silently null out. Audience filtering is the caller's (the ids are already
    visibility-scoped); this never selects a different summary.
    """
    if not media_ids:
        return {}
    rows = (
        db.execute(
            text(
                """
                SELECT media_id, summary_md, model_name, content_fingerprint
                FROM media_summaries
                WHERE media_id = ANY(:media_ids) AND status = 'ready'
                """
            ),
            {"media_ids": media_ids},
        )
        .mappings()
        .all()
    )
    projections: dict[UUID, MediaProjection] = {}
    for row in rows:
        media_id = UUID(str(row["media_id"]))
        fingerprint = str(row["content_fingerprint"])
        if fingerprint == current_content_fingerprint(db, media_id=media_id):
            projections[media_id] = MediaProjection(
                media_id=media_id,
                status="ready",
                content_fingerprint=fingerprint,
                summary_md=str(row["summary_md"]),
                model_name=str(row["model_name"]),
            )
    return projections


def _project(db: Session, *, media_id: UUID) -> MediaProjection:
    """Build the compact current-only :class:`MediaProjection` from unit state."""
    unit = get_current(db, media_id=media_id)
    if isinstance(unit, MediaUnit):
        return MediaProjection(
            media_id=media_id,
            status="ready",
            content_fingerprint=unit.content_fingerprint,
            summary_md=unit.summary_md,
            model_name=unit.model_name,
        )
    if unit is NotReady.Building:
        fingerprint = current_content_fingerprint(db, media_id=media_id)
        status: MediaAbstractStatus = (
            "suspended"
            if media_unit_build_is_suspended(
                db,
                media_id=media_id,
                content_fingerprint=fingerprint,
            )
            else "building"
        )
    elif unit is NotReady.Failed:
        status = "failed"
    elif unit is NotReady.Stale:
        row = (
            db.execute(
                text(
                    "SELECT summary_md, model_name FROM media_summaries WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        return MediaProjection(
            media_id=media_id,
            status="stale",
            content_fingerprint=current_content_fingerprint(db, media_id=media_id),
            summary_md=str(row["summary_md"]),
            model_name=str(row["model_name"]),
        )
    elif unit is NotReady.Missing:
        status = "not_available"
    else:
        assert_never(unit)
    return MediaProjection(
        media_id=media_id,
        status=status,
        content_fingerprint=current_content_fingerprint(db, media_id=media_id),
        summary_md=None,
        model_name=None,
    )


def read_single(db: Session, *, media_id: UUID, requester_user_id: UUID) -> MediaProjection:
    """Authorized single read for UI / agents: the Media Abstract for one media.

    404-masks unreadable media (raising :class:`NotFoundError`) *before* resolving
    any ids, then projects the current unit state into a :class:`MediaProjection`
    whose ``status`` carries every not-ready reason (``building`` / ``stale`` /
    ``failed`` / ``not_available``). Audience gates readability only; it never
    selects or keys a different summary.
    """
    if not can_read_media(db, requester_user_id, media_id):
        raise NotFoundError(message="Media not found")
    return _project(db, media_id=media_id)


def ensure_current(db: Session, *, media_id: UUID, requester_user_id: UUID) -> MediaProjection:
    """Authorized, idempotent-by-fingerprint ensure of the current unit.

    404-masks unreadable media, then find-or-creates the current head and enqueues
    a build when the content fingerprint moved (idempotent otherwise), returning
    the resulting compact projection (typically ``status='building'`` on first
    ensure).
    """
    if not can_read_media(db, requester_user_id, media_id):
        raise NotFoundError(message="Media not found")
    ensure_media_unit(db, media_id=media_id)
    return _project(db, media_id=media_id)


def ensure_current_many(
    db: Session,
    *,
    media_ids: list[UUID],
    requester_user_id: UUID,
    max_concurrency: int = ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY,
) -> list[MediaProjectionOrOmission]:
    """Bounded ensure + usability projection over an audience-filtered media set.

    For aggregate Dossier bindings (Library / Podcast / Contributor). Accepts an
    already-audience-filtered set that may contain duplicates; dedups by media id
    (one MI durable op per ``(media_id, current_content_fingerprint)`` — the
    enqueue is deduped on that key by :func:`ensure_media_unit`) and iterates in a
    deterministic subject order. Every step is NON-BLOCKING (find-or-create +
    enqueue, never an awaited N-call), so the single worker is never blocked;
    ``max_concurrency`` is the binding-owned ceiling on that fan-out.

    Returns one item per distinct media: a usable :class:`MediaProjection` — a
    unit that is audience-readable, ready, current for its content fingerprint and
    carries >=1 grounded (citation-candidate) claim — or a typed
    :class:`MediaOmission`. A ready-but-claimless unit is NOT usable (spec §543).
    The caller records omissions in binding coverage and, when nothing is usable,
    fails ``NoSourceMaterial`` before any Dossier dispatch.
    """
    if max_concurrency < 1:
        raise ValueError("ensure_current_many requires max_concurrency >= 1")
    ordered_media_ids = list(dict.fromkeys(media_ids))
    results: list[MediaProjectionOrOmission] = []
    for index, media_id in enumerate(ordered_media_ids):
        if index >= max_concurrency:
            results.append(MediaOmission(media_id=media_id, reason=MediaOmissionReason.Budget))
            continue
        if not can_read_media(db, requester_user_id, media_id):
            results.append(
                MediaOmission(media_id=media_id, reason=MediaOmissionReason.NotAudienceVisible)
            )
            continue
        unit = get_current(db, media_id=media_id)
        if isinstance(unit, MediaUnit) and unit.claims:
            results.append(
                MediaProjection(
                    media_id=media_id,
                    status="ready",
                    content_fingerprint=unit.content_fingerprint,
                    summary_md=unit.summary_md,
                    model_name=unit.model_name,
                )
            )
        elif isinstance(unit, MediaUnit) or not _load_candidates(db, media_id=media_id):
            results.append(
                MediaOmission(media_id=media_id, reason=MediaOmissionReason.NoReadyUnit)
            )
        elif unit is NotReady.Failed:
            results.append(
                MediaOmission(media_id=media_id, reason=MediaOmissionReason.ProjectionFailed)
            )
        elif unit is NotReady.Building and media_unit_build_is_suspended(
            db,
            media_id=media_id,
            content_fingerprint=current_content_fingerprint(db, media_id=media_id),
        ):
            results.append(
                MediaOmission(media_id=media_id, reason=MediaOmissionReason.ProjectionSuspended)
            )
        else:
            ensure_media_unit(db, media_id=media_id)
            results.append(
                MediaOmission(media_id=media_id, reason=MediaOmissionReason.ProjectionPending)
            )
    return results


def media_unit_build_is_suspended(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
) -> bool:
    """Whether the current build has no exact queue path that can still complete.

    A missing or terminal exact job is operator-owned: enqueue uniqueness is
    global by dedupe key, and manufacturing a replacement could double-dispatch
    work whose queue evidence was lost. Pending/retrying jobs, active claims, and
    expired claims below their retry budget remain live.
    """
    runnable = db.execute(
        text(
            """
            SELECT CASE
                WHEN status IN ('pending', 'failed') THEN true
                WHEN status = 'running'
                     AND (
                         lease_expires_at > now()
                         OR attempts < max_attempts
                     )
                    THEN true
                ELSE false
            END
            FROM background_jobs
            WHERE kind = :kind
              AND dedupe_key = :dedupe_key
            """
        ),
        {
            "kind": _MEDIA_UNIT_JOB_KIND,
            "dedupe_key": (f"{_MEDIA_UNIT_JOB_KIND}:{media_id}:{content_fingerprint}"),
        },
    ).scalar_one_or_none()
    return runnable is not True


# ---------- worker build ----------------------------------------------------


@dataclass(frozen=True)
class _Candidate:
    """One content chunk offered to the model by integer index."""

    evidence_span_id: UUID
    text: str


class _CompletedGroundedClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    claim_text: str
    evidence_span_id: UUID
    ordinal: int


class _CompletedSuccess(BaseModel):
    """Normalized accepted provider output carried by the replay memo."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["success"] = "success"
    summary_md: str
    claims: tuple[_CompletedGroundedClaim, ...]


class _CompletedFailure(BaseModel):
    """Normalized modeled terminal result carried by the replay memo."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["failure"] = "failure"
    error_code: str
    error_detail: Presence[str]


type _CompletedResult = Annotated[
    _CompletedSuccess | _CompletedFailure,
    Field(discriminator="outcome"),
]

_COMPLETED_RESULT_ADAPTER: TypeAdapter[_CompletedResult] = TypeAdapter(_CompletedResult)


class _UncertainMediaUnitReplayDefect(RuntimeError):
    """A provider dispatch may have landed and has no reconciliation key."""


def reconcile_uncertain_media_unit(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    resolution: coordination.UncertainStepResolution,
) -> None:
    """Repair one dead uncertain provider step and requeue the same durable job.

    ``ProveNotDispatched`` returns the step to Prepared so the next claimed
    attempt may dispatch. ``AttachReconciledResult`` strictly decodes and
    normalizes the recovered Media Intelligence terminal result, records
    Completed, and therefore guarantees that the next attempt publishes without
    dispatch. The locked canonical head, exact dedupe key, payload identity, and
    stable generation id must all still name the requested content version.
    """

    def invalid(message: str) -> InvalidRequestError:
        return InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)

    def op() -> None:
        summary = (
            db.execute(
                text(
                    "SELECT id, status, content_fingerprint FROM media_summaries "
                    "WHERE media_id = :media_id FOR UPDATE"
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if (
            summary is None
            or summary["status"] != "building"
            or summary["content_fingerprint"] != content_fingerprint
            or current_content_fingerprint(db, media_id=media_id) != content_fingerprint
        ):
            raise invalid("Media Intelligence version is not suspended and current")

        dedupe_key = f"{_MEDIA_UNIT_JOB_KIND}:{media_id}:{content_fingerprint}"
        row = (
            db.execute(
                text(
                    "SELECT id, payload FROM background_jobs "
                    "WHERE kind = :kind AND dedupe_key = :dedupe_key AND status = 'dead' "
                    "FOR UPDATE"
                ),
                {
                    "kind": _MEDIA_UNIT_JOB_KIND,
                    "dedupe_key": dedupe_key,
                },
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise invalid("Media Intelligence has no dead provider step to reconcile")
        payload = dict(row["payload"])
        if (
            str(payload.get("media_id")) != str(media_id)
            or payload.get("content_fingerprint") != content_fingerprint
        ):
            raise AssertionError("dead media unit job payload identity changed")

        raw_states = dict(payload.get("coordination") or {})
        raw_state = raw_states.get(_MEDIA_UNIT_STEP_PATH)
        if raw_state is None:
            raise invalid("Media Intelligence has no uncertain provider step to reconcile")
        state = coordination.StepReplayState.model_validate(raw_state)
        if state.dispatch_phase is not coordination.Uncertain:
            raise invalid("Media Intelligence provider step is not uncertain")
        expected_generation_id = coordination.stable_generation_id(
            media_id, f"{content_fingerprint}:{_MEDIA_UNIT_STEP_PATH}"
        )
        if state.generation_id != expected_generation_id:
            raise AssertionError("dead media unit replay generation identity changed")
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("uncertain media unit step has no request fingerprint")
        if isinstance(state.terminal_result, Present):
            raise AssertionError("uncertain media unit step already has a terminal result")

        if isinstance(resolution, coordination.AttachReconciledResult):
            normalized = _COMPLETED_RESULT_ADAPTER.validate_json(resolution.terminal_result)
            candidates = _load_candidates(db, media_id=media_id)
            user_content = _build_media_unit_user_content(candidates)
            profile = operation_profile(MEDIA_UNIT_OPERATION)
            request_fingerprint = _media_unit_request_fingerprint(
                content_fingerprint=content_fingerprint,
                candidates=candidates,
                user_content=user_content,
                provider=str(profile.target.provider),
                model=str(profile.target.model),
                reasoning=str(profile.default_reasoning_option_id),
            )
            if state.request_fingerprint.value != request_fingerprint:
                raise invalid("Media Intelligence inputs changed since provider dispatch")
            if isinstance(normalized, _CompletedSuccess):
                candidate_ids = {
                    candidate.evidence_span_id
                    for candidate in candidates
                }
                if any(
                    claim.evidence_span_id not in candidate_ids
                    for claim in normalized.claims
                ):
                    raise invalid(
                        "Recovered Media Intelligence claims must use offered evidence spans"
                    )
                if [claim.ordinal for claim in normalized.claims] != list(
                    range(len(normalized.claims))
                ):
                    raise invalid(
                        "Recovered Media Intelligence claim ordinals must be dense"
                    )
            terminal_result = _COMPLETED_RESULT_ADAPTER.dump_json(normalized).decode("utf-8")
            next_state = state.model_copy(
                update={
                    "dispatch_phase": coordination.Completed,
                    "terminal_result": present(terminal_result),
                }
            )
        elif isinstance(resolution, coordination.ProveNotDispatched):
            next_state = state.model_copy(
                update={
                    "dispatch_phase": coordination.Prepared,
                    "terminal_result": absent(),
                }
            )
        else:
            assert_never(resolution)

        raw_states[_MEDIA_UNIT_STEP_PATH] = next_state.model_dump(mode="json")
        payload["coordination"] = raw_states
        db.execute(
            text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
            {
                "payload": json.dumps(payload),
                "job_id": row["id"],
            },
        )
        if not requeue_dead_job(db, job_id=UUID(str(row["id"]))):
            raise AssertionError("locked dead media unit job could not be requeued")
        db.commit()

    retry_serializable(db, "reconcile_uncertain_media_unit", op)


async def run_media_unit_build(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    ctx: JobExecutionContext,
    runtime: ExecutionRuntime,
) -> Literal["ok", "failed"]:
    """Worker body: synthesize the summary + grounded claims for one media unit.

    The exact claimed job attempt owns one stable ``(media_id, fingerprint,
    synthesis)`` provider transition. It commits Prepared, then Uncertain
    immediately before dispatch, and Completed with a normalized result after
    dispatch. Completed replays reuse that memo; Uncertain replays defect and
    never automatically repeat a possibly billable call.

    Success and modeled-failure publication are fenced by both the captured
    content fingerprint and the exact running job lease. Superseded, deleted,
    or lease-lost work is an ``ok`` no-op.
    """
    job = get_job(db, ctx.job_id)
    if job is None:
        return "ok"
    dedupe_key = f"{_MEDIA_UNIT_JOB_KIND}:{media_id}:{content_fingerprint}"
    if (
        job.kind != _MEDIA_UNIT_JOB_KIND
        or job.dedupe_key != dedupe_key
        or str(job.payload.get("media_id")) != str(media_id)
        or job.payload.get("content_fingerprint") != content_fingerprint
    ):
        raise AssertionError(f"job {job.id} does not own media unit {media_id}")
    if not running_job_claim_is_current(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
    ):
        db.rollback()
        return "ok"

    summary = media_summary_orm_or_none(db, media_id=media_id)
    if summary is None or summary.content_fingerprint != content_fingerprint:
        db.commit()
        return "ok"
    if current_content_fingerprint(db, media_id=media_id) != content_fingerprint:
        db.commit()
        return "ok"
    summary_id = summary.id

    state = coordination.read_step_states(job).get(_MEDIA_UNIT_STEP_PATH)
    generation_id = coordination.stable_generation_id(
        media_id, f"{content_fingerprint}:{_MEDIA_UNIT_STEP_PATH}"
    )
    if state is not None and state.generation_id != generation_id:
        raise AssertionError("media unit replay generation identity changed")
    if summary.status != "building":
        # A prior attempt already applied the Completed result.
        db.commit()
        return "ok"
    if state is not None and state.dispatch_phase is coordination.Uncertain:
        raise _UncertainMediaUnitReplayDefect(
            f"media {media_id} fingerprint {content_fingerprint} synthesis is uncertain"
        )

    owner_row = db.execute(
        text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one_or_none()
    if owner_row is None:
        db.commit()
        fail_media_unit(
            db,
            summary_id=summary_id,
            expected_fingerprint=content_fingerprint,
            ctx=ctx,
            error_code="no_owner",
            error_detail="media has no owning user to attribute the provider call to",
        )
        return "failed"
    owner_user_id = UUID(str(owner_row))

    candidates = _load_candidates(db, media_id=media_id)
    if not candidates:
        db.commit()
        fail_media_unit(
            db,
            summary_id=summary_id,
            expected_fingerprint=content_fingerprint,
            ctx=ctx,
            error_code="no_candidates",
            error_detail="media has no indexed content chunks with evidence spans",
        )
        return "failed"

    user_content = _build_media_unit_user_content(candidates)
    profile = operation_profile(MEDIA_UNIT_OPERATION)
    intent = build_synthesis_intent(
        profile=profile,
        system_prompt=_MEDIA_UNIT_SYSTEM_PROMPT,
        user_content=user_content,
        max_output_tokens=MEDIA_UNIT_MAX_OUTPUT_TOKENS,
        schema=MediaUnitSynthesis,
    )
    request_fingerprint = _media_unit_request_fingerprint(
        content_fingerprint=content_fingerprint,
        candidates=candidates,
        user_content=user_content,
        provider=str(profile.target.provider),
        model=str(profile.target.model),
        reasoning=str(profile.default_reasoning_option_id),
    )
    if state is not None:
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("media unit replay state has no request fingerprint")
        if state.request_fingerprint.value != request_fingerprint:
            raise AssertionError("media unit synthesis request changed on replay")
        if state.dispatch_phase is coordination.Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError("Completed media unit step has no terminal result")
            completed = _COMPLETED_RESULT_ADAPTER.validate_json(state.terminal_result.value)
            db.commit()
            return _apply_completed_result(
                db,
                media_id=media_id,
                owner_user_id=owner_user_id,
                summary_id=summary_id,
                content_fingerprint=content_fingerprint,
                ctx=ctx,
                result=completed,
            )
        if state.dispatch_phase is not coordination.Prepared:
            raise AssertionError(f"unknown media unit dispatch phase {state.dispatch_phase!r}")

    # All request-shaping reads are complete before the external rate-limit and
    # provider boundaries.
    db.commit()
    rate_limiter = get_rate_limiter()
    try:
        rate_limiter.acquire_inflight_slot(owner_user_id)
    except ApiError as exc:
        fail_media_unit(
            db,
            summary_id=summary_id,
            expected_fingerprint=content_fingerprint,
            ctx=ctx,
            error_code=exc.code.value,
            error_detail=exc.message,
        )
        return "failed"
    try:
        if state is None:
            if not _media_unit_attempt_active(
                db,
                media_id=media_id,
                content_fingerprint=content_fingerprint,
                ctx=ctx,
            ):
                db.rollback()
                return "ok"
            prepared = coordination.StepReplayState(
                generation_id=generation_id,
                dispatch_phase=coordination.Prepared,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            )
            if not coordination.checkpoint_step_state(
                db,
                ctx=ctx,
                job=job,
                step_path=_MEDIA_UNIT_STEP_PATH,
                state=prepared,
            ):
                db.rollback()
                return "ok"
            db.commit()
            job = get_job(db, ctx.job_id)
            if job is None:
                return "ok"

        if not _media_unit_attempt_active(
            db,
            media_id=media_id,
            content_fingerprint=content_fingerprint,
            ctx=ctx,
        ):
            db.rollback()
            return "ok"
        if not coordination.checkpoint_step_state(
            db,
            ctx=ctx,
            job=job,
            step_path=_MEDIA_UNIT_STEP_PATH,
            state=coordination.StepReplayState(
                generation_id=generation_id,
                dispatch_phase=coordination.Uncertain,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            ),
        ):
            db.rollback()
            return "ok"
        db.commit()
        may_dispatch = _media_unit_attempt_active(
            db,
            media_id=media_id,
            content_fingerprint=content_fingerprint,
            ctx=ctx,
        )
        db.commit()
        if not may_dispatch:
            return "ok"

        try:
            call = await execute_generation(
                GenerationRequest(
                    owner=LlmCallOwner(kind="media_summary", id=summary_id, user_id=owner_user_id),
                    operation=MEDIA_UNIT_OPERATION,
                    profile=profile,
                    reasoning=profile.default_reasoning_option_id,
                    intent=intent,
                ),
                session_factory=get_session_factory(),
                runtime=runtime,
                settings=get_settings(),
            )
        except ApiError as exc:
            completed: _CompletedResult = _CompletedFailure(
                error_code=exc.code.value,
                error_detail=present(exc.message),
            )
        else:
            if isinstance(call.outcome, Succeeded):
                try:
                    value = decode_structured_synthesis(call.outcome, schema=MediaUnitSynthesis)
                except StructuredSynthesisError as exc:
                    logger.warning(
                        "media_unit_build.llm_failure",
                        media_id=str(media_id),
                        error_code="invalid_structured_output",
                    )
                    completed = _CompletedFailure(
                        error_code="invalid_structured_output",
                        error_detail=present(str(exc)),
                    )
                else:
                    completed = _CompletedSuccess(
                        summary_md=value.summary_md,
                        claims=tuple(
                            _CompletedGroundedClaim(
                                claim_text=claim_text,
                                evidence_span_id=evidence_span_id,
                                ordinal=ordinal,
                            )
                            for claim_text, evidence_span_id, ordinal in _map_claims_to_spans(
                                value, candidates
                            )
                        ),
                    )
            else:
                code, detail = outcome_failure_facts(call.outcome)
                logger.warning(
                    "media_unit_build.llm_failure", media_id=str(media_id), error_code=code
                )
                completed = _CompletedFailure(
                    error_code=code,
                    error_detail=present(detail) if detail is not None else absent(),
                )

        fresh_job = get_job(db, ctx.job_id)
        if fresh_job is None:
            return "ok"
        if not coordination.checkpoint_step_state(
            db,
            ctx=ctx,
            job=fresh_job,
            step_path=_MEDIA_UNIT_STEP_PATH,
            state=coordination.StepReplayState(
                generation_id=generation_id,
                dispatch_phase=coordination.Completed,
                request_fingerprint=present(request_fingerprint),
                terminal_result=present(
                    _COMPLETED_RESULT_ADAPTER.dump_json(completed).decode("utf-8")
                ),
            ),
        ):
            db.rollback()
            return "ok"
        db.commit()
        return _apply_completed_result(
            db,
            media_id=media_id,
            owner_user_id=owner_user_id,
            summary_id=summary_id,
            content_fingerprint=content_fingerprint,
            ctx=ctx,
            result=completed,
        )
    finally:
        rate_limiter.release_inflight_slot(owner_user_id)


def _media_unit_request_fingerprint(
    *,
    content_fingerprint: str,
    candidates: list[_Candidate],
    user_content: str,
    provider: str,
    model: str,
    reasoning: str,
) -> str:
    encoded = json.dumps(
        {
            "operation": MEDIA_UNIT_OPERATION,
            "content_fingerprint": content_fingerprint,
            "provider": provider,
            "model": model,
            "reasoning": reasoning,
            "system_prompt": _MEDIA_UNIT_SYSTEM_PROMPT,
            "user_content": user_content,
            "max_output_tokens": MEDIA_UNIT_MAX_OUTPUT_TOKENS,
            "schema": MediaUnitSynthesis.model_json_schema(),
            "evidence_span_ids": [str(candidate.evidence_span_id) for candidate in candidates],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _media_unit_attempt_active(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    ctx: JobExecutionContext,
) -> bool:
    if not running_job_claim_is_current(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
    ):
        return False
    if current_content_fingerprint(db, media_id=media_id) != content_fingerprint:
        return False
    return bool(
        db.execute(
            text(
                """
                SELECT EXISTS(
                    SELECT 1
                    FROM media_summaries
                    WHERE media_id = :media_id
                      AND status = 'building'
                      AND content_fingerprint = :content_fingerprint
                )
                """
            ),
            {
                "media_id": media_id,
                "content_fingerprint": content_fingerprint,
            },
        ).scalar_one()
    )


def _apply_completed_result(
    db: Session,
    *,
    media_id: UUID,
    owner_user_id: UUID,
    summary_id: UUID,
    content_fingerprint: str,
    ctx: JobExecutionContext,
    result: _CompletedResult,
) -> Literal["ok", "failed"]:
    if isinstance(result, _CompletedFailure):
        fail_media_unit(
            db,
            summary_id=summary_id,
            expected_fingerprint=content_fingerprint,
            ctx=ctx,
            error_code=result.error_code,
            error_detail=nullable_from_presence(result.error_detail),
        )
        return "failed"
    _persist_unit(
        db,
        media_id=media_id,
        owner_user_id=owner_user_id,
        summary_id=summary_id,
        summary_md=result.summary_md,
        expected_fingerprint=content_fingerprint,
        grounded=[
            (claim.claim_text, claim.evidence_span_id, claim.ordinal) for claim in result.claims
        ],
        ctx=ctx,
    )
    return "ok"


# ---------- grounding map (pure, unit-testable) -----------------------------


def _map_claims_to_spans(
    synthesis: MediaUnitSynthesis,
    candidates: list[_Candidate],
) -> list[tuple[str, UUID, int]]:
    """Map each claim's candidate_index to a span, dropping out-of-range claims.

    The bounds check is :func:`ground_indices` (policy ``"drop"``; AC-2: an
    ungrounded claim never reaches persistence). Survivors keep model order and
    are reassigned dense ordinals 0..M (caller-side concern).
    """
    survivors = (
        ground_indices(
            synthesis.claims,
            candidates,
            index_of=lambda claim: claim.candidate_index,
            policy="drop",
        )
        or []
    )
    return [
        (claim.claim_text, candidate.evidence_span_id, ordinal)
        for ordinal, (claim, candidate) in enumerate(survivors)
    ]


# ---------- internal: fingerprint / candidates / persistence ----------------


def current_content_fingerprint(db: Session, *, media_id: UUID) -> str:
    """Public, no-LLM content fingerprint: the current staleness signal for a media.

    SHA-256 of the active embedding model plus the ordered chunk-text hashes.
    Changes whenever the media is re-extracted (chunk set or active index run
    changes), which is the staleness signal for units and every Dossier that
    depends on the media. Works for not-ready media (an empty content index hashes
    to a stable value). Sole reader/definer of this fingerprint; callers (freshness
    checks, publish fencing, aggregate dedup) MUST route through here rather than
    reading the stored ``media_summaries.content_fingerprint`` column.
    """
    index_state = (
        db.execute(
            text(
                """
            SELECT active_embedding_provider, active_embedding_model, updated_at
            FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    provider = (index_state or {}).get("active_embedding_provider")
    model = (index_state or {}).get("active_embedding_model")
    index_generation = (index_state or {}).get("updated_at")

    chunk_rows = (
        db.execute(
            text(
                """
            SELECT chunk_idx, chunk_text
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    canonical = {
        "active_embedding_provider": provider,
        "active_embedding_model": model,
        "active_index_generation": (
            index_generation.isoformat()
            if index_generation is not None
            else None
        ),
        "chunks": [
            [
                int(row["chunk_idx"]),
                hashlib.sha256(str(row["chunk_text"]).encode("utf-8")).hexdigest(),
            ]
            for row in chunk_rows
        ],
    }
    serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _load_candidates(db: Session, *, media_id: UUID) -> list[_Candidate]:
    rows = (
        db.execute(
            text(
                """
            SELECT cc.chunk_text, es.span_text, cc.primary_evidence_span_id
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
              AND cc.primary_evidence_span_id IS NOT NULL
            ORDER BY cc.chunk_idx
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )

    candidates: list[_Candidate] = []
    used_chars = 0
    for row in rows:
        candidate_text = str(row["span_text"] or row["chunk_text"] or "")
        if used_chars + len(candidate_text) > MEDIA_UNIT_INPUT_CHAR_BUDGET and candidates:
            dropped = len(rows) - len(candidates)
            logger.warning(
                "media_unit_build.candidates_truncated",
                media_id=str(media_id),
                kept=len(candidates),
                dropped=dropped,
                char_budget=MEDIA_UNIT_INPUT_CHAR_BUDGET,
            )
            break
        used_chars += len(candidate_text)
        candidates.append(
            _Candidate(
                evidence_span_id=UUID(str(row["primary_evidence_span_id"])),
                text=candidate_text,
            )
        )
    return candidates


def _persist_unit(
    db: Session,
    *,
    media_id: UUID,
    owner_user_id: UUID,
    summary_id: UUID,
    summary_md: str,
    expected_fingerprint: str,
    grounded: list[tuple[str, UUID, int]],
    ctx: JobExecutionContext,
) -> None:
    def op() -> None:
        # Publish fence, keyed on the media-canonical head (spec §601-603):
        # ``WHERE media_id = :media_id AND content_fingerprint = :captured``. A
        # concurrent re-ingest commits a new fingerprint (and replaces
        # evidence_spans) or a deletion drops the head during the LLM window;
        # under READ COMMITTED this UPDATE then matches 0 rows (reingestion or
        # deletion won), so the superseded build bails before the FK-violating
        # claim INSERTs and never clobbers the live 'building' head. UNIQUE(media_id)
        # makes the media_id key target exactly the one live head.
        result = cast(
            "Any",
            db.execute(
                text(
                    """
                    UPDATE media_summaries
                    SET summary_md = :summary_md,
                        status = 'ready',
                        error_code = NULL,
                        error_detail = NULL,
                        updated_at = now()
                    WHERE media_id = :media_id
                      AND status = 'building'
                      AND content_fingerprint = :expected_fingerprint
                      AND EXISTS (
                          SELECT 1
                          FROM background_jobs
                          WHERE id = :job_id
                            AND status = 'running'
                            AND claimed_by = :worker_id
                            AND attempts = :attempt_no
                            AND lease_expires_at > now()
                      )
                    """
                ),
                {
                    "summary_md": summary_md,
                    "media_id": media_id,
                    "expected_fingerprint": expected_fingerprint,
                    "job_id": ctx.job_id,
                    "worker_id": ctx.worker_id,
                    "attempt_no": ctx.attempt_no,
                },
            ),
        )
        if result.rowcount == 0:
            db.rollback()
            return

        from nexus.services import synapse
        from nexus.services.atlas_projection import try_enqueue_atlas_project

        synapse.queue_synapse_scan(
            db,
            user_id=owner_user_id,
            ref=ResourceRef(scheme="media", id=media_id),
            reason="media_unit_ready",
        )
        # Re-project the grand atlas once the unpositioned backlog is meaningful
        # (soft, dedupes, rides this transaction — grand-atlas §S1.5).
        try_enqueue_atlas_project(db, user_id=owner_user_id)
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
            {"summary_id": summary_id},
        )
        for claim_text, evidence_span_id, ordinal in grounded:
            db.execute(
                text(
                    """
                    INSERT INTO media_claims (
                        media_id, summary_id, claim_text, evidence_span_id, ordinal
                    )
                    VALUES (
                        :media_id, :summary_id, :claim_text, :evidence_span_id, :ordinal
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "summary_id": summary_id,
                    "claim_text": claim_text,
                    "evidence_span_id": evidence_span_id,
                    "ordinal": ordinal,
                },
            )
        db.commit()

    retry_serializable(db, "_persist_unit", op)


def fail_media_unit(
    db: Session,
    *,
    summary_id: UUID,
    expected_fingerprint: str,
    ctx: JobExecutionContext,
    error_code: str,
    error_detail: str | None,
) -> None:
    """Set the exact owned unit version ``failed`` with the error floor.

    The content fingerprint and running-attempt lease are checked atomically
    with the update. A superseded build or stale worker therefore cannot fail
    the live head. ``error_detail`` is operator-facing, never rendered.
    """

    def op() -> None:
        db.execute(
            text(
                """
                UPDATE media_summaries
                SET status = 'failed',
                    error_code = :error_code,
                    error_detail = :error_detail,
                    updated_at = now()
                WHERE id = :summary_id
                  AND status = 'building'
                  AND content_fingerprint = :expected_fingerprint
                  AND EXISTS (
                      SELECT 1
                      FROM background_jobs
                      WHERE id = :job_id
                        AND status = 'running'
                        AND claimed_by = :worker_id
                        AND attempts = :attempt_no
                        AND lease_expires_at > now()
                  )
                """
            ),
            {
                "summary_id": summary_id,
                "expected_fingerprint": expected_fingerprint,
                "job_id": ctx.job_id,
                "worker_id": ctx.worker_id,
                "attempt_no": ctx.attempt_no,
                "error_code": error_code,
                "error_detail": error_detail,
            },
        )
        db.commit()

    retry_serializable(db, "fail_media_unit", op)


# ---------- internal: prompt + schema ---------------------------------------


class MediaUnitClaimOut(BaseModel):
    """One claim in the model's strict-JSON output."""

    model_config = ConfigDict(extra="forbid")

    claim_text: str
    candidate_index: int


class MediaUnitSynthesis(BaseModel):
    """The strict-JSON unit synthesis shape."""

    model_config = ConfigDict(extra="forbid")

    summary_md: str
    claims: list[MediaUnitClaimOut]


# Prompt decomposition for the shared synthesis scaffold; the assembled bytes
# are pinned (golden) in tests/test_structured_synthesis.py.
_MEDIA_UNIT_PERSONA = (
    "You are a careful research assistant building a reusable unit for one "
    "document: a concise summary plus a set of atomic, grounded claims."
)
_MEDIA_UNIT_DOMAIN_RULES = [
    INDEX_GROUNDING_RULE + " Do not invent passages, indices, sources, or quotations.",
    "Write summary_md: a faithful markdown abstract of the document "
    "(2-5 sentences), based only on the candidate passages.",
    "Write claims: each is one atomic, self-contained factual statement the "
    "document makes, paired with the candidate_index of the single passage that "
    "best supports it. Only emit a claim you can ground in a provided candidate.",
]
_MEDIA_UNIT_JSON_SHAPE = (
    '{"summary_md": string, "claims": [{"claim_text": string, "candidate_index": int}]}'
)
_MEDIA_UNIT_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=_MEDIA_UNIT_PERSONA,
    preamble=None,
    domain_rules=_MEDIA_UNIT_DOMAIN_RULES,
    json_shape=_MEDIA_UNIT_JSON_SHAPE,
)


def _build_media_unit_user_content(candidates: list[_Candidate]) -> str:
    rendered = "\n\n".join(
        f"[{index}] {candidate.text}" for index, candidate in enumerate(candidates)
    )
    return build_synthesis_user_content(
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=None,
    )
