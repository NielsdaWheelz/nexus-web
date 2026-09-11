"""A worker commit cannot split run, queue, trust and cursor observations."""

from __future__ import annotations

import asyncio
from typing import Literal

import pytest
from sqlalchemy import Engine, event
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.jobs.queue import complete_job
from nexus.schemas.conversation import ChatRunResponse
from nexus.services import chat_run_response
from nexus.services.chat_run_finalize import finalize_cancelled
from nexus.services.conversation_branches import set_active_path
from tests.testkit.chat import create_entitled_chat
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime
from tests.testkit.queue_claims import claim_job_row

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


@pytest.mark.parametrize("projection", ("run", "active_path"))
def test_chat_hydration_is_one_snapshot_across_worker_terminal_commit(
    engine: Engine, projection: Literal["run", "active_path"]
) -> None:
    """Real queue/finalization owners interleave at the database read boundary.

    Under READ COMMITTED the retained queued run meets a succeeded queue row,
    causing the same projection defect that a pane boundary would conceal.
    """
    worker_id = "snapshot-proof"
    catalog = configured_chat_catalog_service()
    catalog_snapshot = asyncio.run(catalog.read_chat())
    with Session(engine) as setup:
        chat = asyncio.run(
            create_entitled_chat(
                setup,
                content="Keep the response coherent.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=compose_available_product_tool_runtime(),
            )
        )
        claimed = claim_job_row(
            setup,
            job_id=chat.job_id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=(),
            allowed_kinds=("chat_run",),
        )
        assert claimed is not None
        attempt_no = claimed.attempts
        run = setup.get(ChatRun, chat.run_id)
        assert run is not None
        assistant_message_id = run.assistant_message_id
        setup.commit()

    reader_connection: Connection | None = None
    committed = False

    def remember_reader(_session: Session, _transaction: object, connection: Connection) -> None:
        nonlocal reader_connection
        reader_connection = connection

    def finalize_between_reads(
        connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        nonlocal committed
        if (
            connection is not reader_connection
            or committed
            or "FROM background_jobs" not in statement
        ):
            return
        committed = True
        with Session(engine) as worker:
            run = worker.get(ChatRun, chat.run_id)
            assert run is not None
            finalize_cancelled(worker, run, commit=False)
            assert complete_job(
                worker,
                job_id=chat.job_id,
                worker_id=worker_id,
                attempt_no=attempt_no,
            )
            worker.commit()

    with Session(engine, expire_on_commit=False) as reader:

        def hydrate():
            if projection == "run":
                snapshot_reader = getattr(chat_run_response, "read_chat_run_response", None)
                assert callable(snapshot_reader), "chat hydration has no one-snapshot read owner"
                return snapshot_reader(
                    reader, chat.user_id, chat.run_id, catalog_snapshot=catalog_snapshot
                )
            return set_active_path(
                reader,
                viewer_id=chat.user_id,
                conversation_id=chat.conversation_id,
                active_leaf_message_id=assistant_message_id,
                catalog_snapshot=catalog_snapshot,
            )

        before = hydrate()
        retained_run = reader.get(ChatRun, chat.run_id)
        assert retained_run is not None and retained_run.status == "queued"
        reader.commit()
        event.listen(reader, "after_begin", remember_reader)
        event.listen(engine, "before_cursor_execute", finalize_between_reads)
        try:
            during = hydrate()
        finally:
            event.remove(engine, "before_cursor_execute", finalize_between_reads)
            event.remove(reader, "after_begin", remember_reader)
        assert committed, "the worker must commit between the run and execution reads"
        assert during.model_dump(mode="json") == before.model_dump(mode="json")
        assert not reader.in_transaction(), (
            "hydration must release its snapshot before response/SSE"
        )

        after = hydrate()
        if isinstance(after, ChatRunResponse):
            assert isinstance(before, ChatRunResponse)
            assert after.run.status == "cancelled"
            assert after.assistant_message.status == "cancelled"
            assert after.run.execution.model_dump(mode="json") == {"kind": "Absent"}
            assert after.stream_state.folded_event_seq > before.stream_state.folded_event_seq
        else:
            assert after.selected_path[-1].id == assistant_message_id
            assert after.selected_path[-1].status == "cancelled"
        assert not reader.in_transaction()
