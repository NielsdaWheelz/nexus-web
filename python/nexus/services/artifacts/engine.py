"""The scope-generic artifact engine (One Press).

One press for every subject: ``artifacts(subject_scheme, subject_id, kind)`` with a
stable head, immutable ``artifact_revisions``, per-revision citations, and per-kind
freshness — driven by a per-kind reducer registry (``reducers.REDUCERS``). The
reduce *loop* (collect → synth → ground → materialize → promote) is kind-agnostic
and owned here (D-1); only inputs/prompt/schema/model/citations/fingerprint differ,
and those are exactly the registry's functions.

SOLE creator of artifact heads/revisions and SOLE writer of ``artifact_revisions``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ArtifactRevision
from nexus.db.retries import retry_serializable
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.jobs.queue import enqueue_unique_job
from nexus.logging import get_logger
from nexus.schemas.artifact import ArtifactDoneEventPayload
from nexus.services import run_kit
from nexus.services.api_key_resolver import ResolvedKey, resolve_api_key, update_user_key_status
from nexus.services.artifacts.base import ArtifactReducer
from nexus.services.artifacts.reducers import REDUCERS
from nexus.services.chat_run_usage import usage_tokens
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.citations import (
    replace_citations_for_output,
    validate_generated_markdown_citations,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    SynthesisRequest,
    run_structured_synthesis,
)

logger = get_logger(__name__)

# Which durable job a new revision of each kind enqueues (D-6).
JOB_KIND_FOR_KIND = {
    "library_dossier": "library_dossier_generate",
    "conversation_distillate": "conversation_distill",
}


@dataclass(frozen=True)
class RevisionRef:
    """The create-revision outcome (the revision IS the run)."""

    artifact_id: UUID
    revision_id: UUID
    status: str


# ---------- create (the sole head/revision minter) --------------------------


def create_revision(
    db: Session,
    *,
    viewer_id: UUID,
    subject_ref: ResourceRef,
    kind: str,
    idempotency_key: str,
    custom_instruction: str | None = None,
) -> RevisionRef:
    """Ensure the ``(subject_scheme, subject_id, kind)`` head, insert a ``building``
    revision (idempotency-guarded), and enqueue the kind's job.

    Owns its SERIALIZABLE transaction + bounded retry. A reused
    ``(artifact_id, idempotency_key)`` returns the same revision without re-enqueuing.
    """
    if kind not in REDUCERS:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Unknown artifact kind: {kind}")
    instruction = (
        custom_instruction.strip() if custom_instruction and custom_instruction.strip() else None
    )

    def op() -> RevisionRef:
        ref = _create_revision_core(
            db,
            viewer_id=viewer_id,
            subject_ref=subject_ref,
            kind=kind,
            idempotency_key=idempotency_key,
            custom_instruction=instruction,
        )
        db.commit()
        return ref

    return retry_serializable(db, "create_revision", op)


def _create_revision_core(
    db: Session,
    *,
    viewer_id: UUID,
    subject_ref: ResourceRef,
    kind: str,
    idempotency_key: str,
    custom_instruction: str | None,
) -> RevisionRef:
    head = db.execute(
        text(
            "SELECT id FROM artifacts "
            "WHERE subject_scheme = :scheme AND subject_id = :sid AND kind = :kind"
        ),
        {"scheme": subject_ref.scheme, "sid": subject_ref.id, "kind": kind},
    ).scalar_one_or_none()
    if head is not None:
        artifact_id = UUID(str(head))
        db.execute(
            text("UPDATE artifacts SET updated_at = now() WHERE id = :id"), {"id": artifact_id}
        )
    else:
        artifact_id = UUID(
            str(
                db.execute(
                    text(
                        "INSERT INTO artifacts (subject_scheme, subject_id, kind, user_id) "
                        "VALUES (:scheme, :sid, :kind, :viewer_id) RETURNING id"
                    ),
                    {
                        "scheme": subject_ref.scheme,
                        "sid": subject_ref.id,
                        "kind": kind,
                        "viewer_id": viewer_id,
                    },
                ).scalar_one()
            )
        )

    existing = (
        db.execute(
            text(
                "SELECT id, status FROM artifact_revisions "
                "WHERE artifact_id = :artifact_id AND idempotency_key = :idempotency_key"
            ),
            {"artifact_id": artifact_id, "idempotency_key": idempotency_key},
        )
        .mappings()
        .first()
    )
    if existing is not None:
        return RevisionRef(
            artifact_id=artifact_id,
            revision_id=UUID(str(existing["id"])),
            status=str(existing["status"]),
        )

    revision_id = UUID(
        str(
            db.execute(
                text(
                    """
                    INSERT INTO artifact_revisions (
                        artifact_id, content_md, covered_targets, status,
                        idempotency_key, custom_instruction
                    )
                    VALUES (
                        :artifact_id, '', '[]'::jsonb, 'building',
                        :idempotency_key, :custom_instruction
                    )
                    RETURNING id
                    """
                ),
                {
                    "artifact_id": artifact_id,
                    "idempotency_key": idempotency_key,
                    "custom_instruction": custom_instruction,
                },
            ).scalar_one()
        )
    )
    job_kind = JOB_KIND_FOR_KIND[kind]
    enqueue_unique_job(
        db,
        kind=job_kind,
        dedupe_key=f"{job_kind}:{revision_id}",
        payload={"revision_id": str(revision_id)},
        max_attempts=1,
    )
    run_kit.append_event(
        db,
        stream=run_kit.artifact_revision_stream(_revision_orm(db, revision_id=revision_id)),
        event_type="meta",
        payload={
            "revision_id": str(revision_id),
            "subject_scheme": subject_ref.scheme,
            "subject_id": str(subject_ref.id),
        },
    )
    return RevisionRef(artifact_id=artifact_id, revision_id=revision_id, status="building")


# ---------- run (the shared reduce loop) ------------------------------------


async def run_revision(db: Session, *, revision_id: UUID, llm: ModelRuntime) -> None:
    """Reduce one ``building`` revision to prose + grounded citations, then promote.

    Replay-safe: a no-op when the revision is missing or not ``building``. The
    reduce is attributed to the artifact owner (BYOK-first) inside the
    rate-limit/budget envelope; each attempt is one ``llm_calls`` row (owner
    ``artifact_revision`` — the revision IS the run).
    """
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status != "building":
        return
    artifact_id = revision.artifact_id
    custom_instruction = revision.custom_instruction
    row = _artifact_row(db, artifact_id=artifact_id)
    subject_ref = ResourceRef(scheme=cast("ResourceScheme", row.subject_scheme), id=row.subject_id)
    owner_id = row.user_id
    reducer = REDUCERS[row.kind]
    # The reducer viewer: a conversation subject reads the owner's active branch
    # (D-13); a library subject collects the personal virtual media relation
    # (spec §4.1) anchored on the library's owner_user_id, not the artifact
    # head's user_id (they can differ for a shared non-default library) — see
    # `library_owner_user_id`. Scheme-scoped: no other subject kind resolves a
    # viewer here.
    collect_viewer = (
        owner_id
        if row.subject_scheme == "conversation"
        else library_owner_user_id(db, library_id=subject_ref.id)
        if row.subject_scheme == "library"
        else None
    )

    try:
        resolved_key = resolve_api_key(db, owner_id, reducer.provider, "auto")
    except ApiError as exc:
        _fail_revision(
            db, revision_id=revision_id, error_code=exc.code.value, error_detail=exc.message
        )
        return
    except ModelCallError as exc:
        _fail_revision(
            db,
            revision_id=revision_id,
            error_code=api_error_code_for_model_call(exc.error_code).value,
            error_detail=exception_error_detail(exc),
        )
        return

    rate_limiter = get_rate_limiter()
    try:
        rate_limiter.acquire_inflight_slot(owner_id)
    except ApiError as exc:
        _fail_revision(
            db, revision_id=revision_id, error_code=exc.code.value, error_detail=exc.message
        )
        return
    budget_reserved = False
    estimated_tokens = 0
    try:
        inputs = await reducer.collect(db, subject_ref, collect_viewer, llm)
        if reducer.is_empty(inputs):
            code, detail = reducer.empty_error
            _fail_revision(db, revision_id=revision_id, error_code=code, error_detail=detail)
            return
        _emit_progress(db, revision_id=revision_id, message="Synthesizing")

        request = reducer.build_request(inputs, custom_instruction)
        if resolved_key.mode == "platform":
            estimated_tokens = (
                estimate_tokens("\n".join(turn.content for turn in request.messages))
                + reducer.max_output_tokens
            )
            try:
                rate_limiter.reserve_token_budget(owner_id, revision_id, estimated_tokens)
                budget_reserved = True
            except ApiError as exc:
                _fail_revision(
                    db, revision_id=revision_id, error_code=exc.code.value, error_detail=exc.message
                )
                return

        try:
            result = await run_structured_synthesis(
                llm=LedgeredLLM(
                    db=db,
                    owner=LlmCallOwner(kind="artifact_revision", id=revision_id),
                    router=llm,
                    llm_operation=reducer.llm_operation,
                    key_mode_requested="auto",
                    key_mode_used=resolved_key.mode,
                ),
                request=SynthesisRequest(
                    provider=reducer.provider,
                    llm_request=request,
                    api_key=resolved_key.api_key,
                    timeout_s=reducer.timeout_s,
                ),
                schema=reducer.schema,
            )
        except ModelCallError as exc:
            error_code = api_error_code_for_model_call(exc.error_code).value
            logger.warning(
                "artifact.reduce_failure", revision_id=str(revision_id), error_code=error_code
            )
            if resolved_key.mode == "byok" and error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                update_user_key_status(db, resolved_key.user_key_id, "invalid")
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=error_code,
                error_detail=exception_error_detail(exc),
            )
            return
        except StructuredSynthesisError as exc:
            logger.warning(
                "artifact.reduce_failure",
                revision_id=str(revision_id),
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
            )
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                error_detail=exception_error_detail(exc),
            )
            return

        # Commit the per-attempt llm_calls rows now so they survive the promote.
        db.commit()
        content_md, citations = reducer.materialize(db, owner_id, subject_ref, inputs, result.value)
        try:
            validate_generated_markdown_citations(content_md, citations)
        except InvalidRequestError as exc:
            logger.warning(
                "artifact.citation_parity_failure",
                revision_id=str(revision_id),
                error_detail=exc.message,
            )
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                error_detail=exc.message,
            )
            return
        covered = reducer.fingerprint(db, inputs)
        _promote_built_revision(
            db,
            revision_id=revision_id,
            artifact_id=artifact_id,
            owner_id=owner_id,
            content_md=content_md,
            covered_targets=covered,
            citations=citations,
            resolved_key=resolved_key,
        )
        if budget_reserved:
            actual_tokens = usage_tokens(result.usage)["total_tokens"]
            rate_limiter.commit_token_budget(
                owner_id, revision_id, actual_tokens or estimated_tokens
            )
            budget_reserved = False
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(owner_id, revision_id)
        rate_limiter.release_inflight_slot(owner_id)


def _promote_built_revision(
    db: Session,
    *,
    revision_id: UUID,
    artifact_id: UUID,
    owner_id: UUID,
    content_md: str,
    covered_targets: list[dict[str, object]],
    citations: list,
    resolved_key: ResolvedKey,
) -> None:
    """Atomically mark the revision ready (run_kit) and promote it to current.

    ``mark_terminal(ready)`` FIRST (status + completed_at + ``done`` event), THEN
    content/covered/promoted, citation edges, head repoint — one SERIALIZABLE tx.
    """

    def op() -> None:
        revision = revision_orm_or_none(db, revision_id=revision_id)
        if revision is None or revision.status != "building":
            db.rollback()
            return
        run_kit.mark_terminal(
            db,
            stream=run_kit.artifact_revision_stream(revision),
            status="ready",
            done_payload=ArtifactDoneEventPayload(
                status="ready", revision_id=revision_id
            ).model_dump(mode="json"),
        )
        db.execute(
            text(
                """
                UPDATE artifact_revisions
                SET content_md = :content_md,
                    covered_targets = :covered_targets,
                    promoted_at = now()
                WHERE id = :revision_id
                """
            ).bindparams(bindparam("covered_targets", type_=JSONB)),
            {
                "content_md": content_md,
                "covered_targets": covered_targets,
                "revision_id": revision_id,
            },
        )
        replace_citations_for_output(
            db,
            viewer_id=owner_id,
            source=ResourceRef(scheme="artifact_revision", id=revision_id),
            citations=citations,
        )
        db.execute(
            text(
                "UPDATE artifacts SET current_revision_id = :revision_id, updated_at = now() "
                "WHERE id = :artifact_id"
            ),
            {"revision_id": revision_id, "artifact_id": artifact_id},
        )
        if resolved_key.mode == "byok":
            update_user_key_status(db, resolved_key.user_key_id, "valid")
        db.commit()

    retry_serializable(db, "_promote_built_revision", op)


def _fail_revision(
    db: Session, *, revision_id: UUID, error_code: str, error_detail: str | None
) -> None:
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status in ("ready", "failed"):
        db.commit()
        return
    run_kit.mark_terminal(
        db,
        stream=run_kit.artifact_revision_stream(revision),
        status="failed",
        done_payload=ArtifactDoneEventPayload(
            status="failed", error_code=error_code, revision_id=revision_id
        ).model_dump(mode="json"),
        error_code=error_code,
        error_detail=error_detail,
    )
    db.commit()


def _emit_progress(db: Session, *, revision_id: UUID, message: str) -> None:
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None:
        return
    run_kit.append_event(
        db,
        stream=run_kit.artifact_revision_stream(revision),
        event_type="progress",
        payload={"message": message},
    )
    db.commit()


# ---------- freshness (D-12) ------------------------------------------------


def is_artifact_stale(
    db: Session,
    *,
    subject_scheme: str,
    subject_id: UUID,
    kind: str,
    current_revision_id: UUID,
) -> bool:
    """Return True when the current revision's covered_targets no longer match live."""
    reducer = REDUCERS[kind]
    subject_ref = ResourceRef(scheme=cast("ResourceScheme", subject_scheme), id=subject_id)
    viewer_id = _viewer_for_subject(db, subject_ref)
    stored = (
        db.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :id"),
            {"id": current_revision_id},
        ).scalar_one_or_none()
        or []
    )
    live = reducer.live_fingerprint(db, subject_ref, viewer_id)
    return reducer.freshness_signature(stored) != reducer.freshness_signature(live)


# ---------- FK-less subject cleanup (D-10) ----------------------------------


def on_subject_deleted(db: Session, subject_ref: ResourceRef) -> None:
    """Delete every head + its revisions + events + citation edges for a subject.

    Called by the subject owner's delete path (there is no FK cascade, D-2). Mirrors
    the resource-graph purge pattern: null the circular head pointer, drop each
    artifact/revision graph ref, then events, revisions, and the head.
    """
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource

    artifact_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text("SELECT id FROM artifacts WHERE subject_scheme = :scheme AND subject_id = :sid"),
            {"scheme": subject_ref.scheme, "sid": subject_ref.id},
        )
    ]
    if not artifact_ids:
        return
    revision_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text("SELECT id FROM artifact_revisions WHERE artifact_id = ANY(:ids)"),
            {"ids": artifact_ids},
        )
    ]
    db.execute(
        text("UPDATE artifacts SET current_revision_id = NULL WHERE id = ANY(:ids)"),
        {"ids": artifact_ids},
    )
    for artifact_id in artifact_ids:
        delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="artifact", id=artifact_id))
    for revision_id in revision_ids:
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="artifact_revision", id=revision_id)
        )
    if revision_ids:
        db.execute(
            text("DELETE FROM artifact_revision_events WHERE revision_id = ANY(:ids)"),
            {"ids": revision_ids},
        )
        db.execute(
            text("DELETE FROM artifact_revisions WHERE id = ANY(:ids)"),
            {"ids": revision_ids},
        )
    db.execute(text("DELETE FROM artifacts WHERE id = ANY(:ids)"), {"ids": artifact_ids})


# ---------- shared loaders --------------------------------------------------


@dataclass(frozen=True)
class _ArtifactRow:
    artifact_id: UUID
    subject_scheme: str
    subject_id: UUID
    kind: str
    user_id: UUID


def _artifact_row(db: Session, *, artifact_id: UUID) -> _ArtifactRow:
    row = db.execute(
        text("SELECT id, subject_scheme, subject_id, kind, user_id FROM artifacts WHERE id = :id"),
        {"id": artifact_id},
    ).one()
    return _ArtifactRow(
        artifact_id=UUID(str(row[0])),
        subject_scheme=str(row[1]),
        subject_id=UUID(str(row[2])),
        kind=str(row[3]),
        user_id=UUID(str(row[4])),
    )


def _viewer_for_subject(db: Session, subject_ref: ResourceRef) -> UUID | None:
    if subject_ref.scheme == "conversation":
        owner = db.execute(
            text("SELECT owner_user_id FROM conversations WHERE id = :id"), {"id": subject_ref.id}
        ).scalar_one_or_none()
        return UUID(str(owner)) if owner is not None else None
    if subject_ref.scheme == "library":
        return library_owner_user_id(db, library_id=subject_ref.id)
    return None


def library_owner_user_id(db: Session, *, library_id: UUID) -> UUID | None:
    """The library-dossier viewer anchor (spec §4.1): the library's owner, not
    whichever member triggered generation or is currently reading — deterministic
    across every member of a shared non-default library. SOLE owner-lookup for
    library subjects; other artifact modules import this rather than querying
    ``libraries`` directly."""
    owner = db.execute(
        text("SELECT owner_user_id FROM libraries WHERE id = :id"), {"id": library_id}
    ).scalar_one_or_none()
    return UUID(str(owner)) if owner is not None else None


def revision_orm_or_none(db: Session, *, revision_id: UUID) -> ArtifactRevision | None:
    """Load a revision ORM by id (the single home for revision-ORM access)."""
    return db.get(ArtifactRevision, revision_id, populate_existing=True)


def _revision_orm(db: Session, *, revision_id: UUID) -> ArtifactRevision:
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None:
        from nexus.errors import NotFoundError

        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    return revision


def reducer_for_kind(kind: str) -> ArtifactReducer:
    return REDUCERS[kind]
