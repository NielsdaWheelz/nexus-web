"""The oracle reading: one row, pending until one transaction completes or fails it.

The job prepares a snapshot, dispatches it once through the durable generation contract
(a replay reuses the frozen snapshot) and publishes the folio with three citation edges.
Reads project the row; only navigation is current (``get_reading``). A pending reading
that history shows started (``started_at``) displays ``streaming``; the job still owns it.
"""

from typing import Any
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import OracleCorpusSource, OracleReading
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    enqueue_job,
    get_job,
    lock_job,
    lock_running_job_claim,
)
from nexus.schemas.oracle import (
    OracleConcordanceOut,
    OracleFailureCode,
    OraclePassageOut,
    OraclePlateOut,
    OracleReadingCreatedOut,
    OracleReadingOut,
    OracleReadingSummaryOut,
    OracleStoredPassage,
)
from nexus.schemas.presence import Present
from nexus.services import generation_policy, library_governance
from nexus.services.durable_step_journal import (
    Completed,
    Uncertain,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_spec import ImmutablePromptPayloadRef, generation_fact_digest
from nexus.services.llm_execution import (
    ExecutionRuntime,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationUncertain,
    JobGenerationJournal,
    admit_job_generation,
    execute_generation,
    generation_has_local_recovery,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.oracle import corpus, synthesis
from nexus.services.oracle.synthesis import Candidate, Failure, Success
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    hydrate_citation,
    replace_citations_for_output,
)
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot
from nexus.services.search.chunks import retrieve_content_chunk_candidates
from nexus.services.search.service import build_query_embedding
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_STEP = "synthesis"
_TASK = LlmTaskSpec(label="oracle_reading")
_PASSAGES = TypeAdapter(list[OracleStoredPassage])


# ---------- create and read ------------------------------------------------------


def create_reading(
    db: Session, *, viewer_id: UUID, question: str, key: str
) -> OracleReadingCreatedOut:
    """One transaction under the viewer's lock: the key's existing reading, whatever its
    status or question, else the next folio number, the pending row, its job and corpus
    membership."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock, 0))"),
        {"lock": f"oracle_folio:{viewer_id}"},
    )
    reading_id = db.scalar(
        select(OracleReading.id).where(
            OracleReading.user_id == viewer_id, OracleReading.idempotency_key == key
        )
    )
    if reading_id is None:
        folio_number = db.scalar(
            select(func.coalesce(func.max(OracleReading.folio_number), 0) + 1).where(
                OracleReading.user_id == viewer_id
            )
        )
        reading = OracleReading(
            user_id=viewer_id,
            folio_number=folio_number,
            question_text=question,
            idempotency_key=key,
            status="pending",
        )
        db.add(reading)
        db.flush()
        reading_id = reading.id
        enqueue_job(db, kind="oracle_reading_generate", payload={"reading_id": str(reading_id)})
        library_governance.join_system_library(db, system_key=corpus.SYSTEM_KEY, user_id=viewer_id)
    db.commit()
    return OracleReadingCreatedOut(reading_id=reading_id)


def get_reading(db: Session, *, viewer_id: UUID, reading_id: UUID) -> OracleReadingOut:
    """The reading with its passages' current navigation; NotFoundError unless the viewer
    owns it."""
    reading = _owned(db, viewer_id=viewer_id, reading_id=reading_id)
    stored = _PASSAGES.validate_python(reading.passages)
    edges = {}
    if stored:
        source = ResourceRef(scheme="oracle_reading", id=reading.id)
        edges = {c.ordinal: c for c in build_citation_outs(db, viewer_id=viewer_id, source=source)}
    passages = []
    for passage in stored:
        edge = None if passage.ordinal is None else edges.get(passage.ordinal)
        facts = passage.citation
        citation = None
        if edge is not None:
            # The reading's own edge wins; captured facts keep what history showed.
            if facts is not None:
                edge = edge.model_copy(
                    update={
                        "ordinal": facts.ordinal,
                        "role": facts.role,
                        "snapshot": facts.snapshot,
                        "deep_link": facts.deep_link,
                    }
                )
            citation = edge if edge.locator is not None else None
        elif facts is not None:
            saved = hydrate_citation(
                db,
                viewer_id=viewer_id,
                target=ResourceRef(scheme=facts.target_ref.type, id=facts.target_ref.id),
                ordinal=facts.ordinal,
                role=facts.role,
                deep_link=facts.deep_link,
                snapshot=facts.snapshot,
            )
            if saved.locator is not None or saved.activation.href is not None:
                citation = saved
        passages.append(
            OraclePassageOut(
                **passage.model_dump(exclude={"ordinal", "citation"}), citation=citation
            )
        )
    return OracleReadingOut.model_validate(
        {
            **_columns(reading),
            "question_text": reading.question_text,
            "created_at": reading.created_at,
            "folio_motto_gloss": reading.folio_motto_gloss,
            "argument_text": reading.argument_text,
            "interpretation_text": reading.interpretation_text,
            "omens": reading.omens,
            "passages": passages,
            "error_code": reading.error_code,
        }
    )


def list_readings(db: Session, *, viewer_id: UUID) -> list[OracleReadingSummaryOut]:
    readings = db.scalars(
        select(OracleReading)
        .where(OracleReading.user_id == viewer_id)
        .order_by(OracleReading.created_at.desc())
    )
    return [OracleReadingSummaryOut.model_validate(_columns(reading)) for reading in readings]


def concordance(db: Session, *, viewer_id: UUID, reading_id: UUID) -> list[OracleConcordanceOut]:
    """Up to five of the viewer's other complete readings with a motto sharing this one's
    plate, theme or cited targets, by 2·plate + 2·theme + shared targets, then newest."""
    _owned(db, viewer_id=viewer_id, reading_id=reading_id)
    rows = db.execute(
        text(
            """
            SELECT * FROM (
                SELECT o.id, o.folio_number, o.folio_motto, o.folio_theme, o.created_at,
                       coalesce(o.plate_key = r.plate_key, false) AS shared_plate,
                       coalesce(o.folio_theme = r.folio_theme, false) AS shared_theme,
                       (SELECT count(DISTINCT (mine.target_scheme, mine.target_id))
                        FROM resource_edges mine JOIN resource_edges theirs
                          ON theirs.target_scheme = mine.target_scheme
                         AND theirs.target_id = mine.target_id
                        WHERE mine.user_id = r.user_id AND mine.origin = 'citation'
                          AND mine.source_scheme = 'oracle_reading' AND mine.source_id = r.id
                          AND theirs.user_id = r.user_id AND theirs.origin = 'citation'
                          AND theirs.source_scheme = 'oracle_reading' AND theirs.source_id = o.id
                       ) AS shared_passage_count
                FROM oracle_readings r
                JOIN oracle_readings o ON o.user_id = r.user_id AND o.id <> r.id
                    AND o.status = 'complete' AND o.folio_motto IS NOT NULL
                WHERE r.id = :id AND r.status = 'complete'
            ) c
            WHERE 2 * shared_plate::int + 2 * shared_theme::int + shared_passage_count > 0
            ORDER BY 2 * shared_plate::int + 2 * shared_theme::int + shared_passage_count DESC,
                     created_at DESC
            LIMIT 5
            """
        ),
        {"id": reading_id},
    ).mappings()
    return [OracleConcordanceOut.model_validate(row) for row in rows]


def _owned(db: Session, *, viewer_id: UUID, reading_id: UUID) -> OracleReading:
    reading = db.get(OracleReading, reading_id)
    if reading is None or reading.user_id != viewer_id:
        raise NotFoundError(message="Oracle reading not found")
    return reading


def _columns(reading: OracleReading) -> dict[str, Any]:
    """The fields a summary and a reading share. The plate is the captured one, else
    (history without a plate event) its key's current corpus record."""
    plate: object = reading.plate
    if plate is None and reading.plate_key is not None:
        plate = corpus.plate(reading.plate_key)
    started = reading.status == "pending" and reading.started_at is not None
    return {
        "id": reading.id,
        "folio_number": reading.folio_number,
        "status": "streaming" if started else reading.status,
        "folio_motto": reading.folio_motto,
        "folio_theme": reading.folio_theme,
        "plate": None
        if plate is None
        else OraclePlateOut.model_validate(plate, from_attributes=True),
    }


# ---------- the generation job -----------------------------------------------------


def run_reading_job(*, reading_id: UUID, context: JobExecutionContext) -> dict[str, object]:
    return run_llm_task(
        _TASK,
        lambda db, runtime: _run(db, reading_id=reading_id, context=context, runtime=runtime),
    )


async def _run(
    db: Session, *, reading_id: UUID, context: JobExecutionContext, runtime: ExecutionRuntime
) -> dict[str, object]:
    """Publish a journaled outcome, else prepare (or reuse) the snapshot and dispatch once."""
    job = get_job(db, context.job_id)
    assert job is not None  # the worker holds its claim
    state = read_step_states(job).get(_STEP)
    if state is not None and state.dispatch_phase is Completed:
        assert isinstance(state.terminal_result, Present)
        return _publish(
            db, reading_id, context, synthesis.OUTCOME.validate_json(state.terminal_result.value)
        )
    if state is not None and state.dispatch_phase is Uncertain:
        if not generation_has_local_recovery(db, state):
            db.commit()
            raise GenerationUncertain(f"oracle generation {state.generation_id} is unresolved")
    reading = db.get(OracleReading, reading_id)
    assert reading is not None  # readings are never deleted
    if reading.status != "pending":
        status = reading.status
        db.commit()
        return {"status": status, "noop": True}
    viewer_id, question = reading.user_id, reading.question_text

    def lock_dispatch(dispatch_db: Session) -> JobRow | None:
        pending = dispatch_db.execute(
            text("SELECT 1 FROM oracle_readings WHERE id = :id AND status = 'pending' FOR UPDATE"),
            {"id": reading_id},
        ).scalar()
        return lock_job(dispatch_db, context.job_id) if pending else None

    journal = JobGenerationJournal(context=context, step_path=_STEP, lock_dispatch=lock_dispatch)
    if state is None:
        prepared = _prepare(db, viewer_id=viewer_id, question=question)
        if isinstance(prepared, Failure):
            return _publish(db, reading_id, context, prepared)
        intent = synthesis.intent(prepared)
    else:
        admission = journal.read_admission(db)
        assert admission is not None  # a journal state never exists without its admission
        intent = admission[1]
    snapshot = synthesis.snapshot_of(intent)
    db.commit()
    revision = f"{generation_policy.operation_revision('oracle')}.{synthesis.REVISION}"
    sessions = get_session_factory()
    try:
        request = await admit_job_generation(
            owner=LlmCallOwner(kind="oracle_reading", id=reading_id),
            user_id=viewer_id,
            generation_id=stable_generation_id(reading_id, _STEP),
            operation="oracle",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="oracle_reading",
                owner_id=str(reading_id),
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=journal,
            session_factory=sessions,
            runtime=runtime,
        )
        result = await execute_generation(
            request,
            session_factory=sessions,
            runtime=runtime,
            encode_terminal=lambda terminal: synthesis.encode_terminal(terminal, snapshot),
            encode_failure=synthesis.encode_failure,
        )
    except (GenerationDispatchAborted, GenerationAdmissionInputsChanged):
        return {"status": "pending", "noop": True}  # this attempt lost its claim
    return _publish(
        db, reading_id, context, synthesis.OUTCOME.validate_json(result.terminal_result)
    )


def _prepare(db: Session, *, viewer_id: UUID, question: str) -> synthesis.Snapshot | Failure:
    """Retrieve both lanes and choose the plate; a typed Failure when they cannot."""
    embedding = build_query_embedding(
        db, question, ["content_chunk"], transaction_active_at_entry=False
    )
    if embedding is None:
        return _failure("E_APP_SEARCH_FAILED", "semantic embeddings are unavailable")
    corpus.refresh_anchors(db)
    db.commit()
    public = corpus.rank_passages(db, question=question, query_embedding=embedding)
    if len(public) < 3:
        return _failure("E_ORACLE_CORPUS_NOT_READY", f"{len(public)} rankable corpus passages")
    personal: list[Candidate] = []
    owners: set[UUID] = set()
    for chunk in retrieve_content_chunk_candidates(
        db,
        viewer_id=viewer_id,
        query_embedding=embedding,
        exclude_media_ids=db.scalars(select(OracleCorpusSource.media_id)).all(),
    ):
        if chunk.owner_id in owners:
            continue
        owners.add(chunk.owner_id)
        span = chunk.primary_evidence_span_id
        personal.append(
            Candidate(
                source_kind="user_media",
                ref=f"evidence_span:{span}" if span else f"content_chunk:{chunk.content_chunk_id}",
                attribution=f"From your library: {chunk.title}",
                locator=" / ".join(chunk.heading_path[-2:]) or None,
                quote=chunk.chunk_text[:1200],
                tags=("user-library", chunk.source_kind),
            )
        )
        if len(personal) == 4:
            break
    candidates = (*public, *personal)
    plate = corpus.pick_plate(question, (tag for c in candidates for tag in c.tags))
    return synthesis.Snapshot(
        kind="oracle-input.v2",
        question=question,
        plate=synthesis.PlateBrief.model_validate(plate, from_attributes=True),
        candidates=candidates,
        requires_user_content=bool(personal),
    )


def _publish(
    db: Session, reading_id: UUID, context: JobExecutionContext, outcome: Success | Failure
) -> dict[str, object]:
    """The one terminal transaction, fenced to this attempt's claim; a reading leaves
    pending exactly once. A cited target that vanished during generation fails it typed."""
    db.commit()  # end the caller's reads, so the attempt opens its own serializable transaction

    def attempt() -> dict[str, object]:
        reading = db.scalar(
            select(OracleReading).where(OracleReading.id == reading_id).with_for_update()
        )
        assert reading is not None
        if not lock_running_job_claim(db, context=context) or reading.status != "pending":
            status = reading.status
            db.rollback()
            return {"status": status, "noop": True}
        final: Success | Failure = outcome
        if isinstance(outcome, Success):
            corpus.refresh_anchors(db)
            try:
                with db.begin_nested():
                    _complete(db, reading, outcome)
            except NotFoundError:
                final = _failure("E_GENERATION_SOURCE_CHANGED", "a cited passage disappeared")
        if isinstance(final, Failure):
            reading.status = "failed"
            reading.failed_at = func.now()
            reading.error_code = final.error_code
            reading.error_detail = None if final.error_detail is None else final.error_detail[:1000]
        db.commit()
        return {"status": "complete" if isinstance(final, Success) else "failed"}

    return retry_serializable(db, "oracle.publish", attempt)


def _complete(db: Session, reading: OracleReading, success: Success) -> None:
    """The folio replaces whatever the reading held, partial history and its edges too."""
    citations = []
    for ordinal, chosen in enumerate(success.passages, start=1):
        target = assert_resource_ref(chosen.candidate.ref)
        snapshot = CitationSnapshot(
            title=chosen.candidate.attribution,
            excerpt=chosen.candidate.quote,
            section_label=chosen.candidate.locator,
            result_type=target.scheme,
        )
        citations.append(
            CitationInput(target=target, ordinal=ordinal, kind="context", snapshot=snapshot)
        )
    replace_citations_for_output(
        db,
        viewer_id=reading.user_id,
        source=ResourceRef(scheme="oracle_reading", id=reading.id),
        citations=citations,
    )
    reading.status = "complete"
    reading.completed_at = func.now()
    reading.folio_motto = success.folio_motto
    reading.folio_motto_gloss = success.folio_motto_gloss
    reading.folio_theme = success.folio_theme
    reading.argument_text = success.argument
    reading.interpretation_text = success.interpretation
    reading.omens = list(success.omens)
    reading.passages = [
        OracleStoredPassage(
            phase=chosen.phase,
            source_kind=chosen.candidate.source_kind,
            quote=chosen.candidate.quote,
            attribution=chosen.candidate.attribution,
            locator_label=chosen.candidate.locator,
            marginalia=chosen.marginalia,
            ordinal=ordinal,
            citation=None,
        ).model_dump(mode="json")
        for ordinal, chosen in enumerate(success.passages, start=1)
    ]
    reading.plate_key = success.plate_key
    reading.plate = OraclePlateOut.model_validate(
        corpus.plate(success.plate_key), from_attributes=True
    ).model_dump(mode="json")
    db.flush()


def _failure(code: OracleFailureCode, detail: str) -> Failure:
    return Failure(outcome="failure", error_code=code, error_detail=detail)
