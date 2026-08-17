"""Priority proof: every mutating LLM tool is owner-gated and reversible."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid4

import pytest
from llm_tools import EffectId, ToolEffect, ToolId
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    ConsumptionQueueItem,
    Highlight,
    LibraryEntry,
    MessageToolCall,
    NoteBlock,
    ResourceEdge,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.notes import CreatePageRequest
from nexus.services import bootstrap, library_governance, notes
from nexus.services.agent_tools.writes import undo_tool_call
from nexus.services.durable_step_journal import Completed, read_step_states, stable_generation_id
from nexus.services.message_trust_trails import build_assistant_trust_trail
from tests.testkit.chat import create_entitled_chat
from tests.testkit.llm_tool_scenarios import (
    claim_chat_tool_job,
    compose_keyless_tool_runtime,
    create_readable_media,
    execute_chat_tool,
)

_WRITE_TOOL_IDS = (
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)


def _effect_id(run_id: UUID, tool_call_index: int) -> EffectId:
    path = f"turn/0/tool/{tool_call_index}"
    return EffectId(str(stable_generation_id(run_id, path)))


def _execute_write(
    db: Session,
    *,
    operation: Any,
    run: ChatRun,
    job_context: Any,
    tool_id: str,
    tool_call_index: int,
    arguments: dict[str, object],
    admitted_resource_uris: tuple[str, ...],
) -> Any:
    return execute_chat_tool(
        db,
        operation=operation,
        run=run,
        job_context=job_context,
        tool_id=tool_id,
        tool_call_index=tool_call_index,
        arguments=arguments,
        admitted_resource_uris=admitted_resource_uris,
        effect_id=_effect_id(run.id, tool_call_index),
    )


def _failure(error_type: str) -> dict[str, object]:
    return {"type": "Failure", "error": {"type": error_type}}


def _owned_effect_counts(
    db: Session,
    *,
    owner_id: UUID,
    target_library_id: UUID,
    quote_media_id: UUID,
) -> tuple[int, int, int, int, int]:
    return (
        int(
            db.scalar(
                select(func.count())
                .select_from(LibraryEntry)
                .where(
                    LibraryEntry.library_id == target_library_id,
                    LibraryEntry.media_id == quote_media_id,
                )
            )
            or 0
        ),
        int(
            db.scalar(
                select(func.count()).select_from(NoteBlock).where(NoteBlock.user_id == owner_id)
            )
            or 0
        ),
        int(
            db.scalar(
                select(func.count()).select_from(Highlight).where(Highlight.user_id == owner_id)
            )
            or 0
        ),
        int(
            db.scalar(
                select(func.count())
                .select_from(ResourceEdge)
                .where(ResourceEdge.user_id == owner_id, ResourceEdge.origin == "assistant")
            )
            or 0
        ),
        int(
            db.scalar(
                select(func.count())
                .select_from(ConsumptionQueueItem)
                .where(ConsumptionQueueItem.user_id == owner_id)
            )
            or 0
        ),
    )


def _tool_rows(db: Session, assistant_message_id: UUID) -> list[MessageToolCall]:
    return list(
        db.scalars(
            select(MessageToolCall)
            .where(MessageToolCall.assistant_message_id == assistant_message_id)
            .order_by(MessageToolCall.tool_call_index)
        )
    )


def _active_write_count(rows: Sequence[MessageToolCall]) -> int:
    return sum(
        row.record_kind == "current_execution"
        and row.canonical_tool_id in _WRITE_TOOL_IDS
        and row.status == "complete"
        and row.reverted_at is None
        for row in rows
    )


def test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        owner_default = bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"write-tool-owner-{owner_id}@example.invalid",
        )
        foreign_default = bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"write-tool-foreign-{foreign_id}@example.invalid",
        )
        chat = create_entitled_chat(
            db,
            content="Apply only the five requested additive changes.",
            user_id=owner_id,
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None

        target_library_id = uuid4()
        library_governance.create_library(
            db,
            owner_id,
            CreateLibraryRequest(library_id=target_library_id, name="Filed by assistant"),
        )
        foreign_library_id = uuid4()
        library_governance.create_library(
            db,
            foreign_id,
            CreateLibraryRequest(library_id=foreign_library_id, name="Foreign library"),
        )
        for name in ("Ambiguous filing", "ambiguous filing"):
            library_governance.create_library(
                db,
                owner_id,
                CreateLibraryRequest(library_id=uuid4(), name=name),
            )

        owner_page_id = uuid4()
        notes.create_page(
            db,
            owner_id,
            CreatePageRequest(page_id=owner_page_id, title="Owned page"),
        )
        foreign_page_id = uuid4()
        notes.create_page(
            db,
            foreign_id,
            CreatePageRequest(page_id=foreign_page_id, title="Foreign page"),
        )
        quote_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned quote source",
            canonical_text=(
                "Alpha. The unique passage belongs here. Omega. "
                "Repeated phrase. Middle. Repeated phrase."
            ),
        )
        edge_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned edge target",
            canonical_text="A second owned document.",
        )
        queue_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned queue target",
            canonical_text="An owned item to read later.",
        )
        foreign_media_id = create_readable_media(
            db,
            user_id=foreign_id,
            default_library_id=foreign_default,
            title="Foreign resource",
            canonical_text="This content belongs to another account.",
        )
        db.commit()

        quote_uri = f"media:{quote_media_id}"
        edge_uri = f"media:{edge_media_id}"
        queue_uri = f"media:{queue_media_id}"
        foreign_media_uri = f"media:{foreign_media_id}"
        owner_page_uri = f"page:{owner_page_id}"
        foreign_page_uri = f"page:{foreign_page_id}"
        admitted = (
            quote_uri,
            edge_uri,
            queue_uri,
            foreign_media_uri,
            owner_page_uri,
            foreign_page_uri,
            f"library:{target_library_id}",
            f"library:{foreign_library_id}",
        )

        runtime = compose_keyless_tool_runtime()
        operation = runtime.operations["chat"]
        job_context = claim_chat_tool_job(
            db,
            job_id=chat.job_id,
            worker_id=f"write-tools-{uuid4()}",
        )
        successful_cases = (
            (
                "nexus.library.add",
                {
                    "resource_uri": quote_uri,
                    "library_id": str(target_library_id),
                    "library_name": None,
                },
            ),
            (
                "nexus.note.create",
                {"markdown": "Remember this connection.", "page_uri": owner_page_uri},
            ),
            (
                "nexus.highlight.create",
                {
                    "media_uri": quote_uri,
                    "exact": "The unique passage belongs here.",
                    "prefix": None,
                    "suffix": None,
                    "color": "yellow",
                    "note": None,
                },
            ),
            (
                "nexus.edge.create",
                {
                    "source_uri": quote_uri,
                    "target_uri": edge_uri,
                    "kind": "context",
                    "rationale": "The reader asked to connect them.",
                },
            ),
            ("nexus.queue.add", {"media_uri": queue_uri}),
        )
        successes = tuple(
            _execute_write(
                db,
                operation=operation,
                run=run,
                job_context=job_context,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
                admitted_resource_uris=admitted,
            )
            for index, (tool_id, arguments) in enumerate(successful_cases, start=1)
        )

        assert all(result["type"] == "Success" for result in successes)
        assert successes[0]["value"] == {
            "already_present": False,
            "library_name": "Filed by assistant",
            "library_uri": f"library:{target_library_id}",
            "resource_uri": quote_uri,
        }
        assert successes[1]["value"]["page_uri"] == owner_page_uri
        assert successes[1]["value"]["note_uri"].startswith("note_block:")
        assert successes[2]["value"]["exact"] == "The unique passage belongs here."
        assert successes[2]["value"]["highlight_uri"].startswith("highlight:")
        assert successes[3]["value"] == {
            "edge_id": successes[3]["value"]["edge_id"],
            "kind": "context",
            "rationale": "The reader asked to connect them.",
            "source_uri": quote_uri,
            "target_uri": edge_uri,
        }
        assert successes[4]["value"]["media_uri"] == queue_uri
        assert successes[4]["value"]["already_present"] is False
        assert _owned_effect_counts(
            db,
            owner_id=owner_id,
            target_library_id=target_library_id,
            quote_media_id=quote_media_id,
        ) == (1, 1, 1, 1, 1)

        first_rows = _tool_rows(db, run.assistant_message_id)
        first_events = list(
            db.scalars(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == run.id,
                    ChatRunEvent.event_type == "tool_result",
                )
            )
        )
        assert len(first_rows) == len(first_events) == 5
        assert tuple(row.canonical_tool_id for row in first_rows) == _WRITE_TOOL_IDS
        assert {row.record_kind for row in first_rows} == {"current_execution"}
        assert all(row.status == "complete" and row.error_code is None for row in first_rows)
        for row in first_rows:
            assert row.canonical_tool_id is not None
            binding = operation.plan.catalog_view.binding(ToolId(row.canonical_tool_id))
            assert row.tool_contract_revision == binding.spec.tool_contract_revision
            assert row.binding_policy_revision == binding.policy_revision
        assert all(event.payload["record_kind"] == "current_execution" for event in first_events)
        assert all(event.payload["effect"] == ToolEffect.Write for event in first_events)

        from nexus.jobs.queue import get_job

        claimed_job = get_job(db, job_context.job_id)
        assert claimed_job is not None
        states = read_step_states(claimed_job)
        for index in range(1, 6):
            path = f"turn/0/tool/{index}"
            assert states[path].dispatch_phase is Completed
            assert states[path].generation_id == stable_generation_id(run.id, path)
            assert str(states[path].generation_id) == str(_effect_id(run.id, index))

        # Re-entering one completed position returns the exact terminal result;
        # no domain owner, trust row, event, or journal position runs twice.
        replayed_note = _execute_write(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
            tool_id="nexus.note.create",
            tool_call_index=2,
            arguments=successful_cases[1][1],
            admitted_resource_uris=admitted,
        )
        assert replayed_note == successes[1]
        assert len(_tool_rows(db, run.assistant_message_id)) == 5
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatRunEvent)
                .where(ChatRunEvent.run_id == run.id, ChatRunEvent.event_type == "tool_result")
            )
            == 5
        )
        assert _owned_effect_counts(
            db,
            owner_id=owner_id,
            target_library_id=target_library_id,
            quote_media_id=quote_media_id,
        ) == (1, 1, 1, 1, 1)

        foreign_cases = (
            (
                "nexus.library.add",
                {
                    "resource_uri": quote_uri,
                    "library_id": str(foreign_library_id),
                    "library_name": None,
                },
            ),
            (
                "nexus.note.create",
                {"markdown": "Do not write this.", "page_uri": foreign_page_uri},
            ),
            (
                "nexus.highlight.create",
                {
                    "media_uri": foreign_media_uri,
                    "exact": "This content belongs to another account.",
                    "prefix": None,
                    "suffix": None,
                    "color": None,
                    "note": None,
                },
            ),
            (
                "nexus.edge.create",
                {
                    "source_uri": quote_uri,
                    "target_uri": foreign_media_uri,
                    "kind": "context",
                    "rationale": "This must remain private.",
                },
            ),
            ("nexus.queue.add", {"media_uri": foreign_media_uri}),
        )
        denied = tuple(
            _execute_write(
                db,
                operation=operation,
                run=run,
                job_context=job_context,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
                admitted_resource_uris=admitted,
            )
            for index, (tool_id, arguments) in enumerate(foreign_cases, start=6)
        )
        assert denied == (_failure("ResourceUnavailable"),) * len(foreign_cases)
        assert _owned_effect_counts(
            db,
            owner_id=owner_id,
            target_library_id=target_library_id,
            quote_media_id=quote_media_id,
        ) == (1, 1, 1, 1, 1)

        refusal_cases = (
            (
                "nexus.library.add",
                {"resource_uri": quote_uri, "library_id": None, "library_name": None},
                "InvalidInput",
            ),
            (
                "nexus.library.add",
                {
                    "resource_uri": quote_uri,
                    "library_id": None,
                    "library_name": "No such library",
                },
                "ResourceUnavailable",
            ),
            (
                "nexus.library.add",
                {
                    "resource_uri": quote_uri,
                    "library_id": None,
                    "library_name": "AMBIGUOUS FILING",
                },
                "TargetAmbiguous",
            ),
            (
                "nexus.highlight.create",
                {
                    "media_uri": quote_uri,
                    "exact": "",
                    "prefix": None,
                    "suffix": None,
                    "color": None,
                    "note": None,
                },
                "InvalidInput",
            ),
            (
                "nexus.highlight.create",
                {
                    "media_uri": quote_uri,
                    "exact": "A passage absent from the source.",
                    "prefix": None,
                    "suffix": None,
                    "color": None,
                    "note": None,
                },
                "QuoteNotFound",
            ),
            (
                "nexus.highlight.create",
                {
                    "media_uri": quote_uri,
                    "exact": "Repeated phrase.",
                    "prefix": None,
                    "suffix": None,
                    "color": None,
                    "note": None,
                },
                "QuoteAmbiguous",
            ),
            (
                "nexus.edge.create",
                successful_cases[3][1],
                "Conflict",
            ),
        )
        refusals = tuple(
            _execute_write(
                db,
                operation=operation,
                run=run,
                job_context=job_context,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
                admitted_resource_uris=admitted,
            )
            for index, (tool_id, arguments, _error_type) in enumerate(
                refusal_cases,
                start=11,
            )
        )
        assert refusals == tuple(_failure(error_type) for _, _, error_type in refusal_cases)

        fill_arguments = {
            "resource_uri": quote_uri,
            "library_id": str(target_library_id),
            "library_name": None,
        }
        fill_results = tuple(
            _execute_write(
                db,
                operation=operation,
                run=run,
                job_context=job_context,
                tool_id="nexus.library.add",
                tool_call_index=index,
                arguments=fill_arguments,
                admitted_resource_uris=admitted,
            )
            for index in range(18, 21)
        )
        assert all(result["type"] == "Success" for result in fill_results)
        assert all(result["value"]["already_present"] is True for result in fill_results)
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        capped = _execute_write(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
            tool_id="nexus.library.add",
            tool_call_index=21,
            arguments=fill_arguments,
            admitted_resource_uris=admitted,
        )
        assert capped == _failure("WriteCapReached")
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        trust = build_assistant_trust_trail(
            db,
            viewer_id=owner_id,
            assistant_message_id=run.assistant_message_id,
        )
        assert tuple(tool.canonical_tool_id for tool in trust.tool_calls[:5]) == _WRITE_TOOL_IDS
        assert all(tool.record_kind == "current_execution" for tool in trust.tool_calls)
        assert all(tool.provider_wire_name is None for tool in trust.tool_calls)
        assert all(tool.result_kind == "mutation" for tool in trust.tool_calls)
        assert all(tool.effect == ToolEffect.Write for tool in trust.tool_calls)

        first_success_rows = _tool_rows(db, run.assistant_message_id)[:5]
        for row in first_success_rows:
            with pytest.raises(ApiError) as denied_undo:
                undo_tool_call(
                    db,
                    viewer_id=foreign_id,
                    conversation_id=run.conversation_id,
                    tool_call_id=row.id,
                )
            assert denied_undo.value.code == ApiErrorCode.E_NOT_FOUND

        first_undo = undo_tool_call(
            db,
            viewer_id=owner_id,
            conversation_id=run.conversation_id,
            tool_call_id=first_success_rows[0].id,
        )
        repeated_undo = undo_tool_call(
            db,
            viewer_id=owner_id,
            conversation_id=run.conversation_id,
            tool_call_id=first_success_rows[0].id,
        )
        assert first_undo == repeated_undo == run.assistant_message_id
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 7

        reclaimed = _execute_write(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
            tool_id="nexus.library.add",
            tool_call_index=22,
            arguments=fill_arguments,
            admitted_resource_uris=admitted,
        )
        assert reclaimed["type"] == "Success"
        assert reclaimed["value"]["already_present"] is False
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        rows_by_index = {
            row.tool_call_index: row for row in _tool_rows(db, run.assistant_message_id)
        }
        for row in (*first_success_rows[1:], rows_by_index[22]):
            first = undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=run.conversation_id,
                tool_call_id=row.id,
            )
            second = undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=run.conversation_id,
                tool_call_id=row.id,
            )
            assert first == second == run.assistant_message_id

        assert _owned_effect_counts(
            db,
            owner_id=owner_id,
            target_library_id=target_library_id,
            quote_media_id=quote_media_id,
        ) == (0, 0, 0, 0, 0)
        final_trust = build_assistant_trust_trail(
            db,
            viewer_id=owner_id,
            assistant_message_id=run.assistant_message_id,
        )
        reverted = {
            tool.tool_call_index for tool in final_trust.tool_calls if tool.reverted_at is not None
        }
        assert {1, 2, 3, 4, 5, 22} <= reverted

        final_rows = _tool_rows(db, run.assistant_message_id)
        final_events = list(
            db.scalars(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == run.id,
                    ChatRunEvent.event_type == "tool_result",
                )
            )
        )
        assert len(final_rows) == len(final_events) == 22
        assert {row.record_kind for row in final_rows} == {"current_execution"}
        assert all("tool_name" not in event.payload for event in final_events)
