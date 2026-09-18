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
visibility upstream. The **owner facade** — ``read_single``, ``read_batch`` and
``ensure_current_many`` — is audience-gated: it masks unreadable media with a
404 *before* resolving any ids and never selects or keys a different summary.
Routes, agents, search, Synapse, citation enrichment and Dossier bindings consume
the facade (single / batch / bounded-many) and STOP reading ``media_summaries`` /
``media_claims`` directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any, Literal, assert_never, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import MediaSummary
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    lock_jobs_for_payload,
    replace_dead_job_payload,
    requeue_dead_job,
    running_job_claim_is_current,
)
from nexus.logging import get_logger
from nexus.schemas.media import MediaUnitStatus
from nexus.schemas.presence import Presence, Present, absent, nullable_from_presence, present
from nexus.services import durable_step_journal as step_journal
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommandDraft,
    GenerationTerminal,
)
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_spec import (
    ImmutablePromptPayloadRef,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    AttachReconciledGenerationTerminal,
    CompletedGeneration,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationFailureCode,
    GenerationReconciliationRequest,
    GenerationUncertain,
    GenerationUncertainResolution,
    JobGenerationJournal,
    admit_job_generation,
    cancel_prepared_generation_without_dispatch_in_current_transaction,
    codex_terminal_evidence,
    execute_generation,
    prove_uncertain_generation_not_dispatched_in_current_transaction,
    reconcile_uncertain_generation_in_current_transaction,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
)
from nexus.services.media_intelligence_lifecycle import (
    MEDIA_UNIT_JOB_KIND as _MEDIA_UNIT_JOB_KIND,
)
from nexus.services.media_intelligence_lifecycle import (
    MEDIA_UNIT_OPERATION,
    current_content_fingerprint,
    ensure_media_unit,
)
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

    Returned by the owner facade (``read_single`` / ``read_batch`` / usable
    ``ensure_current_many`` items). ``summary_md`` /
    ``model_name`` are populated only when ``status == "ready"``. Grounded claims
    are NOT carried here (the abstract is compact); callers that need the claim
    set read the internal :func:`get_media_unit` (``MediaUnit``).
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


def media_summary_orm_or_none(db: Session, *, media_id: UUID) -> MediaSummary | None:
    """Load the unit head ORM by media id (the single home for head-ORM access)."""
    return db.scalars(
        select(MediaSummary)
        .where(MediaSummary.media_id == media_id)
        .execution_options(populate_existing=True)
    ).first()


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Internal, permission-free single read: the current unit or a NotReady reason.

    Consumers that hold their own visibility (e.g. Synapse) read the current unit
    through here.
    """
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


def read_batch(db: Session, *, media_ids: list[UUID]) -> dict[UUID, MediaProjection]:
    """Batch projection read for search / retrieval, keyed by media id.

    The set-based read model behind result-card and citation-chip enrichment:
    yields a ready :class:`MediaProjection` (``status='ready'``) only for media
    whose ``ready`` head still matches the freshly recomputed content fingerprint,
    applying the same staleness gate as :func:`get_media_unit` so a
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
    unit = get_media_unit(db, media_id=media_id)
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
        unit = get_media_unit(db, media_id=media_id)
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
            results.append(MediaOmission(media_id=media_id, reason=MediaOmissionReason.NoReadyUnit))
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
    """Normalized accepted generation output carried by the replay memo."""

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


class _CompletedSkip(BaseModel):
    """Owner no-op proven before a new generation could be accepted."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["skip"] = "skip"
    reason: str = Field(min_length=1, max_length=120)


type _CompletedResult = Annotated[
    _CompletedSuccess | _CompletedFailure | _CompletedSkip,
    Field(discriminator="outcome"),
]

_COMPLETED_RESULT_ADAPTER: TypeAdapter[_CompletedResult] = TypeAdapter(_CompletedResult)


def _complete_prepared_media_unit_without_dispatch(
    db: Session,
    *,
    owner: LlmCallOwner,
    ctx: JobExecutionContext,
    state: step_journal.StepReplayState,
    result: _CompletedResult,
    reason: str,
) -> bool:
    """Atomically cancel a preaccept start and complete the owner journal."""

    # Earlier owner checks are snapshot reads. Start a fresh transaction so the
    # generation-owner advisory lock remains the first lock in this transition.
    db.rollback()
    terminal_result = _COMPLETED_RESULT_ADAPTER.dump_json(result).decode("utf-8")
    next_state = cancel_prepared_generation_without_dispatch_in_current_transaction(
        db,
        owner=owner,
        state=state,
        terminal_result=terminal_result,
        reason=reason,
    )
    job = get_job(db, ctx.job_id)
    if job is None or step_journal.read_step_states(job).get(_MEDIA_UNIT_STEP_PATH) != state:
        db.rollback()
        return False
    if not step_journal.checkpoint_step_state(
        db,
        ctx=ctx,
        job=job,
        step_path=_MEDIA_UNIT_STEP_PATH,
        state=next_state,
    ):
        db.rollback()
        return False
    db.commit()
    return True


def _media_unit_intent(*, user_content: str) -> GenerationIntent:
    return build_synthesis_intent(
        system_prompt=_MEDIA_UNIT_SYSTEM_PROMPT,
        user_content=user_content,
        schema=MediaUnitSynthesis,
    )


def _encode_media_unit_terminal(
    terminal: GenerationTerminal,
    *,
    candidates: list[_Candidate],
) -> EncodedGenerationTerminal:
    accepted_failure: AcceptedGenerationFailure | None = None
    if terminal.status == "succeeded":
        try:
            value = decode_structured_synthesis(terminal, schema=MediaUnitSynthesis)
            grounded_claims = _map_claims_to_spans(value, candidates)
            if len(grounded_claims) != len(value.claims):
                raise StructuredSynthesisError(
                    "media summary output references a candidate index that was not offered"
                )
        except StructuredSynthesisError as exc:
            detail = str(exc)
            completed: _CompletedResult = _CompletedFailure(
                error_code="invalid_output",
                error_detail=present(detail),
            )
            accepted_failure = AcceptedGenerationFailure(
                code="invalid_output",
                detail=detail,
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
                    for claim_text, evidence_span_id, ordinal in grounded_claims
                ),
            )
    else:
        code, detail = outcome_failure_facts(terminal)
        completed = _CompletedFailure(
            error_code=code,
            error_detail=present(detail) if detail is not None else absent(),
        )
    return EncodedGenerationTerminal(
        terminal_result=_COMPLETED_RESULT_ADAPTER.dump_json(completed).decode("utf-8"),
        accepted_failure=accepted_failure,
    )


def _encode_media_unit_failure(
    code: GenerationFailureCode,
    detail: str,
) -> str:
    return _COMPLETED_RESULT_ADAPTER.dump_json(
        _CompletedFailure(error_code=code, error_detail=present(detail))
    ).decode("utf-8")


class _UncertainMediaUnitReplayDefect(RuntimeError):
    """A generation dispatch may have landed and has no reconciliation key."""


def reconcile_uncertain_media_unit(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    resolution: GenerationUncertainResolution,
) -> None:
    """Repair one dead uncertain generation and requeue the same durable job.

    ``ProveNotDispatched`` returns the step to Prepared so the next claimed
    attempt may dispatch. Terminal attachment accepts only the raw, strict host
    terminal and routes it through the same ledger + domain codec used by live
    landing. The serializable snapshot must reproduce the original command
    fingerprint from the still-current content version before attachment can
    land. The non-dispatch proof uses only journal/ledger identity. Ledger
    terminalization, journal completion, and same-job requeue share one
    caller-owned transaction; publication remains the worker's later replay.
    """

    def invalid(message: str) -> InvalidRequestError:
        return InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)

    if not isinstance(
        resolution,
        (step_journal.ProveNotDispatched, AttachReconciledGenerationTerminal),
    ):
        raise invalid("Media Intelligence requires generation reconciliation evidence")

    def op() -> None:
        summary_id = db.execute(
            text("SELECT id FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).scalar_one_or_none()
        if summary_id is None:
            raise invalid("Media Intelligence version is not suspended and current")
        summary_id = UUID(str(summary_id))
        owner = LlmCallOwner(kind="media_summary", id=summary_id)
        # The shared owner key is the first lock in every live and repair path.
        lock_generation_owner_in_current_transaction(db, owner)
        summary = (
            db.execute(
                text(
                    "SELECT id, status, content_fingerprint FROM media_summaries "
                    "WHERE id = :summary_id AND media_id = :media_id FOR UPDATE"
                ),
                {"summary_id": summary_id, "media_id": media_id},
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
            raise invalid("Media Intelligence has no dead generation step to reconcile")
        payload = dict(row["payload"])
        if (
            str(payload.get("media_id")) != str(media_id)
            or str(payload.get("summary_id")) != str(summary_id)
            or payload.get("content_fingerprint") != content_fingerprint
        ):
            raise AssertionError("dead media unit job payload identity changed")

        raw_states = dict(payload.get("coordination") or {})
        raw_state = raw_states.get(_MEDIA_UNIT_STEP_PATH)
        if raw_state is None:
            raise invalid("Media Intelligence has no uncertain generation step to reconcile")
        state = step_journal.StepReplayState.model_validate(raw_state)
        if state.dispatch_phase is not step_journal.Uncertain:
            raise invalid("Media Intelligence generation step is not uncertain")
        expected_generation_id = step_journal.stable_generation_id(
            media_id, f"{content_fingerprint}:{_MEDIA_UNIT_STEP_PATH}"
        )
        if state.generation_id != expected_generation_id:
            raise AssertionError("dead media unit replay generation identity changed")
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("uncertain media unit step has no request fingerprint")
        if isinstance(state.terminal_result, Present):
            raise AssertionError("uncertain media unit step already has a terminal result")

        if isinstance(resolution, step_journal.ProveNotDispatched):
            next_state = prove_uncertain_generation_not_dispatched_in_current_transaction(
                db,
                owner=owner,
                state=state,
            )
        else:
            candidates = _load_candidates(db, media_id=media_id)
            raw_admissions = payload.get("generation_admissions")
            if not isinstance(raw_admissions, dict):
                raise invalid("Media Intelligence has no frozen generation admission")
            raw_admission = raw_admissions.get(_MEDIA_UNIT_STEP_PATH)
            if not isinstance(raw_admission, dict) or set(raw_admission) != {
                "spec",
                "intent",
            }:
                raise invalid("Media Intelligence frozen admission is invalid")
            spec = decode_generation_spec_document(raw_admission["spec"])
            raw_intent = raw_admission["intent"]
            if not isinstance(raw_intent, dict):
                raise invalid("Media Intelligence frozen intent is invalid")
            intent = GenerationIntent.model_validate(raw_intent)
            current_intent = _media_unit_intent(
                user_content=_build_media_unit_user_content(candidates)
            )
            if state.request_fingerprint.value != spec.fingerprint or intent != current_intent:
                raise invalid("Media Intelligence inputs changed since generation dispatch")
            draft = GenerationCommandDraft(
                request_id=state.generation_id,
                spec=spec,
                intent=intent,
            )
            next_state = reconcile_uncertain_generation_in_current_transaction(
                db,
                GenerationReconciliationRequest(
                    owner=owner,
                    draft=draft,
                    state=state,
                    resolution=resolution,
                ),
                encode_terminal=lambda terminal: _encode_media_unit_terminal(
                    codex_terminal_evidence(terminal),
                    candidates=candidates,
                ),
            )

        payload = step_journal.payload_with_step_state(
            payload,
            step_path=_MEDIA_UNIT_STEP_PATH,
            state=next_state,
        )
        job_id = UUID(str(row["id"]))
        if not replace_dead_job_payload(db, job_id=job_id, payload=payload):
            raise AssertionError("locked dead media unit job changed during reconciliation")
        if not requeue_dead_job(db, job_id=job_id):
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
) -> Literal["ok", "failed"] | RescheduleRequested:
    """Worker body: synthesize the summary + grounded claims for one media unit.

    The exact claimed job attempt owns one stable ``(media_id, fingerprint,
    synthesis)`` generation transition. It commits Prepared, then Uncertain
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
    try:
        summary_id = UUID(str(job.payload["summary_id"]))
    except (KeyError, ValueError) as exc:
        raise AssertionError(f"job {job.id} has no valid media summary owner") from exc
    owner = LlmCallOwner(kind="media_summary", id=summary_id)
    if not running_job_claim_is_current(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
    ):
        db.rollback()
        return "ok"

    state = step_journal.read_step_states(job).get(_MEDIA_UNIT_STEP_PATH)
    generation_id = step_journal.stable_generation_id(
        media_id, f"{content_fingerprint}:{_MEDIA_UNIT_STEP_PATH}"
    )
    if state is not None and state.generation_id != generation_id:
        raise AssertionError("media unit replay generation identity changed")
    if state is not None and state.dispatch_phase is step_journal.Uncertain:
        raise _UncertainMediaUnitReplayDefect(
            f"media {media_id} fingerprint {content_fingerprint} synthesis is uncertain"
        )

    def skip(reason: str, message: str) -> Literal["ok"]:
        if state is not None and state.dispatch_phase is step_journal.Prepared:
            _complete_prepared_media_unit_without_dispatch(
                db,
                owner=owner,
                ctx=ctx,
                state=state,
                result=_CompletedSkip(reason=reason),
                reason=message,
            )
        else:
            db.commit()
        return "ok"

    def fail(completed: _CompletedFailure, message: str) -> Literal["ok", "failed"]:
        if state is not None and state.dispatch_phase is step_journal.Prepared:
            if not _complete_prepared_media_unit_without_dispatch(
                db,
                owner=owner,
                ctx=ctx,
                state=state,
                result=completed,
                reason=message,
            ):
                return "ok"
        else:
            db.commit()
        fail_media_unit(
            db,
            summary_id=summary_id,
            expected_fingerprint=content_fingerprint,
            ctx=ctx,
            error_code=completed.error_code,
            error_detail=nullable_from_presence(completed.error_detail),
        )
        return "failed"

    summary = media_summary_orm_or_none(db, media_id=media_id)
    if summary is None:
        return skip("summary_missing", "media summary was removed before redispatch")
    if summary.id != summary_id:
        raise AssertionError("media unit job summary owner changed")
    if summary.content_fingerprint != content_fingerprint:
        return skip(
            "summary_superseded",
            "media summary fingerprint was superseded before redispatch",
        )
    if current_content_fingerprint(db, media_id=media_id) != content_fingerprint:
        return skip(
            "content_fingerprint_changed",
            "media content fingerprint changed before redispatch",
        )
    if summary.status != "building":
        # A prior attempt already applied the Completed result.
        return skip(
            "summary_not_building",
            "media summary was no longer building before redispatch",
        )

    owner_row = db.execute(
        text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one_or_none()
    if owner_row is None:
        return fail(
            _CompletedFailure(
                error_code="no_owner",
                error_detail=present("media has no owning user to attribute the generation to"),
            ),
            "media owner was absent before redispatch",
        )
    owner_user_id = UUID(str(owner_row))

    candidates = _load_candidates(db, media_id=media_id)
    if not candidates:
        return fail(
            _CompletedFailure(
                error_code="no_candidates",
                error_detail=present("media has no indexed content chunks with evidence spans"),
            ),
            "media candidates were absent before redispatch",
        )

    user_content = _build_media_unit_user_content(candidates)
    intent = _media_unit_intent(user_content=user_content)
    if state is not None:
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("media unit replay state has no request fingerprint")
        if state.dispatch_phase is step_journal.Completed:
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
        if state.dispatch_phase is not step_journal.Prepared:
            raise AssertionError(f"unknown media unit dispatch phase {state.dispatch_phase!r}")

    # All request-shaping reads are complete before the generation boundary.
    db.commit()

    def lock_dispatch(dispatch_db: Session) -> JobRow | None:
        locked_summary = dispatch_db.scalar(
            select(MediaSummary).where(MediaSummary.id == summary_id).with_for_update()
        )
        jobs = lock_jobs_for_payload(
            dispatch_db,
            kind=_MEDIA_UNIT_JOB_KIND,
            expected_payload_match={
                "media_id": str(media_id),
                "content_fingerprint": content_fingerprint,
            },
        )
        locked_job = next(
            (candidate for candidate in jobs if candidate.id == ctx.job_id),
            None,
        )
        if (
            locked_summary is None
            or locked_summary.status != "building"
            or locked_summary.content_fingerprint != content_fingerprint
            or current_content_fingerprint(dispatch_db, media_id=media_id) != content_fingerprint
        ):
            return None
        return locked_job

    # A first dispatch reloads the prepared job; a replay may retain an earlier
    # read snapshot. Neither may cross the generation host I/O boundary.
    db.commit()
    journal = JobGenerationJournal(
        context=ctx,
        step_path=_MEDIA_UNIT_STEP_PATH,
        lock_dispatch=lock_dispatch,
    )
    try:
        execution_request = await admit_job_generation(
            owner=LlmCallOwner(kind="media_summary", id=summary_id),
            generation_id=generation_id,
            operation="media_summary",
            intent=intent,
            prompt_template_revision=generation_policy.operation_revision(MEDIA_UNIT_OPERATION),
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="media_summary",
                owner_id=str(summary_id),
                revision=generation_policy.operation_revision(MEDIA_UNIT_OPERATION),
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=journal,
            session_factory=get_session_factory(),
            runtime=runtime,
        )
        execution_result = await execute_generation(
            execution_request,
            session_factory=get_session_factory(),
            runtime=runtime,
            encode_terminal=lambda terminal: _encode_media_unit_terminal(
                codex_terminal_evidence(terminal),
                candidates=candidates,
            ),
            encode_failure=_encode_media_unit_failure,
        )
    except GenerationAdmissionInputsChanged:
        current_job = get_job(db, ctx.job_id)
        current_state = (
            None
            if current_job is None
            else step_journal.read_step_states(current_job).get(_MEDIA_UNIT_STEP_PATH)
        )
        if current_state is not None and current_state.dispatch_phase is step_journal.Prepared:
            _complete_prepared_media_unit_without_dispatch(
                db,
                owner=owner,
                ctx=ctx,
                state=current_state,
                result=_CompletedSkip(reason="request_fingerprint_changed"),
                reason="media synthesis inputs changed before redispatch",
            )
        return "ok"
    except GenerationDispatchAborted:
        if state is not None and state.dispatch_phase is step_journal.Prepared:
            _complete_prepared_media_unit_without_dispatch(
                db,
                owner=owner,
                ctx=ctx,
                state=state,
                result=_CompletedSkip(reason="dispatch_aborted"),
                reason="media owner fence aborted generation before redispatch",
            )
        return "ok"
    except GenerationUncertain as exc:
        raise _UncertainMediaUnitReplayDefect(str(exc)) from exc
    if isinstance(execution_result, RescheduleRequested):
        return execution_result
    if not isinstance(execution_result, CompletedGeneration):
        raise AssertionError("media unit generation result is not exhaustive")
    completed = _COMPLETED_RESULT_ADAPTER.validate_json(execution_result.terminal_result)
    return _apply_completed_result(
        db,
        media_id=media_id,
        owner_user_id=owner_user_id,
        summary_id=summary_id,
        content_fingerprint=content_fingerprint,
        ctx=ctx,
        result=completed,
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
    if isinstance(result, _CompletedSkip):
        return "ok"
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
    """Map each claim's candidate_index to a span.

    The bounds check is :func:`ground_indices`; the terminal codec compares the
    survivor count with the proposed count and normalizes any dropped index to
    ``invalid_output`` before this value can reach publication. Survivors keep
    model order and are reassigned dense ordinals 0..M.
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


# Prompt decomposition for the shared synthesis scaffold.
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
