"""Owner-neutral durable step-journal kernel contracts."""

from __future__ import annotations

from uuid import UUID

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from nexus.schemas.presence import absent, present
from nexus.services.durable_step_journal import (
    Completed,
    DurableExecutionPhase,
    Prepared,
    StepReplayState,
    decode_step_result,
    decode_step_states,
    encode_step_result,
    payload_with_step_state,
    project_execution_phase,
    stable_generation_id,
)

pytestmark = pytest.mark.unit

_OPERATION_ID = UUID("11111111-1111-4111-8111-111111111111")
_GENERATION_ID = UUID("22222222-2222-4222-8222-222222222222")


class _StrictResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    answer: str


def test_stable_generation_id_preserves_the_persisted_replay_identity() -> None:
    """Risk: extraction must not change identities of already journaled effects."""
    assert stable_generation_id(_OPERATION_ID, "research/web-search/2") == UUID(
        "5dfab0cd-d4f5-5127-9cf3-b2800f52d1a3"
    )


def test_payload_update_preserves_the_exact_coordination_wire_shape() -> None:
    """Risk: non-chat workers must keep reading the existing payload contract."""
    original: dict[str, object] = {"run_id": str(_OPERATION_ID)}
    state = StepReplayState(
        generation_id=_GENERATION_ID,
        dispatch_phase=Completed,
        request_fingerprint=present("a" * 64),
        terminal_result=present('{"answer":"accepted"}'),
    )

    updated = payload_with_step_state(
        original,
        step_path="turn/1/generation",
        state=state,
    )

    assert updated == {
        "run_id": str(_OPERATION_ID),
        "coordination": {
            "turn/1/generation": {
                "generation_id": str(_GENERATION_ID),
                "dispatch_phase": "Completed",
                "request_fingerprint": {"kind": "Present", "value": "a" * 64},
                "terminal_result": {
                    "kind": "Present",
                    "value": '{"answer":"accepted"}',
                },
            }
        },
    }
    assert original == {"run_id": str(_OPERATION_ID)}


def test_persisted_journal_and_step_results_fail_closed() -> None:
    """Risk: corrupt trusted replay material must defect instead of being normalized."""
    with pytest.raises(ValidationError, match="extra_forbidden"):
        decode_step_states(
            {
                "coordination": {
                    "prepare": {
                        "generation_id": str(_GENERATION_ID),
                        "dispatch_phase": "Completed",
                        "request_fingerprint": {"kind": "Absent"},
                        "terminal_result": {"kind": "Absent"},
                        "unexpected": True,
                    }
                }
            }
        )

    with pytest.raises(AssertionError, match="malformed _StrictResult result"):
        decode_step_result('{"answer":"accepted","unexpected":true}', _StrictResult)


def test_step_result_codec_round_trips_only_the_step_owned_schema() -> None:
    """Risk: the shared string envelope must not widen a step-owned result."""
    encoded = encode_step_result(_StrictResult(answer="accepted"))

    assert encoded == '{"answer":"accepted"}'
    assert decode_step_result(encoded, _StrictResult) == _StrictResult(answer="accepted")


@pytest.mark.parametrize(
    ("job_status", "attempts", "error_code", "expected"),
    [
        pytest.param("pending", 0, None, DurableExecutionPhase.Queued, id="fresh-pending"),
        pytest.param("running", 1, None, DurableExecutionPhase.Running, id="first-running"),
        pytest.param(
            "pending",
            0,
            "E_JOB_LEASE_EXPIRED",
            DurableExecutionPhase.Recovering,
            id="repaired-pending-fresh-budget",
        ),
        pytest.param(
            "running",
            1,
            "E_JOB_LEASE_EXPIRED",
            DurableExecutionPhase.Recovering,
            id="repaired-first-running",
        ),
        pytest.param("running", 2, None, DurableExecutionPhase.Recovering, id="reclaimed-running"),
        pytest.param(
            "failed",
            1,
            "E_TEST_CRASH",
            DurableExecutionPhase.Recovering,
            id="retry-wait",
        ),
        pytest.param(
            "dead",
            3,
            "E_TEST_CRASH",
            DurableExecutionPhase.Suspended,
            id="dead-letter",
        ),
    ],
)
def test_execution_phase_projects_live_queue_states(
    job_status: str,
    attempts: int,
    error_code: str | None,
    expected: DurableExecutionPhase,
) -> None:
    """Risk: Dossier and chat must not disagree about durable-work liveness."""
    assert (
        project_execution_phase(
            job_status=job_status,
            attempts=attempts,
            error_code=error_code,
        )
        is expected
    )


@pytest.mark.parametrize(
    ("job_status", "attempts"),
    [
        pytest.param("succeeded", 1, id="domain-must-classify-succeeded"),
        pytest.param("mystery", 1, id="unknown-status"),
        pytest.param("running", 0, id="unclaimed-running"),
    ],
)
def test_execution_phase_rejects_domain_invalid_queue_states(
    job_status: str,
    attempts: int,
) -> None:
    """Risk: projection drift must remain a defect, never silently become Queued."""
    with pytest.raises(AssertionError):
        project_execution_phase(job_status=job_status, attempts=attempts, error_code=None)


@pytest.mark.parametrize(
    ("dispatch_phase", "request_fingerprint", "terminal_result", "match"),
    [
        pytest.param(
            "Prepared",
            absent(),
            absent(),
            "request fingerprint must be present",
            id="prepared-missing-request-fingerprint",
        ),
        pytest.param(
            "Uncertain",
            absent(),
            absent(),
            "request fingerprint must be present",
            id="uncertain-missing-request-fingerprint",
        ),
        pytest.param(
            "Completed",
            absent(),
            present('{"answer":"accepted"}'),
            "request fingerprint must be present",
            id="completed-missing-request-fingerprint",
        ),
        pytest.param(
            "Prepared",
            present("a" * 64),
            present('{"answer":"too-early"}'),
            "Prepared durable step cannot have a terminal result",
            id="prepared-with-terminal-result",
        ),
        pytest.param(
            "Uncertain",
            present("a" * 64),
            present('{"answer":"too-early"}'),
            "Uncertain durable step cannot have a terminal result",
            id="uncertain-with-terminal-result",
        ),
        pytest.param(
            "Completed",
            present("a" * 64),
            absent(),
            "Completed durable step must have a terminal result",
            id="completed-without-terminal-result",
        ),
    ],
)
def test_step_replay_state_codec_rejects_phase_field_mismatches(
    dispatch_phase: str,
    request_fingerprint: object,
    terminal_result: object,
    match: str,
) -> None:
    """Risk: corrupt phase/field pairs must fail at the persisted journal boundary."""
    with pytest.raises(ValidationError, match=match):
        decode_step_states(
            {
                "coordination": {
                    "generation": {
                        "generation_id": str(_GENERATION_ID),
                        "dispatch_phase": dispatch_phase,
                        "request_fingerprint": request_fingerprint,
                        "terminal_result": terminal_result,
                    }
                }
            }
        )


def test_payload_codec_revalidates_copied_step_state_before_persisting() -> None:
    """Risk: Pydantic model copies must not bypass the persisted journal invariant."""
    prepared = StepReplayState(
        generation_id=_GENERATION_ID,
        dispatch_phase=Prepared,
        request_fingerprint=present("a" * 64),
        terminal_result=absent(),
    )
    invalid = prepared.model_copy(update={"terminal_result": present('{"answer":"too-early"}')})

    with pytest.raises(
        ValidationError,
        match="Prepared durable step cannot have a terminal result",
    ):
        payload_with_step_state(
            {"run_id": str(_OPERATION_ID)},
            step_path="turn/0/generation",
            state=invalid,
        )
