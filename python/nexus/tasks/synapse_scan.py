"""Worker job handler for one synapse resonance scan."""

from __future__ import annotations

from uuid import UUID

import httpx
from provider_runtime import ModelRuntime
from sqlalchemy.orm import Session

from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.synapse import run_synapse_scan
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_SPEC = LlmTaskSpec(label="synapse_scan")


def synapse_scan(user_id: str, ref: str, reason: str) -> dict:
    user_uuid = UUID(user_id)
    parsed_ref = assert_resource_ref(ref)

    async def _handler(db: Session, router: ModelRuntime, _client: httpx.AsyncClient) -> dict:
        status = await run_synapse_scan(db, user_id=user_uuid, ref=parsed_ref, llm=router)
        # "trigger", not "reason": the worker failure protocol reads
        # result["reason"] as the error message for failed statuses.
        return {"status": status, "ref": ref, "trigger": reason}

    # No on_worker_exception: there is no head row to fail; the queue's retry
    # ladder owns unexpected exceptions, and prior edges stay intact (D6).
    return run_llm_task(_SPEC, _handler)
