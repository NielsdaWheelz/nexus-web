"""Background-lane process-boundary composition proof."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.session import create_session_factory
from nexus.jobs.process_executor import BackgroundProcessExecutor, ChildSucceeded
from nexus.jobs.queue import JobExecutionContext, enqueue_job, get_job
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker
from tests.testkit.unreachable_state import delete_jobs_by_ids

_KIND = "background_light_process_boundary_probe"
_HANDLER_PATH = "tests.service.test_background_worker_process_dispatch:_supervisor_process_probe"


def _supervisor_process_probe(
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> dict[str, str]:
    """Expose legacy in-supervisor execution as a persisted observable result."""
    del payload, context
    return {"execution": "supervisor"}


class _RecordingProcessExecutor:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def execute(self, **kwargs: Any) -> ChildSucceeded:
        self.calls.append(kwargs)
        return ChildSucceeded(payload={"execution": "child"})


def test_background_supervisor_dispatches_light_base_handler_to_fresh_child(
    engine: Engine,
) -> None:
    """Risk: inline Light imports consume memory reserved for later Heavy children."""
    executor = _RecordingProcessExecutor()
    with Session(engine) as db:
        job = enqueue_job(db, kind=_KIND, payload={"probe": "light-base"})
        db.commit()

    try:
        worker = JobWorker(
            session_factory=create_session_factory(engine),
            worker_id="background-light-process-boundary-proof",
            registry={
                _KIND: JobDefinition(
                    kind=_KIND,
                    handler_path=_HANDLER_PATH,
                    resource_class="Light",
                )
            },
            allowed_kinds=(_KIND,),
            process_executor=cast("BackgroundProcessExecutor", executor),
        )

        assert worker.run_once() is True
        assert len(executor.calls) == 1, (
            "the background worker executed a Light Base handler inside its supervisor"
        )
        assert executor.calls[0]["handler_path"] == _HANDLER_PATH
        assert executor.calls[0]["runtime"] == "Base"
        with Session(engine) as oracle:
            persisted = get_job(oracle, job.id)
            assert persisted is not None
            assert (persisted.status, persisted.result) == (
                "succeeded",
                {"execution": "child"},
            )
    finally:
        with Session(engine) as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=(job.id,))
            cleanup.commit()
