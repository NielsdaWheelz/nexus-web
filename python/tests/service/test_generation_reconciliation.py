"""Service proof for operator repair of an accepted ambiguous generation."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.schemas.presence import Present, absent, present
from nexus.services import generation_policy
from nexus.services.codex_generation_client import CodexGenerationProtocolDefect
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFailure,
    GenerationFrame,
    GenerationSessionRef,
    GenerationTerminal,
    request_fingerprint,
)
from nexus.services.durable_step_journal import Completed, Prepared, StepReplayState, Uncertain
from nexus.services.llm_execution import (
    AttachReconciledGenerationTerminal,
    EncodedGenerationTerminal,
    GenerationReconciliationRequest,
    cancel_prepared_generation_without_dispatch_in_current_transaction,
    prove_uncertain_generation_not_dispatched_in_current_transaction,
    reconcile_uncertain_generation_in_current_transaction,
)
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    read_generation,
    start_generation_in_current_transaction,
)
from nexus.services.structured_synthesis import outcome_failure_facts

_RAW_RECONCILIATION_DIAGNOSTIC = "operator supplied secret diagnostic"
_RETAINED_BACKEND_FAILURE_DETAIL = "codex generation failed: backend_failed"


def _command(generation_id: UUID) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "schema_version": "nexus-generation-command.v2",
            "request_id": generation_id,
            "operation": {
                "kind": "metadata_enrichment",
                "revision": generation_policy.operation_revision("metadata_enrichment"),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": {
                "instructions": "Return one bounded result.",
                "input": "operator reconciliation proof",
                "output": {"kind": "Text"},
            },
        }
    )


def _terminal_frame(generation_id: UUID) -> GenerationFrame:
    return GenerationFrame(
        request_id=generation_id,
        sequence=7,
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
        sequence=7,
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


def test_operator_terminal_reconciliation_lands_once_without_owning_the_commit(
    engine: Engine,
) -> None:
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    command = _command(generation_id)
    uncertain = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(request_fingerprint(command)),
        terminal_result=absent(),
    )
    request = GenerationReconciliationRequest(
        owner=owner,
        command=command,
        state=uncertain,
        streaming=False,
        resolution=AttachReconciledGenerationTerminal(
            frame=_terminal_frame(generation_id),
            latency_ms=1_234,
        ),
    )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=command, streaming=False),
        )
        db.commit()

    with Session(engine) as db:
        completed = reconcile_uncertain_generation_in_current_transaction(
            db,
            request,
            encode_terminal=lambda terminal: EncodedGenerationTerminal(
                terminal_result=terminal.final_text
            ),
        )
        record = read_generation(db, generation_id=generation_id)
        assert isinstance(completed.terminal_result, Present)
        assert completed.terminal_result.value == "recovered terminal"
        assert record is not None
        assert (record.outcome, record.latency_ms, record.sdk_version) == (
            "Succeeded",
            1_234,
            "0.144.4",
        ), (
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
                terminal_result=terminal.final_text
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
        with pytest.raises(AssertionError, match="already has terminal"):
            reconcile_uncertain_generation_in_current_transaction(
                db,
                request,
                encode_terminal=lambda terminal: EncodedGenerationTerminal(
                    terminal_result=terminal.final_text
                ),
            )


def test_reconciled_terminal_cannot_persist_operator_supplied_diagnostics(
    engine: Engine,
) -> None:
    """Risk: terminal attachment bypasses the live host's redaction boundary."""

    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    command = _command(generation_id)
    request = GenerationReconciliationRequest(
        owner=owner,
        command=command,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(request_fingerprint(command)),
            terminal_result=absent(),
        ),
        streaming=False,
        resolution=AttachReconciledGenerationTerminal(
            frame=_failed_terminal_frame(generation_id),
            latency_ms=1_234,
        ),
    )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=command, streaming=False),
        )
        db.commit()

    def encode_terminal(terminal: GenerationTerminal) -> EncodedGenerationTerminal:
        code, detail = outcome_failure_facts(terminal)
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
        assert record.error_detail == _RETAINED_BACKEND_FAILURE_DETAIL
        assert _RETAINED_BACKEND_FAILURE_DETAIL in retained
        assert _RAW_RECONCILIATION_DIAGNOSTIC not in record.error_detail
        assert _RAW_RECONCILIATION_DIAGNOSTIC not in retained
        db.commit()


@pytest.mark.parametrize("drift", ["request_id", "sdk_version", "runtime_version"])
def test_reconciled_terminal_reuses_live_terminal_validation(
    engine: Engine,
    *,
    drift: str,
) -> None:
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    command = _command(generation_id)
    frame = _terminal_frame(generation_id)
    if drift == "request_id":
        frame = frame.model_copy(update={"request_id": uuid4()})
    else:
        terminal = frame.event
        assert isinstance(terminal, GenerationTerminal)
        frame = frame.model_copy(
            update={"event": terminal.model_copy(update={drift: "drifted-runtime"})}
        )
    request = GenerationReconciliationRequest(
        owner=owner,
        command=command,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(request_fingerprint(command)),
            terminal_result=absent(),
        ),
        streaming=False,
        resolution=AttachReconciledGenerationTerminal(frame=frame, latency_ms=1_234),
    )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=command, streaming=False),
        )
        db.commit()

    encoded: list[GenerationTerminal] = []

    def encode_terminal(terminal: GenerationTerminal) -> EncodedGenerationTerminal:
        encoded.append(terminal)
        return EncodedGenerationTerminal(terminal_result=terminal.final_text)

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
    engine: Engine,
) -> None:
    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    command = _command(generation_id)
    uncertain = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(request_fingerprint(command)),
        terminal_result=absent(),
    )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=command, streaming=False),
        )
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
        assert record is not None and record.outcome is None
        db.rollback()

    drifted = uncertain.model_copy(update={"request_fingerprint": present("0" * 64)})
    with Session(engine) as db:
        with pytest.raises(AssertionError, match="fingerprint drifted"):
            prove_uncertain_generation_not_dispatched_in_current_transaction(
                db,
                owner=owner,
                state=drifted,
            )


@pytest.mark.parametrize("retained_start", [False, True])
def test_preaccept_owner_cancellation_completes_with_or_without_a_retained_start(
    engine: Engine,
    *,
    retained_start: bool,
) -> None:
    """Risk: a terminal owner leaves its Prepared journal or ledger nonterminal."""

    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    command = _command(generation_id)
    prepared = StepReplayState(
        generation_id=generation_id,
        dispatch_phase=Prepared,
        request_fingerprint=present(request_fingerprint(command)),
        terminal_result=absent(),
    )
    if retained_start:
        with Session(engine) as db:
            start_generation_in_current_transaction(
                db,
                GenerationStart(owner=owner, command=command, streaming=False),
            )
            db.commit()

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
        if retained_start:
            assert record is not None and record.outcome == "Cancelled"
        else:
            assert record is None
        db.commit()

    with Session(engine) as db:
        persisted = read_generation(db, generation_id=generation_id)
        if retained_start:
            assert persisted is not None and persisted.outcome == "Cancelled"
        else:
            assert persisted is None
