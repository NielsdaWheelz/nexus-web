"""Fragile pure contracts for the shared durable step journal."""

from __future__ import annotations

from uuid import UUID

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from nexus.schemas.presence import absent, present
from nexus.services.durable_step_journal import (
    Completed,
    DurableExecutionPhase,
    StepReplayState,
    decode_step_result,
    decode_step_states,
    encode_step_result,
    payload_with_step_state,
    project_execution_phase,
    stable_generation_id,
)

_OPERATION_ID = UUID("11111111-1111-4111-8111-111111111111")
_GENERATION_ID = UUID("22222222-2222-4222-8222-222222222222")


class _Result(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    answer: str


def test_step_identity_codec_and_phase_evidence_fail_closed() -> None:
    """Persisted replay identity and evidence must remain strict across every owner."""
    assert stable_generation_id(_OPERATION_ID, "research/web-search/2") == UUID(
        "5dfab0cd-d4f5-5127-9cf3-b2800f52d1a3"
    )
    encoded_result = encode_step_result(_Result(answer="accepted"))
    state = StepReplayState(
        generation_id=_GENERATION_ID,
        dispatch_phase=Completed,
        request_fingerprint=present("a" * 64),
        terminal_result=present(encoded_result),
    )
    original: dict[str, object] = {"run_id": str(_OPERATION_ID)}
    payload = payload_with_step_state(original, step_path="generation", state=state)

    assert original == {"run_id": str(_OPERATION_ID)}
    assert payload == {
        "run_id": str(_OPERATION_ID),
        "coordination": {
            "generation": {
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
    assert decode_step_states(payload) == {"generation": state}
    assert decode_step_result(encoded_result, _Result) == _Result(answer="accepted")

    invalid_states = (
        {
            "dispatch_phase": "Prepared",
            "request_fingerprint": absent(),
            "terminal_result": absent(),
        },
        {
            "dispatch_phase": "Prepared",
            "request_fingerprint": present("a" * 64),
            "terminal_result": present(encoded_result),
        },
        {
            "dispatch_phase": "Completed",
            "request_fingerprint": present("a" * 64),
            "terminal_result": absent(),
        },
    )
    for invalid in invalid_states:
        with pytest.raises(ValidationError):
            decode_step_states(
                {
                    "coordination": {
                        "generation": {
                            "generation_id": str(_GENERATION_ID),
                            **invalid,
                        }
                    }
                }
            )
    with pytest.raises(AssertionError, match="malformed _Result result"):
        decode_step_result('{"answer":"accepted","unexpected":true}', _Result)


@pytest.mark.parametrize(
    ("status", "attempts", "error_code", "expected"),
    (
        ("pending", 0, None, DurableExecutionPhase.Queued),
        ("running", 1, None, DurableExecutionPhase.Running),
        ("pending", 0, "E_JOB_LEASE_EXPIRED", DurableExecutionPhase.Recovering),
        ("running", 2, None, DurableExecutionPhase.Recovering),
        ("failed", 1, "E_PROVIDER", DurableExecutionPhase.Recovering),
        ("dead", 3, "E_PROVIDER", DurableExecutionPhase.Suspended),
    ),
)
def test_execution_phase_is_a_closed_projection_of_queue_truth(
    status: str,
    attempts: int,
    error_code: str | None,
    expected: DurableExecutionPhase,
) -> None:
    assert (
        project_execution_phase(
            job_status=status,
            attempts=attempts,
            error_code=error_code,
        )
        is expected
    )

    if status == "running" and attempts == 1 and error_code is None:
        with pytest.raises(AssertionError):
            project_execution_phase(
                job_status="succeeded",
                attempts=attempts,
                error_code=error_code,
            )
        with pytest.raises(AssertionError):
            project_execution_phase(
                job_status="running",
                attempts=0,
                error_code=error_code,
            )
