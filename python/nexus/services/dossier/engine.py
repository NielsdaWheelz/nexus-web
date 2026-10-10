"""The dossier engine: sole owner of heads, builds, idea rows and every status change.

A head is keyed by (subject, audience) and carries its one revision. A build is a row
with a status; at most one per head is ``active`` (a partial unique index) and every
transition is one compare-and-set out of ``active``. Publish swaps the revision
columns and citation edges and deletes every other build of the head in one
transaction, so a regenerate leaves the old revision readable until then. Purge never
raises: an uncertain generation stays the ledger's fact.

Lock order everywhere: generation-owner advisory (cancel only) -> head -> build -> job.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import Result, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.jobs.queue import (
    DurableExecutionPhase,
    JobExecutionContext,
    enqueue_unique_job,
    project_execution_phase,
    revoke_jobs_by_dedupe_keys,
    running_job_claim_is_current,
)
from nexus.schemas.dossier import (
    DossierBuildCreatedOut,
    DossierBuildOut,
    DossierCoverageOut,
    DossierFailureCode,
    DossierHeadOut,
    DossierRevisionOut,
    LearnDossierBuildAcceptedOut,
    LearnDossierOpenedOut,
    MediaAbstractOut,
)
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.services.dossier import research, subjects
from nexus.services.dossier.inputs import Coverage, InputTooLarge
from nexus.services.dossier.synthesis import Published
from nexus.services.generation.ledger import latest_generations
from nexus.services.media_intelligence import read_single
from nexus.services.resource_graph.citations import (
    build_citation_outs_for_sources,
    replace_citations_for_output,
)
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_ref
from nexus.services.resource_items.routing import resource_activation_for_ref

JOB_KIND = "dossier_build"
MAX_INSTRUCTION_CHARS = 4_000
_HEAD = (
    "SELECT a.id, a.subject_scheme, a.subject_id, a.audience_scheme, a.audience_id, "
    "a.revision_id, a.content_html, a.coverage, a.citation_owner_user_id, a.creator_user_id, "
    "a.instruction, a.model_name, a.total_tokens, a.generated_at FROM artifacts a WHERE "
)


@dataclass(frozen=True, slots=True)
class BuildFacts:
    build_id: UUID
    artifact_id: UUID
    scheme: str
    subject_id: UUID
    audience_scheme: str
    audience_id: UUID
    requester_id: UUID
    instruction: str | None


@dataclass(frozen=True, slots=True)
class ArtifactActionCandidate:
    """An audience-visible head's lifecycle fact and the subject still needing authz."""

    has_active_build: bool
    subject_ref: ResourceRef | None


def read_subject_head(db: Session, *, scheme: str, handle: str, viewer_id: UUID) -> DossierHeadOut:
    """A routable subject's dossier for this viewer; never inserts a head."""
    subject_id = subjects.resolve(db, scheme, handle, viewer_id)
    audience, audience_id = subjects.audience_of(scheme, subject_id, viewer_id)
    key = "(a.subject_scheme, a.subject_id, a.audience_scheme, a.audience_id) = (:s, :id, :a, :aid)"
    head = _sql(db, _HEAD + key, s=scheme, id=subject_id, a=audience, aid=audience_id).first()
    return _head_out(db, scheme, subject_id, head, viewer_id)


def read_head(db: Session, *, artifact_id: UUID, viewer_id: UUID) -> DossierHeadOut:
    head = _visible_head(db, artifact_id, viewer_id)
    return _head_out(db, head.subject_scheme, head.subject_id, head, viewer_id)


def build_state(db: Session, *, build_id: UUID, viewer_id: UUID) -> DossierBuildOut:
    """One build as the snapshot stream sends it; 404 once gone or unseen."""
    return _build_out(db, _visible_build(db, build_id, viewer_id))


def action_candidates(
    db: Session, *, viewer_id: UUID, artifact_ids: Sequence[UUID], revision_ids: Sequence[UUID]
) -> tuple[dict[UUID, ArtifactActionCandidate], dict[UUID, ResourceRef | None]]:
    """Audience-visible heads and revisions; the subject's own visibility is the caller's."""
    audience = subjects.audience_sql("a")
    heads: dict[UUID, ArtifactActionCandidate] = {}
    revisions: dict[UUID, ResourceRef | None] = {}
    if artifact_ids:
        rows = _sql(
            db,
            "SELECT a.id, a.subject_scheme, a.subject_id, EXISTS (SELECT 1 FROM artifact_builds "
            "b WHERE b.artifact_id = a.id AND b.status = 'active') AS active FROM artifacts a "
            f"WHERE a.id = ANY(:ids) AND {audience}",
            ids=list(artifact_ids),
            viewer_id=viewer_id,
        )
        heads = {row.id: ArtifactActionCandidate(row.active, _subject_ref(row)) for row in rows}
    if revision_ids:
        rows = _sql(
            db,
            "SELECT a.revision_id AS id, a.subject_scheme, a.subject_id FROM artifacts a "
            f"WHERE a.revision_id = ANY(:ids) AND {audience}",
            ids=list(revision_ids),
            viewer_id=viewer_id,
        )
        revisions = {row.id: _subject_ref(row) for row in rows}
    return heads, revisions


def start_build(
    db: Session, *, scheme: str, handle: str, viewer_id: UUID, key: str, instruction: str | None
) -> DossierBuildCreatedOut:
    """Generate for a routable subject, creating its head on the first press."""
    clean = _instruction(instruction)

    def op() -> DossierBuildCreatedOut:
        subject_id = subjects.resolve(db, scheme, handle, viewer_id)
        audience = subjects.audience_of(scheme, subject_id, viewer_id)
        created = _new_build(
            db, _ensure_head(db, scheme, subject_id, *audience), viewer_id, key, clean
        )
        db.commit()
        return created

    return retry_serializable(db, "dossier_start_build", op)


def regenerate(
    db: Session, *, artifact_id: UUID, viewer_id: UUID, key: str, instruction: str | None
) -> DossierBuildCreatedOut:
    clean = _instruction(instruction)

    def op() -> DossierBuildCreatedOut:
        if _visible_head(db, artifact_id, viewer_id).subject_scheme == "idea":
            _require_web_research()
        _sql(db, "SELECT 1 FROM artifacts WHERE id = :id FOR UPDATE", id=artifact_id)
        created = _new_build(db, artifact_id, viewer_id, key, clean)
        db.commit()
        return created

    return retry_serializable(db, "dossier_regenerate", op)


def learn(
    db: Session, *, highlight_id: UUID, viewer_id: UUID, key: str
) -> LearnDossierOpenedOut | LearnDossierBuildAcceptedOut:
    """Map a highlight to its idea, seed the idea's head, and start at most one build."""
    _require_web_research()

    def op() -> LearnDossierOpenedOut | LearnDossierBuildAcceptedOut:
        exact = _sql(
            db,
            "SELECT exact FROM highlights WHERE id = :id AND user_id = :u",
            id=highlight_id,
            u=viewer_id,
        ).scalar()
        if exact is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight not found")
        identity = research.idea_key(exact)
        if identity is None:
            raise ApiError(ApiErrorCode.E_DOSSIER_IDEA_UNRESOLVED, "The idea could not be resolved")
        idea_id = _sql(
            db,
            "INSERT INTO artifact_idea_subjects (user_id, title_key, display_title) "
            "VALUES (:u, :key, :title) ON CONFLICT (user_id, title_key) "
            "DO UPDATE SET title_key = EXCLUDED.title_key RETURNING id",
            u=viewer_id,
            key=identity[0],
            title=identity[1],
        ).scalar_one()
        head_id = _ensure_head(db, "idea", idea_id, "user", viewer_id)
        _sql(
            db,
            "INSERT INTO artifact_idea_seeds (artifact_id, highlight_id) VALUES (:id, :h) "
            "ON CONFLICT DO NOTHING",
            id=head_id,
            h=highlight_id,
        )
        busy = _sql(
            db,
            "SELECT revision_id IS NOT NULL OR EXISTS (SELECT 1 FROM artifact_builds WHERE "
            "artifact_id = :id AND status = 'active') FROM artifacts WHERE id = :id",
            id=head_id,
        ).scalar_one()
        created = None if busy else _new_build(db, head_id, viewer_id, f"learn:{key}", None)
        db.commit()
        if created is None:
            return LearnDossierOpenedOut(artifact_ref=f"artifact:{head_id}")
        return LearnDossierBuildAcceptedOut(
            artifact_ref=created.artifact_ref, build_handle=created.build_handle
        )

    return retry_serializable(db, "dossier_learn", op)


def cancel_build(db: Session, *, build_id: UUID, viewer_id: UUID) -> None:
    """Active -> cancelled; idempotent once cancelled; 409 once succeeded or failed."""

    def op() -> None:
        head_id = _visible_build(db, build_id, viewer_id).artifact_id
        _sql(db, "SELECT 1 FROM artifacts WHERE id = :id FOR UPDATE", id=head_id)
        if not _transition(db, build_id, "cancelled"):
            status = _sql(db, "SELECT status FROM artifact_builds WHERE id = :id", id=build_id)
            if status.scalar_one() != "cancelled":
                raise ConflictError(
                    ApiErrorCode.E_DOSSIER_BUILD_NOT_ACTIVE,
                    "This dossier build is no longer active",
                )
        db.commit()

    retry_serializable(db, "dossier_cancel_build", op)


def build_facts(db: Session, build_id: UUID) -> BuildFacts | None:
    """The active build's facts; None once it is terminal or purged."""
    row = _sql(
        db,
        "SELECT b.artifact_id, a.subject_scheme, a.subject_id, a.audience_scheme, a.audience_id, "
        "b.requester_user_id, b.instruction FROM artifact_builds b JOIN artifacts a "
        "ON a.id = b.artifact_id WHERE b.id = :id AND b.status = 'active'",
        id=build_id,
    ).first()
    return None if row is None else BuildFacts(build_id, *row)


def publish(db: Session, *, build_id: UUID, ctx: JobExecutionContext, published: Published) -> None:
    """Swap in the new revision and its citations; delete every other build of the head."""

    def op() -> None:
        head = _sql(
            db,
            "SELECT a.id, a.revision_id, a.audience_scheme, a.audience_id, b.requester_user_id, "
            "b.instruction FROM artifacts a JOIN artifact_builds b ON b.artifact_id = a.id "
            "WHERE b.id = :id FOR UPDATE OF a",
            id=build_id,
        ).first()
        claimed = head is not None and running_job_claim_is_current(db, context=ctx)
        if head is None or not claimed or not _transition(db, build_id, "succeeded"):
            db.rollback()
            return
        owner = subjects.input_viewer(db, head.audience_scheme, head.audience_id)
        if head.revision_id is not None:
            delete_edges_for_deleted_resources(
                db, refs=[ResourceRef("artifact_revision", head.revision_id)]
            )
        revision_id = uuid4()
        model, tokens = _provenance(db, build_id)
        _sql(
            db,
            "UPDATE artifacts SET revision_id = :revision, content_html = :html, "
            "content_text = :text, coverage = CAST(:coverage AS jsonb), "
            "citation_owner_user_id = :owner, creator_user_id = :creator, instruction = :i, "
            "model_name = :model, total_tokens = :tokens, generated_at = now(), "
            "updated_at = now() WHERE id = :id",
            id=head.id,
            revision=revision_id,
            html=published.html,
            text=published.text,
            coverage=published.coverage.model_dump_json(),
            owner=owner,
            creator=head.requester_user_id,
            i=head.instruction,
            model=model,
            tokens=tokens,
        )
        source = ResourceRef("artifact_revision", revision_id)
        replace_citations_for_output(
            db, viewer_id=owner, source=source, citations=published.citations
        )
        others = _sql(
            db,
            "DELETE FROM artifact_builds WHERE artifact_id = :head AND id <> :id RETURNING id",
            head=head.id,
            id=build_id,
        ).scalars()
        revoke_jobs_by_dedupe_keys(db, kind=JOB_KIND, dedupe_keys=[_job_key(b) for b in others])
        db.commit()

    retry_serializable(db, "dossier_publish", op)


def fail(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    code: DossierFailureCode,
    detail: str | None,
) -> None:
    def op() -> None:
        if running_job_claim_is_current(db, context=ctx):
            _transition(db, build_id, "failed", code=code.value, detail=detail)
        db.commit()

    retry_serializable(db, "dossier_fail", op)


def lock_heads(
    db: Session, *, subjects: Sequence[ResourceRef] = (), user_ids: Sequence[UUID] = ()
) -> None:
    """Lock a composite teardown's whole head set once, in id order, before nested purges."""
    _sql(
        db,
        "SELECT id FROM artifacts WHERE (subject_scheme, subject_id) IN (SELECT * FROM "
        "unnest(CAST(:schemes AS text[]), CAST(:ids AS uuid[]))) OR (audience_scheme = 'user' "
        "AND audience_id = ANY(:users)) ORDER BY id FOR UPDATE",
        schemes=[ref.scheme for ref in subjects],
        ids=[ref.id for ref in subjects],
        users=list(user_ids),
    )


def on_subject_deleted(db: Session, ref: ResourceRef) -> None:
    heads = _sql(
        db,
        "SELECT id FROM artifacts WHERE subject_scheme = :s AND subject_id = :id",
        s=ref.scheme,
        id=ref.id,
    )
    _purge(db, list(heads.scalars()))


def on_visibility_lost(db: Session, *, user_id: UUID) -> None:
    """Purge the user's own heads whose subject they can no longer see; library heads stay."""
    heads = _sql(
        db,
        "SELECT a.id FROM artifacts a WHERE a.audience_scheme = 'user' "
        f"AND a.audience_id = :viewer_id AND NOT {subjects.head_visible_sql('a')}",
        viewer_id=user_id,
    )
    _purge(db, list(heads.scalars()))


def _purge(db: Session, head_ids: list[UUID]) -> None:
    """Delete heads with their builds, seeds, jobs and edges. The caller owns the transaction."""
    if not head_ids:
        return
    lock = "FROM artifacts WHERE id = ANY(:ids) ORDER BY id FOR UPDATE"
    revisions = _sql(db, f"SELECT revision_id {lock}", ids=head_ids).scalars().all()
    builds = _sql(
        db,
        "SELECT id FROM artifact_builds WHERE artifact_id = ANY(:ids) ORDER BY id FOR UPDATE",
        ids=head_ids,
    ).scalars()
    revoke_jobs_by_dedupe_keys(db, kind=JOB_KIND, dedupe_keys=[_job_key(b) for b in builds])
    refs = [ResourceRef("artifact", head_id) for head_id in head_ids]
    refs += [ResourceRef("artifact_revision", r) for r in revisions if r is not None]
    delete_edges_for_deleted_resources(db, refs=refs)
    _sql(db, "DELETE FROM artifacts WHERE id = ANY(:ids)", ids=head_ids)


def _head_out(
    db: Session, scheme: str, subject_id: UUID, head: Any | None, viewer_id: UUID
) -> DossierHeadOut:
    if scheme == "idea":
        title_sql = "SELECT display_title FROM artifact_idea_subjects WHERE id = :id"
        title = _sql(db, title_sql, id=subject_id).scalar_one()
        activation = absent()
    else:
        ref = ResourceRef(cast(ResourceScheme, scheme), subject_id)
        resolved = resolve_ref(db, viewer_id=viewer_id, ref=ref)
        title = resolved.label
        activation = present(
            resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref, missing=resolved.missing)
        )
    builds = (
        []
        if head is None
        else _sql(
            db,
            "SELECT id, status, failure_code, instruction FROM artifact_builds WHERE artifact_id = "
            ":id AND status <> 'succeeded' ORDER BY created_at DESC, id DESC",
            id=head.id,
        ).all()
    )
    active = next((build for build in builds if build.status == "active"), None)
    failure = next((build for build in builds if build.status != "active"), None)
    abstract = absent()
    if scheme == "media":
        projection = read_single(db, media_id=subject_id, requester_user_id=viewer_id)
        if projection.status != "not_available":
            status = "Failed" if projection.status == "suspended" else projection.status.title()
            summary = presence_from_nullable(projection.summary_md)
            abstract = present(MediaAbstractOut(status=cast(Any, status), summary_md=summary))
    revision = (
        None if head is None or head.revision_id is None else _revision_out(db, head, viewer_id)
    )
    return DossierHeadOut(
        artifact_ref=absent() if head is None else present(f"artifact:{head.id}"),
        title=title,
        subject_activation=activation,
        revision=absent() if revision is None else present(revision),
        active_build=absent() if active is None else present(_build_out(db, active)),
        last_failure=absent() if failure is None else present(_build_out(db, failure)),
        media_abstract=abstract,
    )


def _revision_out(db: Session, head: Any, viewer_id: UUID) -> DossierRevisionOut:
    coverage = Coverage.model_validate(head.coverage)
    viewer = subjects.input_viewer(db, head.audience_scheme, head.audience_id)
    collect = subjects.BINDINGS[head.subject_scheme].inputs
    try:
        live = (
            research.reread(db, user_id=viewer, sources=coverage.sources)
            if collect is None
            else collect(db, head.subject_id, viewer).coverage.fingerprint
        )
    except InputTooLarge:
        live = None
    source = ResourceRef("artifact_revision", head.revision_id)
    citations = build_citation_outs_for_sources(
        db, viewer_id=viewer_id, edge_owner_id=head.citation_owner_user_id, sources=[source]
    )
    return DossierRevisionOut(
        revision_ref=source.uri,
        content_html=head.content_html,
        citations=citations[source.uri],
        coverage=DossierCoverageOut(**coverage.model_dump(include={"unit", "included", "omitted"})),
        stale=live != coverage.fingerprint,
        instruction=presence_from_nullable(head.instruction),
        by_viewer=head.creator_user_id == viewer_id,
        model=presence_from_nullable(head.model_name),
        total_tokens=presence_from_nullable(head.total_tokens),
        generated_at=head.generated_at,
    )


def _build_out(db: Session, build: Any) -> DossierBuildOut:
    phase = absent()
    if build.status == "active":
        job = _sql(
            db,
            "SELECT status, attempts, error_code FROM background_jobs WHERE dedupe_key = :key",
            key=_job_key(build.id),
        ).first()
        phase = present(
            DurableExecutionPhase.Queued
            if job is None
            else project_execution_phase(
                job_status=job.status, attempts=job.attempts, error_code=job.error_code
            )
        )
    code = None if build.failure_code is None else DossierFailureCode(build.failure_code)
    return DossierBuildOut(
        handle=str(build.id),
        status=cast(Any, build.status.capitalize()),
        phase=phase,
        failure_code=presence_from_nullable(code),
        instruction=presence_from_nullable(build.instruction),
    )


def _provenance(db: Session, build_id: UUID) -> tuple[str | None, int | None]:
    """The model and total tokens of the build's succeeded generation, from the ledger."""
    call = latest_generations(db, kind="artifact_build", ids=[build_id], succeeded=True).get(
        build_id
    )
    if call is None:
        return None, None
    selection = cast(dict[str, str], call.generation_spec["selection"])
    tokens = None if call.usage is None else call.usage.get("total_tokens")
    return selection.get("model") or selection.get("model_ref"), cast(int | None, tokens)


def _visible_head(db: Session, artifact_id: UUID, viewer_id: UUID) -> Any:
    head = _sql(
        db,
        _HEAD + f"a.id = :id AND {subjects.head_visible_sql('a')}",
        id=artifact_id,
        viewer_id=viewer_id,
    )
    if (row := head.first()) is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier not found")
    return row


def _visible_build(db: Session, build_id: UUID, viewer_id: UUID) -> Any:
    build = _sql(
        db,
        "SELECT b.id, b.artifact_id, b.status, b.failure_code, b.instruction FROM artifact_builds "
        f"b JOIN artifacts a ON a.id = b.artifact_id WHERE b.id = :id AND {subjects.head_visible_sql('a')}",
        id=build_id,
        viewer_id=viewer_id,
    )
    if (row := build.first()) is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found")
    return row


def _ensure_head(
    db: Session, scheme: str, subject_id: UUID, audience: str, audience_id: UUID
) -> UUID:
    """The head's id, inserted on first use; the row stays locked until commit."""
    return _sql(
        db,
        "INSERT INTO artifacts (subject_scheme, subject_id, audience_scheme, audience_id) "
        "VALUES (:s, :id, :a, :aid) ON CONFLICT (subject_scheme, subject_id, audience_scheme, "
        "audience_id) DO UPDATE SET updated_at = now() RETURNING id",
        s=scheme,
        id=subject_id,
        a=audience,
        aid=audience_id,
    ).scalar_one()


def _new_build(
    db: Session, head_id: UUID, requester_id: UUID, key: str, instruction: str | None
) -> DossierBuildCreatedOut:
    """Under the head lock: replay the key's build, refuse a second active one, or start one."""
    ref = f"artifact:{head_id}"
    keyed = "SELECT id FROM artifact_builds WHERE artifact_id = :id AND idempotency_key = :key"
    if (existing := _sql(db, keyed, id=head_id, key=key).scalar()) is not None:
        return DossierBuildCreatedOut(artifact_ref=ref, build_handle=str(existing), created=False)
    active = "SELECT 1 FROM artifact_builds WHERE artifact_id = :id AND status = 'active'"
    if _sql(db, active, id=head_id).scalar():
        raise ConflictError(
            ApiErrorCode.E_DOSSIER_GENERATION_IN_PROGRESS, "A dossier build is already in progress"
        )
    build_id = _sql(
        db,
        "INSERT INTO artifact_builds (artifact_id, requester_user_id, instruction, idempotency_key, "
        "status) VALUES (:id, :requester, :instruction, :key, 'active') RETURNING id",
        id=head_id,
        requester=requester_id,
        instruction=instruction,
        key=key,
    ).scalar_one()
    job_key = _job_key(build_id)
    enqueue_unique_job(db, kind=JOB_KIND, dedupe_key=job_key, payload={"build_id": str(build_id)})
    return DossierBuildCreatedOut(artifact_ref=ref, build_handle=str(build_id), created=True)


def _transition(
    db: Session, build_id: UUID, status: str, *, code: str | None = None, detail: str | None = None
) -> bool:
    """The one compare-and-set out of ``active``."""
    moved = _sql(
        db,
        "UPDATE artifact_builds SET status = :status, failure_code = :code, failure_detail = "
        ":detail, finished_at = now() WHERE id = :id AND status = 'active' RETURNING id",
        id=build_id,
        status=status,
        code=code,
        detail=detail,
    )
    return moved.first() is not None


def _instruction(instruction: str | None) -> str | None:
    stripped = (instruction or "").strip()
    if len(stripped) > MAX_INSTRUCTION_CHARS:
        raise InvalidRequestError(
            ApiErrorCode.E_DOSSIER_INVALID_INSTRUCTION,
            f"An instruction is at most {MAX_INSTRUCTION_CHARS} characters",
        )
    return stripped or None


def _require_web_research() -> None:
    if get_settings().brave_search_api_key is None:
        raise ApiError(
            ApiErrorCode.E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED,
            "Dossier web research is not configured",
        )


def _subject_ref(row: Any) -> ResourceRef | None:
    scheme = cast(ResourceScheme, row.subject_scheme)
    return None if row.subject_scheme == "idea" else ResourceRef(scheme, row.subject_id)


def _job_key(build_id: UUID) -> str:
    return f"dossier_build:{build_id}"


def _sql(db: Session, query: str, **params: object) -> Result[Any]:
    return db.execute(text(query), params)
