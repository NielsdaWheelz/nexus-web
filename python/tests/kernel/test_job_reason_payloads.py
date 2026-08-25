from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.jobs.queue import JobExecutionContext
from nexus.jobs.registry import resolve_job_handler


def _light_context() -> JobExecutionContext:
    return JobExecutionContext(
        job_id=uuid4(),
        worker_id="strict-job-text-proof",
        attempt_no=1,
        resource_class="Light",
    )


@pytest.mark.parametrize(
    ("kind", "payload"),
    (
        ("note_reindex_job", {"note_block_id": "invalid"}),
        ("note_reindex_job", {"note_block_id": "invalid", "reason": None}),
        ("note_reindex_job", {"note_block_id": "invalid", "reason": ""}),
        ("note_reindex_job", {"note_block_id": "invalid", "reason": " note_edit"}),
        ("note_reindex_job", {"note_block_id": "invalid", "reason": 7}),
        ("synapse_scan", {"user_id": "invalid", "ref": "media:invalid"}),
        ("synapse_scan", {"user_id": "invalid", "ref": "media:invalid", "reason": None}),
        ("synapse_scan", {"user_id": "invalid", "ref": "media:invalid", "reason": ""}),
        ("synapse_scan", {"user_id": "invalid", "ref": "media:invalid", "reason": " manual"}),
        ("synapse_scan", {"user_id": "invalid", "ref": "media:invalid", "reason": 7}),
    ),
)
def test_job_handlers_defect_on_noncanonical_reason_carriers(
    kind: str,
    payload: dict[str, object],
) -> None:
    handler = resolve_job_handler(f"nexus.jobs.registry:_run_{kind.removesuffix('_job')}")

    with pytest.raises(AssertionError, match=rf"{kind} payload requires canonical reason"):
        handler(
            payload=payload,
            context=_light_context(),
        )


@pytest.mark.parametrize("request_id", ("", " request", "request ", "   ", 7))
def test_job_handlers_defect_on_noncanonical_optional_text_carriers(
    request_id: object,
) -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_note_reindex")

    with pytest.raises(
        AssertionError,
        match="note_reindex_job payload requires canonical request_id",
    ):
        handler(
            payload={
                "note_block_id": "invalid",
                "reason": "note_edit",
                "request_id": request_id,
            },
            context=_light_context(),
        )


@pytest.mark.parametrize("optional_payload", ({}, {"request_id": None}))
def test_job_handlers_preserve_optional_text_absence(
    optional_payload: dict[str, object],
) -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_note_reindex")
    payload: dict[str, object] = {
        "note_block_id": "invalid",
        "reason": "note_edit",
        **optional_payload,
    }

    assert handler(payload=payload, context=_light_context()) == {
        "status": "failed",
        "error_code": "E_INVALID_REQUEST",
    }
