"""Focused proof for the shared batched chat execution projection."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from nexus.db.models import ChatRun
from nexus.schemas.conversation import ChatRunOut, TrustRunOut
from nexus.schemas.execution import DurableExecutionOut
from nexus.schemas.presence import Present
from nexus.services.chat_run_execution import project_chat_run_executions
from nexus.services.durable_step_journal import DurableExecutionPhase


class _Result:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def mappings(self) -> list[dict[str, object]]:
        return self._rows


class _Session:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows
        self.calls: list[dict[str, object]] = []

    def execute(self, _statement: object, params: dict[str, object]) -> _Result:
        self.calls.append(params)
        return _Result(self.rows)


def _run(status: str, run_id: UUID | None = None) -> ChatRun:
    return cast(ChatRun, SimpleNamespace(id=run_id or uuid4(), status=status))


def _job(
    run: ChatRun,
    *,
    status: str,
    attempts: int,
    error_code: str | None = None,
    kind: str = "chat_run",
) -> dict[str, object]:
    return {
        "kind": kind,
        "dedupe_key": f"chat_run:{run.id}",
        "status": status,
        "attempts": attempts,
        "error_code": error_code,
    }


def test_projects_all_live_phases_in_one_query_and_omits_terminal_execution() -> None:
    queued = _run("queued")
    running = _run("running")
    repaired_pending = _run("running")
    repaired_running = _run("running")
    recovering = _run("running")
    retry_wait = _run("running")
    suspended = _run("running")
    terminal = _run("complete")
    db = _Session(
        [
            _job(queued, status="pending", attempts=0),
            _job(running, status="running", attempts=1),
            _job(
                repaired_pending,
                status="pending",
                attempts=0,
                error_code="E_TEST_CRASH",
            ),
            _job(
                repaired_running,
                status="running",
                attempts=1,
                error_code="E_TEST_CRASH",
            ),
            _job(recovering, status="running", attempts=2),
            _job(retry_wait, status="failed", attempts=1, error_code="E_TEST_CRASH"),
            _job(suspended, status="dead", attempts=3, error_code="E_TEST_CRASH"),
        ]
    )

    projected = project_chat_run_executions(
        cast(Any, db),
        [
            queued,
            running,
            repaired_pending,
            repaired_running,
            recovering,
            retry_wait,
            suspended,
            terminal,
        ],
    )

    assert len(db.calls) == 1
    for run, phase in (
        (queued, DurableExecutionPhase.Queued),
        (running, DurableExecutionPhase.Running),
        (repaired_pending, DurableExecutionPhase.Recovering),
        (repaired_running, DurableExecutionPhase.Recovering),
        (recovering, DurableExecutionPhase.Recovering),
        (retry_wait, DurableExecutionPhase.Recovering),
        (suspended, DurableExecutionPhase.Suspended),
    ):
        execution = projected[run.id]
        assert isinstance(execution, Present)
        assert execution.value.phase is phase
    assert projected[terminal.id].kind == "Absent"


@pytest.mark.parametrize(
    ("rows", "match"),
    [
        pytest.param([], "no queue job", id="missing-job"),
        pytest.param(
            [{"kind": "oracle", "status": "pending", "attempts": 0, "error_code": None}],
            "has kind",
            id="wrong-kind",
        ),
        pytest.param(
            [
                {
                    "kind": "chat_run",
                    "status": "succeeded",
                    "attempts": 1,
                    "error_code": None,
                }
            ],
            "succeeded durable job",
            id="succeeded-nonterminal",
        ),
    ],
)
def test_nonterminal_queue_correlation_defects(rows: list[dict[str, object]], match: str) -> None:
    run = _run("running")
    completed_rows = [{**row, "dedupe_key": f"chat_run:{run.id}"} for row in rows]
    with pytest.raises(AssertionError, match=match):
        project_chat_run_executions(cast(Any, _Session(completed_rows)), [run])


def test_duplicate_queue_rows_and_duplicate_projection_inputs_defect() -> None:
    run = _run("running")
    row = _job(run, status="running", attempts=1)
    with pytest.raises(AssertionError, match="Duplicate chat run queue job"):
        project_chat_run_executions(cast(Any, _Session([row, row])), [run])
    with pytest.raises(AssertionError, match="Duplicate chat run projection input"):
        project_chat_run_executions(cast(Any, _Session([row])), [run, run])


def test_execution_wire_schema_rejects_unknown_phase_and_extra_fields() -> None:
    with pytest.raises(ValidationError):
        DurableExecutionOut.model_validate({"phase": "Paused"})
    with pytest.raises(ValidationError):
        DurableExecutionOut.model_validate({"phase": "Running", "retry": True})


def test_chat_and_trust_run_schemas_require_the_same_strict_execution_shape() -> None:
    for schema in (ChatRunOut, TrustRunOut):
        json_schema = schema.model_json_schema()
        assert "execution" in json_schema["required"]
        assert json_schema["additionalProperties"] is False
        execution_schema = json_schema["properties"]["execution"]
        execution_schema = json_schema["$defs"][execution_schema["$ref"].split("/")[-1]]
        assert execution_schema["discriminator"]["propertyName"] == "kind"
