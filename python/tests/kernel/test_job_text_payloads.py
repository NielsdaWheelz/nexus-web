from __future__ import annotations

from uuid import uuid4

import pytest
from pydantic import ValidationError as PydanticValidationError

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
    handler = resolve_job_handler("nexus.jobs.registry:_run_ingest_media_source")

    with pytest.raises(
        AssertionError,
        match="ingest_media_source payload requires canonical request_id",
    ):
        handler(
            payload={
                "media_id": "invalid",
                "attempt_id": "invalid",
                "actor_user_id": "invalid",
                "request_id": request_id,
            },
            context=_light_context(),
        )


@pytest.mark.parametrize("optional_payload", ({}, {"request_id": None}))
def test_job_handlers_preserve_optional_text_absence(
    optional_payload: dict[str, object],
) -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_ingest_media_source")
    payload: dict[str, object] = {
        "media_id": "invalid",
        "attempt_id": "invalid",
        "actor_user_id": "invalid",
        **optional_payload,
    }

    with pytest.raises(ValueError):
        handler(payload=payload, context=_light_context())


@pytest.mark.parametrize(
    ("handler_path", "kind", "payload", "missing_key"),
    (
        (
            "nexus.jobs.registry:_run_sync_gutenberg_catalog",
            "sync_gutenberg_catalog_job",
            {},
            "request_id",
        ),
        (
            "nexus.jobs.registry:_run_sync_gutenberg_catalog",
            "sync_gutenberg_catalog_job",
            {"request_id": "periodic:sync"},
            "scheduler_identity",
        ),
        (
            "nexus.jobs.registry:_run_prune_background_jobs",
            "prune_background_jobs_job",
            {},
            "request_id",
        ),
        (
            "nexus.jobs.registry:_run_purge_expired_auth_handoff_codes",
            "purge_expired_auth_handoff_codes",
            {},
            "request_id",
        ),
    ),
)
def test_scheduler_job_handlers_defect_on_missing_owned_text(
    handler_path: str,
    kind: str,
    payload: dict[str, object],
    missing_key: str,
) -> None:
    handler = resolve_job_handler(handler_path)

    with pytest.raises((AssertionError, PydanticValidationError)) as raised:
        handler(payload=payload, context=_light_context())

    assert isinstance(raised.value, AssertionError)
    assert str(raised.value) == f"{kind} payload requires canonical {missing_key}"


@pytest.mark.parametrize(
    "reading_id",
    (
        None,
        "",
        " reading",
        "not-a-uuid",
        "00000000-0000-0000-0000-0000000000AA",
        "{00000000-0000-0000-0000-0000000000aa}",
        uuid4(),
        7,
    ),
)
def test_oracle_job_handler_defects_on_noncanonical_reading_id(reading_id: object) -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_oracle_reading_generate")

    with pytest.raises(
        AssertionError,
        match="oracle_reading_generate payload requires canonical reading_id",
    ):
        handler(
            payload={"reading_id": reading_id},
            context=_light_context(),
        )


def test_oracle_job_handler_defects_on_unowned_payload_fields() -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_oracle_reading_generate")

    with pytest.raises(
        AssertionError,
        match="oracle_reading_generate payload keys must be exactly reading_id",
    ):
        handler(
            payload={"reading_id": str(uuid4()), "extra_id": str(uuid4())},
            context=_light_context(),
        )


def test_note_reindex_handler_defects_on_unowned_payload_fields() -> None:
    handler = resolve_job_handler("nexus.jobs.registry:_run_note_reindex")

    with pytest.raises(
        AssertionError,
        match="note_reindex_job payload keys must be exactly note_block_id and reason",
    ):
        handler(
            payload={
                "note_block_id": "invalid",
                "reason": "note_edit",
                "request_id": "unowned-request",
            },
            context=_light_context(),
        )
