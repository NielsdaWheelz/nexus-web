"""Synapse engine: the sole writer of ``origin='synapse'`` resource-graph edges.

A scan reads one source object's dossier, retrieves candidates from the
viewer's own corpus through ``search()``, asks a light-tier model which
candidates genuinely illuminate the source, and replace-sets the source's
``(source, origin='synapse')`` edge set with the survivors — each carrying a
one-line rationale in the edge snapshot ``excerpt``.

A successful scan owns the whole set, including setting it empty; every other
outcome leaves prior edges untouched. Dismissal (``synapse_suppressions``) is
the one memory the engine keeps: a dismissed pair is never re-proposed in
either direction. Scan state is the ``background_jobs`` row, keyed
``synapse_scan:<user id>:<ref uri>``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Highlight, Media, NoteBlock, Page, SynapseSuppression
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    enqueue_unique_job,
    get_job,
    lock_running_job_claim,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present
from nexus.schemas.search import (
    SearchResultContentChunkOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
)
from nexus.services import durable_step_journal as step_journal
from nexus.services import generation_policy
from nexus.services import llm_execution as llm
from nexus.services import structured_synthesis as synthesis
from nexus.services.codex_generation_contract import GenerationTerminal
from nexus.services.generation_spec import ImmutablePromptPayloadRef, generation_fact_digest
from nexus.services.llm_ledger import LlmCallOwner, lock_generation_owner_in_current_transaction
from nexus.services.media_intelligence import NotReady, get_media_unit
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import (
    delete_edge,
    get_owned_edge,
    replace_edges_for_origin,
)
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import (
    SYNAPSE_SOURCE_SCHEMES,
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
)
from nexus.services.search.query import SearchQuery
from nexus.services.search.service import search

logger = get_logger(__name__)

SYNAPSE_OPERATION = "synapse"
SYNAPSE_CANDIDATE_LIMIT = 12
SYNAPSE_MAX_CONNECTIONS = 4
# Two spans of one work is passage grain, four is monologue. Keyed on the
# candidate's owner media.
SYNAPSE_MAX_CONNECTIONS_PER_WORK = 2
SYNAPSE_QUERY_CHAR_BUDGET = 800
SYNAPSE_DOSSIER_CHAR_BUDGET = 12_000
_SYNTHESIS_STEP_PATH = "synthesis"
_SOURCE_TABLES = {
    "media": "media",
    "page": "pages",
    "note_block": "note_blocks",
    "highlight": "highlights",
}


@dataclass(frozen=True, slots=True)
class ScanResult:
    """One scan's worker outcome. ``failed`` is the job kind's only retryable
    status; a durable Completed generation is always ``terminal_failed``, its
    replay identity cannot dispatch again. ``error_code`` reaches the job result.
    """

    status: Literal["ok", "skipped", "failed", "terminal_failed"]
    error_code: str | None = None


class _CompletedSynapseEdge(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    target_uri: str
    title: str
    kind: Literal["context", "supports", "contradicts"]
    rationale: str


class _CompletedSynapse(BaseModel):
    """The durable terminal decision, stored as JSON in the step journal."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["success", "failure", "skipped"]
    edges: tuple[_CompletedSynapseEdge, ...] = ()
    error_code: str | None = None
    error_detail: str | None = None
    reason: str | None = None


# ---------- public contract ---------------------------------------------------


def queue_synapse_scan(db: Session, *, user_id: UUID, ref: ResourceRef, reason: str) -> bool:
    """Soft-enqueue one scan for ``ref``; never breaks the host write.

    True only when a row was inserted: False when the engine is disabled, the
    scheme is not scannable, a scan is already in flight, or the insert fails
    (isolated behind a SAVEPOINT, so the host write still commits). Flush-only.
    """
    if not get_settings().synapse_enabled or ref.scheme not in SYNAPSE_SOURCE_SCHEMES:
        return False
    dedupe_key = _scan_dedupe_key(user_id, ref)
    try:
        with db.begin_nested():
            # Free the key from terminal rows so a fresh scan can enqueue;
            # 'failed' rows keep it, their retry slot already owes the work.
            db.execute(
                text(
                    "DELETE FROM background_jobs"
                    " WHERE dedupe_key = :k AND status IN ('succeeded', 'dead')"
                ),
                {"k": dedupe_key},
            )
            _, inserted = enqueue_unique_job(
                db,
                kind="synapse_scan",
                payload={
                    "user_id": str(user_id),
                    "ref": ref.uri,
                    "reason": reason,
                    "coordination": {},
                },
                dedupe_key=dedupe_key,
            )
        return inserted
    except SQLAlchemyError as exc:
        logger.warning("synapse_scan_enqueue_failed", ref=ref.uri, reason=reason, error=str(exc))
        return False


def scan_status(
    db: Session, *, user_id: UUID, ref: ResourceRef
) -> Literal["idle", "pending", "running"]:
    """Scan state for ``ref``: the background-job row is the scan state. A
    ``failed`` row awaiting its retry slot still owes work and reads
    ``pending``; terminal rows and no row read ``idle``.
    """
    status = db.execute(
        text(
            "SELECT status FROM background_jobs"
            " WHERE dedupe_key = :k AND status IN ('pending', 'running', 'failed')"
        ),
        {"k": _scan_dedupe_key(user_id, ref)},
    ).scalar_one_or_none()
    if status is None:
        return "idle"
    return "running" if status == "running" else "pending"


def dismiss_synapse_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Record a permanent suppression for the edge's pair, then delete the edge.

    Only the engine's own assertions are dismissible. Suppression is work grain:
    an ``evidence_span`` target is normalized to its owner media, so a re-scan
    cannot propose another span of that work. Flush-only; the route commits.
    """
    edge = get_owned_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    if edge.origin != "synapse":
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE, "Only synapse edges can be dismissed"
        )
    target = edge.target
    if target.scheme == "evidence_span":
        owner_media_id = db.scalar(
            text("SELECT owner_id FROM evidence_spans WHERE id = :id AND owner_kind = 'media'"),
            {"id": target.id},
        )
        if owner_media_id is not None:
            target = ResourceRef(scheme="media", id=owner_media_id)
    existing = db.execute(
        select(SynapseSuppression.user_id).where(
            SynapseSuppression.user_id == viewer_id,
            SynapseSuppression.source_scheme == edge.source.scheme,
            SynapseSuppression.source_id == edge.source.id,
            SynapseSuppression.target_scheme == target.scheme,
            SynapseSuppression.target_id == target.id,
        )
    ).scalar_one_or_none()
    if existing is None:  # SELECT-then-insert (database.md: no ON CONFLICT)
        try:
            with db.begin_nested():
                db.add(
                    SynapseSuppression(
                        user_id=viewer_id,
                        source_scheme=edge.source.scheme,
                        source_id=edge.source.id,
                        target_scheme=target.scheme,
                        target_id=target.id,
                    )
                )
                db.flush()
        except IntegrityError as exc:
            # A concurrent dismiss already recorded the pair.
            if integrity_constraint_name(exc) != "synapse_suppressions_pkey":
                raise
    delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)


async def run_synapse_scan(
    db: Session,
    *,
    user_id: UUID,
    ref: ResourceRef,
    context: JobExecutionContext,
    runtime: llm.ExecutionRuntime,
) -> ScanResult | RescheduleRequested:
    """Worker body: one dossier → retrieve → judge → replace-set scan.

    ``skipped``: engine disabled, source gone, dossier unavailable, or the
    running claim lost. ``failed``: a transient pre-dispatch concurrency
    rejection (retried). ``terminal_failed``: any Completed generation failure,
    whose replay identity cannot dispatch again. ``ok`` replace-sets the
    source's synapse edges, possibly to empty.
    """
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError(f"synapse job {context.job_id} disappeared")
    generation_id = step_journal.stable_generation_id(context.job_id, _SYNTHESIS_STEP_PATH)
    state = step_journal.read_step_states(job).get(_SYNTHESIS_STEP_PATH)

    def settle(completed: _CompletedSynapse, *, preaccept: str | None = None) -> ScanResult:
        return _apply_completed_synapse(
            db,
            user_id=user_id,
            ref=ref,
            context=context,
            completed=completed,
            preaccept_reason=preaccept,
        )

    def skip(reason: str, detail: str) -> ScanResult:
        """Abandon the scan; a Prepared admission is cancelled, never dispatched."""
        if state is None:
            return ScanResult("skipped")
        db.rollback()
        return settle(_CompletedSynapse(outcome="skipped", reason=reason), preaccept=detail)

    if state is not None and state.dispatch_phase is step_journal.Completed:
        if not isinstance(state.terminal_result, Present):
            raise AssertionError("Completed synapse generation has no result")
        return settle(_CompletedSynapse.model_validate_json(state.terminal_result.value))
    if state is not None and state.dispatch_phase is step_journal.Uncertain:
        db.commit()
        raise llm.GenerationUncertain(
            f"synapse generation {generation_id} has an unresolved dispatch"
        )

    if not get_settings().synapse_enabled:
        return skip("disabled", "synapse disabled before dispatch")
    try:
        assert_ref_visible(db, viewer_id=user_id, ref=ref)
    except NotFoundError:
        return skip("source_missing", "synapse source disappeared before dispatch")

    db.commit()
    dossier = _build_dossier(db, user_id=user_id, ref=ref)
    if dossier is None:
        return skip("dossier_unavailable", "synapse dossier unavailable before dispatch")

    # Close the dossier read transaction before retrieval crosses the embedding
    # transport; ``search`` owns its own pre-I/O read transaction. Over-fetch:
    # exclusion happens after retrieval and the source's own chunks often
    # dominate the top hits.
    db.commit()
    response = search(
        db,
        user_id,
        SearchQuery(
            text=dossier.text[:SYNAPSE_QUERY_CHAR_BUDGET],
            requested_kinds=frozenset({"documents", "notes"}),
            limit=min(50, SYNAPSE_CANDIDATE_LIMIT * 4),
        ),
    )
    candidates = _map_candidates(
        response.results,
        excluded=_excluded_refs(db, user_id=user_id, ref=ref, kin=dossier.kin_refs),
    )
    if not candidates:
        # The engine currently sees nothing: own the empty set.
        if state is None:
            return settle(_CompletedSynapse(outcome="success"))
        db.rollback()
        return settle(
            _CompletedSynapse(outcome="success"),
            preaccept="synapse candidate set became empty before dispatch",
        )

    intent = synthesis.build_synthesis_intent(
        system_prompt=_SYNAPSE_SYSTEM_PROMPT,
        user_content=_build_synapse_user_content(dossier.text, candidates),
        schema=SynapseSynthesis,
    )

    def lock_dispatch(dispatch_db: Session) -> JobRow | None:
        try:
            assert_ref_visible(dispatch_db, viewer_id=user_id, ref=ref)
        except NotFoundError:
            return None
        return get_job(dispatch_db, context.job_id)

    # A first dispatch reloads the prepared job; a replay may retain an earlier
    # read snapshot. Neither may cross the generation host I/O boundary.
    db.commit()
    revision = generation_policy.operation_revision(SYNAPSE_OPERATION)
    try:
        execution_request = await llm.admit_job_generation(
            owner=LlmCallOwner(kind="synapse_scan", id=ref.id),
            generation_id=generation_id,
            operation="synapse",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="synapse_scan",
                owner_id=str(ref.id),
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=llm.JobGenerationJournal(
                context=context,
                step_path=_SYNTHESIS_STEP_PATH,
                lock_dispatch=lock_dispatch,
            ),
            session_factory=get_session_factory(),
            runtime=runtime,
        )
        execution_result = await llm.execute_generation(
            execution_request,
            session_factory=get_session_factory(),
            runtime=runtime,
            encode_terminal=lambda terminal: _encode_synapse_terminal(
                llm.codex_terminal_evidence(terminal), candidates=candidates
            ),
            encode_failure=_encode_synapse_failure,
        )
    except llm.GenerationAdmissionInputsChanged:
        db.rollback()
        return skip("input_changed", "synapse input changed before dispatch")
    except llm.GenerationDispatchAborted:
        return skip("pre_dispatch_aborted", "synapse dispatch invalidated before acceptance")
    if isinstance(execution_result, RescheduleRequested):
        return execution_result
    return settle(_CompletedSynapse.model_validate_json(execution_result.terminal_result))


# ---------- internal: terminal encoding and publication -----------------------


def _encode_synapse_terminal(
    terminal: GenerationTerminal, *, candidates: list[_SynapseCandidate]
) -> llm.EncodedGenerationTerminal:
    if terminal.status != "succeeded":
        code, detail = synthesis.outcome_failure_facts(terminal)
        return llm.EncodedGenerationTerminal(
            terminal_result=_CompletedSynapse(
                outcome="failure", error_code=code, error_detail=detail
            ).model_dump_json()
        )
    try:
        value = synthesis.decode_structured_synthesis(terminal, schema=SynapseSynthesis)
        if len(value.connections) > SYNAPSE_MAX_CONNECTIONS:
            raise synthesis.StructuredSynthesisError(
                f"synapse output exceeds {SYNAPSE_MAX_CONNECTIONS} connections"
            )
        grounded = (
            synthesis.ground_indices(
                value.connections,
                candidates,
                index_of=lambda connection: connection.candidate_index,
                policy="drop",
            )
            or []
        )
        if len(grounded) != len(value.connections):
            raise synthesis.StructuredSynthesisError(
                "synapse output references a candidate index that was not offered"
            )
    except synthesis.StructuredSynthesisError as exc:
        detail = str(exc)
        return llm.EncodedGenerationTerminal(
            terminal_result=_CompletedSynapse(
                outcome="failure", error_code="invalid_output", error_detail=detail
            ).model_dump_json(),
            accepted_failure=llm.AcceptedGenerationFailure(code="invalid_output", detail=detail),
        )
    edges: list[_CompletedSynapseEdge] = []
    seen_targets: set[ResourceRef] = set()
    for connection, candidate in grounded:
        if candidate.target in seen_targets:
            continue
        seen_targets.add(candidate.target)
        edges.append(
            _CompletedSynapseEdge(
                target_uri=candidate.target.uri,
                title=candidate.label,
                kind=connection.kind,
                rationale=connection.rationale,
            )
        )
    return llm.EncodedGenerationTerminal(
        terminal_result=_CompletedSynapse(
            outcome="success", edges=tuple(edges[:SYNAPSE_MAX_CONNECTIONS])
        ).model_dump_json()
    )


def _encode_synapse_failure(code: llm.GenerationFailureCode, detail: str) -> str:
    return _CompletedSynapse(
        outcome="failure", error_code=code, error_detail=detail
    ).model_dump_json()


def _apply_completed_synapse(
    db: Session,
    *,
    user_id: UUID,
    ref: ResourceRef,
    context: JobExecutionContext,
    completed: _CompletedSynapse,
    preaccept_reason: str | None = None,
) -> ScanResult:
    """Publish one terminal decision inside a serializable transaction.

    ``preaccept_reason`` marks a decision taken before dispatch: the Prepared
    admission is cancelled at the same replay identity, so no model call arms.
    """
    if completed.outcome == "failure" and preaccept_reason is None:
        db.commit()
        return ScanResult("terminal_failed", error_code=completed.error_code)
    owner = LlmCallOwner(kind="synapse_scan", id=ref.id)

    def publish() -> ScanResult:
        if preaccept_reason is not None:
            lock_generation_owner_in_current_transaction(db, owner)
            _lock_scan_source(db, ref)
        if not lock_running_job_claim(db, context=context):
            db.rollback()
            return ScanResult("skipped")
        if preaccept_reason is not None:
            job = get_job(db, context.job_id)
            if job is None:
                raise AssertionError(f"synapse job {context.job_id} disappeared at cancellation")
            current = step_journal.read_step_states(job).get(_SYNTHESIS_STEP_PATH)
            if current is None:
                raise AssertionError("synapse cancellation requires the Prepared checkpoint")
            next_state = llm.cancel_prepared_generation_without_dispatch_in_current_transaction(
                db,
                owner=owner,
                state=current,
                terminal_result=completed.model_dump_json(),
            )
            if not step_journal.checkpoint_step_state(
                db, ctx=context, job=job, step_path=_SYNTHESIS_STEP_PATH, state=next_state
            ):
                raise llm.GenerationUncertain(
                    f"synapse generation {current.generation_id} lost its claim at cancellation"
                )
        if completed.outcome == "skipped":
            db.commit()
            return ScanResult("skipped")
        if completed.outcome == "failure":
            db.commit()
            return ScanResult("terminal_failed", error_code=completed.error_code)
        try:
            assert_ref_visible(db, viewer_id=user_id, ref=ref)
        except NotFoundError:
            db.commit()
            return ScanResult("skipped")
        # The user may have dismissed a proposed pair while the model ran.
        excluded = _excluded_refs(db, user_id=user_id, ref=ref, kin=frozenset())
        replace_edges_for_origin(
            db,
            viewer_id=user_id,
            source=ref,
            origin="synapse",
            edges=[
                EdgeCreate(
                    source=ref,
                    target=assert_resource_ref(edge.target_uri),
                    kind=edge.kind,
                    origin="synapse",
                    snapshot=CitationSnapshot(title=edge.title, excerpt=edge.rationale),
                )
                for edge in completed.edges
                if assert_resource_ref(edge.target_uri) not in excluded
            ],
        )
        db.commit()
        return ScanResult("ok")

    return retry_serializable(db, "synapse.publish", publish)


def _lock_scan_source(db: Session, ref: ResourceRef) -> None:
    """Lock the concrete scan source without treating its current text as input."""
    db.execute(
        text(f"SELECT id FROM {_SOURCE_TABLES[ref.scheme]} WHERE id = :id FOR UPDATE"),
        {"id": ref.id},
    )


def _scan_dedupe_key(user_id: UUID, ref: ResourceRef) -> str:
    return f"synapse_scan:{user_id}:{ref.uri}"


# ---------- internal: dossier -------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Dossier:
    text: str
    kin_refs: frozenset[ResourceRef]  # never-candidate refs (a highlight's anchor media)


def _build_dossier(db: Session, *, user_id: UUID, ref: ResourceRef) -> _Dossier | None:
    """Per-scheme source text, or ``None`` to skip. Visibility is the caller's."""
    if ref.scheme == "media":
        unit = get_media_unit(db, media_id=ref.id)
        title = db.scalar(select(Media.title).where(Media.id == ref.id))
        if isinstance(unit, NotReady) or title is None:
            return None
        claims = "\n".join(f"- {claim.claim_text}" for claim in unit.claims)
        text_out = f"{title}\n\n{unit.summary_md}\n\n{claims}"
        return _Dossier(text_out[:SYNAPSE_DOSSIER_CHAR_BUDGET], frozenset())
    if ref.scheme == "page":
        page_title = db.scalar(select(Page.title).where(Page.id == ref.id))
        if page_title is None:
            return None
        return _Dossier(page_title[:SYNAPSE_DOSSIER_CHAR_BUDGET], frozenset())
    if ref.scheme == "note_block":
        body = db.scalar(
            select(NoteBlock.body_text).where(NoteBlock.id == ref.id, NoteBlock.user_id == user_id)
        )
        if body is None:
            return None
        return _Dossier(body[:SYNAPSE_DOSSIER_CHAR_BUDGET], frozenset())
    highlight = db.scalar(
        select(Highlight).where(Highlight.id == ref.id, Highlight.user_id == user_id)
    )
    if highlight is None or highlight.anchor_media_id is None:
        return None
    anchor_title = db.scalar(select(Media.title).where(Media.id == highlight.anchor_media_id))
    if anchor_title is None:
        return None
    source_text = (
        f'Highlight from "{anchor_title}":\n{highlight.prefix}{highlight.exact}{highlight.suffix}'
    )
    notes = linked_note_blocks_for_highlights(db, user_id, [ref.id]).get(ref.id, [])
    note_text = "\n".join(block.body_text for block in notes)
    if note_text:
        source_text += f"\n\nReader note:\n{note_text}"
    return _Dossier(
        source_text[:SYNAPSE_DOSSIER_CHAR_BUDGET],
        frozenset({ResourceRef(scheme="media", id=highlight.anchor_media_id)}),
    )


# ---------- internal: candidates + exclusions ---------------------------------


@dataclass(frozen=True, slots=True)
class _SynapseCandidate:
    """One judged object: a span/object-grain target plus its display fields.

    ``owner_media_id`` is the containing media for span and media targets
    (``None`` for note blocks); exclusion and the per-work cap compare there.
    """

    target: ResourceRef
    label: str
    snippet: str
    owner_media_id: UUID | None = None


def _excluded_refs(
    db: Session, *, user_id: UUID, ref: ResourceRef, kin: frozenset[ResourceRef]
) -> set[ResourceRef]:
    """Targets the judge must never see: self, kin, already connected, suppressed."""
    excluded = {ref, *kin}
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=user_id,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(),
                limit=100,
                cursor=cursor,
            ),
        )
        for edge in page.items:
            # This scan's own replace-set: its targets stay proposable.
            if edge.origin == "synapse" and edge.source_ref == ref:
                continue
            excluded.add(edge.other.ref)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    # Suppression is undirected: either endpoint of a dismissed pair silences
    # the other.
    suppressed = db.execute(
        text("""
            SELECT
                CASE WHEN source_id = :id AND source_scheme = :scheme
                    THEN target_scheme ELSE source_scheme END AS scheme,
                CASE WHEN source_id = :id AND source_scheme = :scheme
                    THEN target_id ELSE source_id END AS id
            FROM synapse_suppressions
            WHERE user_id = :user_id
              AND ((source_scheme = :scheme AND source_id = :id)
                   OR (target_scheme = :scheme AND target_id = :id))
        """),
        {"user_id": user_id, "scheme": ref.scheme, "id": ref.id},
    ).mappings()
    for row in suppressed:
        excluded.add(
            ResourceRef(scheme=cast("ResourceScheme", str(row["scheme"])), id=UUID(str(row["id"])))
        )
    return excluded


def _map_candidates(
    results: Sequence[SearchResultOut], *, excluded: set[ResourceRef]
) -> list[_SynapseCandidate]:
    """Map retrieval hits to deduped candidates, best score first.

    Chunk hits map to their ``evidence_span`` (passage grain), falling back to
    ``media`` when the chunk carries no span; note hits stay block grain.
    Results arrive score-sorted, so the first hit per target keeps the best
    snippet, and one work contributes at most two passages.
    """
    candidates: list[_SynapseCandidate] = []
    seen: set[ResourceRef] = set()
    per_work: dict[UUID, int] = {}
    for result in results:
        if isinstance(result, SearchResultContentChunkOut):
            span_id = result.evidence_span_ids[0] if result.evidence_span_ids else None
            owner_media_id = result.source.media_id
            candidate = _SynapseCandidate(
                target=(
                    ResourceRef(scheme="evidence_span", id=span_id)
                    if span_id is not None
                    else ResourceRef(scheme="media", id=owner_media_id)
                ),
                label=result.source.title,
                # Chunk snippets carry ts_headline markup — noise to the judge.
                snippet=result.snippet.replace("<b>", "").replace("</b>", ""),
                owner_media_id=owner_media_id,
            )
        elif isinstance(result, SearchResultNoteBlockOut):
            body = result.body_text.strip()
            candidate = _SynapseCandidate(
                target=ResourceRef(scheme="note_block", id=result.id),
                label=body.splitlines()[0][:80] if body else "Note",
                # Note bodies are unbounded; clamp to snippet scale.
                snippet=result.body_text[:600],
            )
        else:
            continue
        exclusion_ref = (
            ResourceRef(scheme="media", id=candidate.owner_media_id)
            if candidate.owner_media_id is not None
            else candidate.target
        )
        if exclusion_ref in excluded or candidate.target in seen:
            continue
        if candidate.owner_media_id is not None:
            if per_work.get(candidate.owner_media_id, 0) >= SYNAPSE_MAX_CONNECTIONS_PER_WORK:
                continue
            per_work[candidate.owner_media_id] = per_work.get(candidate.owner_media_id, 0) + 1
        seen.add(candidate.target)
        candidates.append(candidate)
    return candidates[:SYNAPSE_CANDIDATE_LIMIT]


# ---------- internal: prompt + output schema ----------------------------------


class SynapseConnectionOut(BaseModel):
    """One proposed connection in the model's strict-JSON output."""

    model_config = ConfigDict(extra="forbid")

    candidate_index: int
    kind: Literal["context", "supports", "contradicts"]
    rationale: str

    @field_validator("rationale")
    @classmethod
    def _bounded_rationale(cls, value: str) -> str:
        # Not Field(min_length=…): the canonical emitted JSON schema subset
        # carries no length keywords.
        if not 1 <= len(value) <= 240:
            raise ValueError("rationale must be 1-240 characters")
        return value


class SynapseSynthesis(BaseModel):
    """The strict-JSON resonance judgment shape."""

    model_config = ConfigDict(extra="forbid")

    connections: list[SynapseConnectionOut]


_SYNAPSE_SYSTEM_PROMPT = synthesis.build_synthesis_prompt(
    persona=(
        "You are the resonance engine of a personal knowledge system: given one "
        "source object and candidate passages from the user's own corpus, you "
        "judge which candidates genuinely illuminate the source."
    ),
    preamble=None,
    domain_rules=[
        synthesis.INDEX_GROUNDING_RULE + " Do not invent candidates, indices, or quotations.",
        "Propose only connections where remembering the candidate genuinely "
        "illuminates the source — a shared argument, a direct contradiction, the "
        "same idea in different words, a concrete example; reject mere topical "
        "overlap.",
        f"Propose at most {SYNAPSE_MAX_CONNECTIONS} connections — "
        "only the strongest; fewer is better.",
        'Use kind "supports" or "contradicts" only when the relation is genuinely '
        'argued; otherwise use "context".',
        "rationale: one sentence to the user naming the specific resonance, under 200 characters.",
        "Write each rationale so it reads correctly from either object; never use "
        "the words 'source', 'candidate', or indices.",
        "An empty list is a good answer.",
    ],
    json_shape=(
        '{"connections": [{"candidate_index": int, '
        '"kind": "context" | "supports" | "contradicts", "rationale": string}]}'
    ),
)


def _build_synapse_user_content(source_text: str, candidates: list[_SynapseCandidate]) -> str:
    rendered = "\n\n".join(
        f"[{index}] {candidate.label}: {candidate.snippet}"
        for index, candidate in enumerate(candidates)
    )
    return synthesis.build_synthesis_user_content(
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=f"SOURCE:\n{source_text}",
    )
