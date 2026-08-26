"""Real-PostgreSQL proof for the application-owned generation-ledger contract."""

from __future__ import annotations

from typing import Literal, cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationSessionRef,
    GenerationTerminal,
    NormalizedFailureCode,
)
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    cancel_preaccept_generation_if_started_in_current_transaction,
    complete_generation_in_current_transaction,
    complete_preaccept_failure_if_started_in_current_transaction,
    read_generation,
    start_generation_in_current_transaction,
)
from tests.testkit.unreachable_state import (
    GenerationLedgerCorruption,
    corrupt_generation_ledger_row,
)

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


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
                "input": "generation ledger invariant proof",
                "output": {"kind": "Text"},
            },
        }
    )


def _terminal() -> GenerationTerminal:
    return GenerationTerminal(
        status="succeeded",
        failure=None,
        final_text="accepted terminal",
        structured_output=None,
        session_ref=GenerationSessionRef(
            schema_version="agent-session-ref.v1",
            backend="codex",
            transport="sdk",
            native_session_id="ledger-proof-session",
            profile_key="codex-personal",
            state_root_fingerprint="a" * 64,
            cwd_fingerprint="b" * 64,
        ),
        usage=None,
        diagnostics=(),
        accepted_at="2026-08-24T12:34:56.123456Z",
        sdk_version="0.144.4",
        runtime_version="0.144.4",
    )


def test_sole_writer_assigns_positive_ordinals_and_rejects_invalid_terminal_facts(
    engine: Engine,
) -> None:
    """Risk: removing business constraints admits an invalid application write."""

    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    first_id = uuid4()
    second_id = uuid4()
    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=_command(first_id), streaming=False),
        )
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=_command(second_id), streaming=False),
        )

        with pytest.raises(ValueError, match="accepted failure override"):
            complete_generation_in_current_transaction(
                db,
                owner=owner,
                generation_id=first_id,
                terminal=_terminal(),
                latency_ms=1,
                accepted_failure_code=cast(Literal["invalid_output"], "timeout"),
            )
        with pytest.raises(ValueError, match="normalized pre-accept failure code"):
            complete_preaccept_failure_if_started_in_current_transaction(
                db,
                owner=owner,
                generation_id=first_id,
                error_code=cast(NormalizedFailureCode, "unknown"),
                error_detail="invalid code",
            )
        with pytest.raises(ValueError, match="failure detail must not be blank"):
            complete_preaccept_failure_if_started_in_current_transaction(
                db,
                owner=owner,
                generation_id=first_id,
                error_code="capacity_unavailable",
                error_detail=" " * 1_001,
            )
        with pytest.raises(ValueError, match="cancellation reason must not be blank"):
            cancel_preaccept_generation_if_started_in_current_transaction(
                db,
                owner=owner,
                generation_id=first_id,
                reason=" ",
            )

        assert complete_preaccept_failure_if_started_in_current_transaction(
            db,
            owner=owner,
            generation_id=first_id,
            error_code="capacity_unavailable",
            error_detail="x" * 1_001,
        )
        first = read_generation(db, generation_id=first_id)
        second = read_generation(db, generation_id=second_id)
        assert first is not None and second is not None
        assert (first.generation_seq, second.generation_seq) == (1, 2)
        assert first.outcome == "Failed"
        assert first.error_detail == "x" * 1_000
        assert (second.outcome, second.completed_at) == (None, None)


@pytest.mark.parametrize(
    ("corruption", "diagnostic"),
    (
        ("nonpositive_sequence", "generation_seq"),
        ("owner_operation", "owner/operation"),
        ("plan_capability", "plan facts"),
        ("route", "route"),
        ("fingerprint", "request_fingerprint"),
        ("session_ref", "session_ref"),
        ("usage", "usage"),
        ("lifecycle", "lifecycle"),
    ),
    ids=(
        "positive-sequence",
        "owner-operation",
        "plan-capability",
        "route",
        "fingerprint",
        "session-ref",
        "usage",
        "lifecycle",
    ),
)
def test_typed_reader_defects_on_corrupt_trusted_rows(
    engine: Engine,
    *,
    corruption: GenerationLedgerCorruption,
    diagnostic: str,
) -> None:
    """Risk: a corrupt trusted row is cast into a valid-looking ledger record."""

    generation_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(owner=owner, command=_command(generation_id), streaming=False),
        )
        db.commit()

    with Session(engine) as db:
        corrupt_generation_ledger_row(
            db,
            generation_id=generation_id,
            corruption=corruption,
        )
        db.commit()

    with Session(engine) as db, pytest.raises(AssertionError, match=diagnostic):
        read_generation(db, generation_id=generation_id)
