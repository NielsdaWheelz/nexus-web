"""Priority proof: chat recovery state never exposes its private journal."""

from __future__ import annotations

import asyncio
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.jobs.queue import fail_job, update_running_job_payload
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_run_execution import chat_run_execution_phase
from nexus.services.chat_runs import get_chat_run
from nexus.services.durable_step_journal import DurableExecutionPhase
from tests.testkit.queue_claims import claim_job_row

_CUTOVER_PRESENT = find_spec("nexus.services.generation_selection") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.services.generation_catalog import GenerationCatalogSnapshot
    from tests.testkit.chat import EntitledChat, create_entitled_chat
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime


def test_suspended_chat_exposes_only_phase_and_masks_its_private_journal(
    request: pytest.FixtureRequest,
) -> None:
    assert _CUTOVER_PRESENT, "the final exact Chat generation selection is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    secret = "private prompt and provider output must never leave the journal"
    worker_id = "privacy-proof-worker"
    with Session(engine) as db:
        chat, catalog_snapshot = asyncio.run(_create_privacy_chat(db))
        for attempt in range(1, 4):
            claimed = claim_job_row(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                lease_seconds=300,
                heavy_kinds=(),
                allowed_kinds=("chat_run",),
            )
            assert claimed is not None and claimed.attempts == attempt
            if attempt == 1:
                payload = {
                    **claimed.payload,
                    "coordination": {
                        "generation/1": {
                            "request_fingerprint": "sensitive-fingerprint",
                            "terminal_result": secret,
                        }
                    },
                }
                assert update_running_job_payload(
                    db,
                    job_id=chat.job_id,
                    worker_id=worker_id,
                    attempt_no=attempt,
                    payload=payload,
                )
            transition = fail_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                error_code="E_PRIVACY_PROOF",
                error_message="synthetic private recovery material",
                retry_delays_seconds=(0,),
            )
            assert transition == ("dead" if attempt == 3 else "failed")
            db.commit()

        response = get_chat_run(
            db,
            viewer_id=chat.user_id,
            run_id=chat.run_id,
            catalog_snapshot=catalog_snapshot,
        )
        serialized = response.model_dump_json()
        phase = chat_run_execution_phase(db, run_id=chat.run_id)
        stranger = uuid4()
        ensure_user_and_default_library(db, stranger)
        with pytest.raises(NotFoundError):
            get_chat_run(
                db,
                viewer_id=stranger,
                run_id=chat.run_id,
                catalog_snapshot=catalog_snapshot,
            )

    assert phase is DurableExecutionPhase.Suspended
    assert response.run.execution.model_dump(mode="json") == {
        "kind": "Present",
        "value": {"phase": "Suspended"},
    }
    for forbidden in (secret, "coordination", "request_fingerprint", "terminal_result"):
        assert forbidden not in serialized, (
            f"chat execution response disclosed journal field {forbidden!r}"
        )


async def _create_privacy_chat(
    db: Session,
) -> tuple[EntitledChat, GenerationCatalogSnapshot]:
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    chat = await create_entitled_chat(
        db,
        content="Show only the public execution phase.",
        catalog_definition_revision=snapshot.catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        catalog=catalog,
        tool_runtime=compose_available_product_tool_runtime(),
    )
    return chat, snapshot
