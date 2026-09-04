"""Service proof for operator repair of an accepted ambiguous generation."""

from __future__ import annotations

import hashlib
import json
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

# BASE sensitivity overlays this whole-file owner without the candidate
# route-neutral generation event model or its supporting ledger/testkit owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_events") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.schemas.presence import Present, absent, present
    from nexus.services.codex_generation_client import CodexGenerationProtocolDefect
    from nexus.services.codex_generation_contract import (
        GenerationCommandDraft,
        GenerationFailure,
        GenerationFrame,
        GenerationSessionRef,
        GenerationTerminal,
    )
    from nexus.services.durable_step_journal import Completed, Prepared, StepReplayState, Uncertain
    from nexus.services.generation_events import BackendTerminal
    from nexus.services.llm_execution import (
        AttachReconciledGenerationTerminal,
        EncodedGenerationTerminal,
        GenerationReconciliationRequest,
        cancel_prepared_generation_without_dispatch_in_current_transaction,
        codex_terminal_evidence,
        prove_uncertain_generation_not_dispatched_in_current_transaction,
        reconcile_uncertain_generation_in_current_transaction,
    )
    from nexus.services.llm_ledger import (
        LlmCallOwner,
        read_generation,
        read_model_turns,
    )
    from nexus.services.structured_synthesis import outcome_failure_facts
    from tests.testkit.codex_generation import (
        codex_generation_draft,
        stage_uncertain_codex_generation,
    )

_RAW_RECONCILIATION_DIAGNOSTIC = "operator supplied secret diagnostic"
_RETAINED_BACKEND_FAILURE_DETAIL = "codex generation failed: backend_failed"


def _candidate_engine(request: pytest.FixtureRequest) -> Engine:
    assert _CUTOVER_PRESENT, "the route-neutral generation reconciliation owner is absent"
    return cast(Engine, request.getfixturevalue("engine"))


def _draft(generation_id: UUID) -> GenerationCommandDraft:
    return codex_generation_draft(
        request_id=generation_id,
        operation="metadata_enrichment",
        instructions="Return one bounded result.",
        input_text="operator reconciliation proof",
        model="gpt-5.6-terra",
        reasoning="high",
        turn_timeout_seconds=180,
    )


def _terminal_frame(generation_id: UUID) -> GenerationFrame:
    return GenerationFrame(
        request_id=generation_id,
        sequence=0,
        event=GenerationTerminal(
            status="succeeded",
            failure=None,
            final_text="recovered terminal",
            structured_output=None,
            session_ref=GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id="thread-reconciled-generation",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            ),
            usage=None,
            diagnostics=(),
            accepted_at="2026-08-24T12:34:56.123456Z",
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        ),
    )


def _failed_terminal_frame(generation_id: UUID) -> GenerationFrame:
    return GenerationFrame(
        request_id=generation_id,
        sequence=0,
        event=GenerationTerminal(
            status="failed",
            failure=GenerationFailure(kind="backend_failed"),
            final_text="",
            structured_output=None,
            session_ref=None,
            usage=None,
            diagnostics=(_RAW_RECONCILIATION_DIAGNOSTIC,),
            accepted_at="2026-08-24T12:34:56.123456Z",
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        ),
    )


def _raw_terminal_attachment(
    frame: GenerationFrame,
    *,
    latency_ms: int = 1_234,
) -> AttachReconciledGenerationTerminal:
    raw_stream = (frame.model_dump_json() + "\n").encode("utf-8")
    return AttachReconciledGenerationTerminal(
        raw_stream=raw_stream,
        raw_stream_sha256=hashlib.sha256(raw_stream).hexdigest(),
        latency_ms=latency_ms,
    )


def test_operator_terminal_reconciliation_lands_once_without_owning_the_commit(
    request: pytest.FixtureRequest,
) -> None:
    engine = _candidate_engine(request)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    draft = _draft(generation_id)
    uncertain = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(draft.spec.fingerprint),
        terminal_result=absent(),
    )
    request = GenerationReconciliationRequest(
        owner=owner,
        draft=draft,
        state=uncertain,
        resolution=_raw_terminal_attachment(_terminal_frame(generation_id)),
    )

    with Session(engine) as db:
        stage_uncertain_codex_generation(db, owner=owner, draft=draft)
        db.commit()

    with Session(engine) as db:
        completed = reconcile_uncertain_generation_in_current_transaction(
            db,
            request,
            encode_terminal=lambda terminal: EncodedGenerationTerminal(
                terminal_result=codex_terminal_evidence(terminal).final_text
            ),
        )
        record = read_generation(db, generation_id=generation_id)
        assert isinstance(completed.terminal_result, Present)
        assert completed.terminal_result.value == "recovered terminal"
        assert record is not None
        turns = read_model_turns(db, generation_id=generation_id)
        assert record.outcome == "Succeeded" and len(turns) == 1
        assert turns[0].accepted_at is not None
        assert turns[0].terminal is not None
        assert turns[0].terminal["route"] == "CodexPersonal", (
            "operator reconciliation did not stage the normalized terminal facts; "
            f"generation_id={generation_id}, record={record!r}"
        )
        db.rollback()

    with Session(engine) as db:
        rolled_back = read_generation(db, generation_id=generation_id)
        assert rolled_back is not None
        assert (rolled_back.outcome, rolled_back.completed_at) == (None, None), (
            "the shared reconciliation kernel committed its caller-owned transaction; "
            f"generation_id={generation_id}, record={rolled_back!r}"
        )
        completed = reconcile_uncertain_generation_in_current_transaction(
            db,
            request,
            encode_terminal=lambda terminal: EncodedGenerationTerminal(
                terminal_result=codex_terminal_evidence(terminal).final_text
            ),
        )
        db.commit()

    with Session(engine) as db:
        persisted = read_generation(db, generation_id=generation_id)
        assert persisted is not None and persisted.outcome == "Succeeded", (
            "the caller-owned commit did not publish the reconciled ledger terminal; "
            f"generation_id={generation_id}, record={persisted!r}"
        )
        assert isinstance(completed.terminal_result, Present)
        with pytest.raises(AssertionError, match="not unresolved and armed"):
            reconcile_uncertain_generation_in_current_transaction(
                db,
                request,
                encode_terminal=lambda terminal: EncodedGenerationTerminal(
                    terminal_result=codex_terminal_evidence(terminal).final_text
                ),
            )


def test_reconciled_terminal_cannot_persist_operator_supplied_diagnostics(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: terminal attachment bypasses the live host's redaction boundary."""

    engine = _candidate_engine(request)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    draft = _draft(generation_id)
    request = GenerationReconciliationRequest(
        owner=owner,
        draft=draft,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        ),
        resolution=_raw_terminal_attachment(_failed_terminal_frame(generation_id)),
    )

    with Session(engine) as db:
        stage_uncertain_codex_generation(db, owner=owner, draft=draft)
        db.commit()

    def encode_terminal(terminal: BackendTerminal) -> EncodedGenerationTerminal:
        code, detail = outcome_failure_facts(codex_terminal_evidence(terminal))
        return EncodedGenerationTerminal(
            terminal_result=json.dumps(
                {"code": code, "detail": detail},
                sort_keys=True,
                separators=(",", ":"),
            )
        )

    with Session(engine) as db:
        completed = reconcile_uncertain_generation_in_current_transaction(
            db,
            request,
            encode_terminal=encode_terminal,
        )
        record = read_generation(db, generation_id=generation_id)
        assert record is not None
        assert isinstance(completed.terminal_result, Present)
        retained = completed.terminal_result.value
        assert record.failure_code == "runtime_unavailable"
        assert record.terminal is not None
        model_terminal = record.terminal["model_turn_terminal"]
        assert isinstance(model_terminal, dict)
        evidence = model_terminal["evidence"]
        assert isinstance(evidence, dict)
        diagnostics = evidence["diagnostics"]
        assert diagnostics == [_RETAINED_BACKEND_FAILURE_DETAIL]
        assert _RETAINED_BACKEND_FAILURE_DETAIL in retained
        assert _RAW_RECONCILIATION_DIAGNOSTIC not in json.dumps(record.terminal)
        assert _RAW_RECONCILIATION_DIAGNOSTIC not in retained
        db.commit()


@pytest.mark.parametrize(
    "drift",
    ["request_id", "sdk_version", "runtime_version", "raw_digest", "sequence", "stream"],
)
def test_reconciled_terminal_reuses_live_terminal_validation(
    request: pytest.FixtureRequest,
    *,
    drift: str,
) -> None:
    engine = _candidate_engine(request)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    draft = _draft(generation_id)
    frame = _terminal_frame(generation_id)
    if drift == "request_id":
        frame = frame.model_copy(update={"request_id": uuid4()})
    elif drift in {"sdk_version", "runtime_version"}:
        terminal = frame.event
        assert isinstance(terminal, GenerationTerminal)
        frame = frame.model_copy(
            update={"event": terminal.model_copy(update={drift: "drifted-runtime"})}
        )
    resolution = _raw_terminal_attachment(frame)
    if drift == "raw_digest":
        resolution = resolution.model_copy(update={"raw_stream_sha256": "0" * 64})
    elif drift == "sequence":
        resolution = _raw_terminal_attachment(frame.model_copy(update={"sequence": 1}))
    elif drift == "stream":
        maximum = draft.spec.bounds.stream.max_stream_bytes
        oversized = b"x" * (maximum + 1)
        resolution = resolution.model_copy(
            update={
                "raw_stream": oversized,
                "raw_stream_sha256": hashlib.sha256(oversized).hexdigest(),
            }
        )
    request = GenerationReconciliationRequest(
        owner=owner,
        draft=draft,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        ),
        resolution=resolution,
    )

    with Session(engine) as db:
        stage_uncertain_codex_generation(db, owner=owner, draft=draft)
        db.commit()

    encoded: list[BackendTerminal] = []

    def encode_terminal(terminal: BackendTerminal) -> EncodedGenerationTerminal:
        encoded.append(terminal)
        return EncodedGenerationTerminal(
            terminal_result=codex_terminal_evidence(terminal).final_text
        )

    with Session(engine) as db:
        with pytest.raises(CodexGenerationProtocolDefect):
            reconcile_uncertain_generation_in_current_transaction(
                db,
                request,
                encode_terminal=encode_terminal,
            )
        record = read_generation(db, generation_id=generation_id)
        assert record is not None
        assert (record.outcome, record.completed_at, encoded) == (None, None, [])


def test_non_dispatch_proof_uses_only_persisted_identity_and_retains_the_start(
    request: pytest.FixtureRequest,
) -> None:
    engine = _candidate_engine(request)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    draft = _draft(generation_id)
    uncertain = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(draft.spec.fingerprint),
        terminal_result=absent(),
    )

    with Session(engine) as db:
        stage_uncertain_codex_generation(db, owner=owner, draft=draft)
        db.commit()

    with Session(engine) as db:
        prepared = prove_uncertain_generation_not_dispatched_in_current_transaction(
            db,
            owner=owner,
            state=uncertain,
        )
        record = read_generation(db, generation_id=generation_id)
        assert prepared.dispatch_phase.value == "Prepared"
        assert prepared.request_fingerprint == uncertain.request_fingerprint
        assert record is None
        db.rollback()

    drifted = uncertain.model_copy(update={"request_fingerprint": present("0" * 64)})
    with Session(engine) as db:
        with pytest.raises(AssertionError, match="identity drifted"):
            prove_uncertain_generation_not_dispatched_in_current_transaction(
                db,
                owner=owner,
                state=drifted,
            )


def test_preaccept_owner_cancellation_completes_without_creating_ledger_evidence(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: a terminal owner leaves its Prepared journal or ledger nonterminal."""

    engine = _candidate_engine(request)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    draft = _draft(generation_id)
    prepared = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Prepared,
        request_fingerprint=present(draft.spec.fingerprint),
        terminal_result=absent(),
    )
    with Session(engine) as db:
        completed = cancel_prepared_generation_without_dispatch_in_current_transaction(
            db,
            owner=owner,
            state=prepared,
            terminal_result='{"outcome":"skipped"}',
            reason="owner no longer requires dispatch",
        )
        record = read_generation(db, generation_id=generation_id)
        assert completed.dispatch_phase is Completed
        assert isinstance(completed.terminal_result, Present)
        assert completed.terminal_result.value == '{"outcome":"skipped"}'
        assert record is None
        db.commit()

    with Session(engine) as db:
        persisted = read_generation(db, generation_id=generation_id)
        assert persisted is None
