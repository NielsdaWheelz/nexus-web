"""Priority proof: every mutating LLM tool is owner-gated and reversible."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from importlib.util import find_spec
from threading import Event
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4

import pytest
from llm_tools import DeclaredToolFailure, ToolEffect, ToolId
from sqlalchemy import Engine, event, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatPromptAssembly,
    ChatRun,
    ChatRunEvent,
    ConsumptionQueueItem,
    Highlight,
    LibraryEntry,
    Media,
    MediaKind,
    Membership,
    MessageToolCall,
    NoteBlock,
    Podcast,
    PodcastEpisode,
    PodcastSubscription,
    ProcessingStatus,
    ResourceEdge,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.notes import CreatePageRequest
from nexus.services import bootstrap, conversations, library_entries, library_governance, notes
from nexus.services.agent_tools.writes import add_to_queue, undo_tool_call
from nexus.services.billing_entitlements import revoke_entitlement_override
from nexus.services.consumption import service as consumption_service
from nexus.services.message_trust_trails import build_assistant_trust_trail
from nexus.services.resource_graph.context import add_context_ref_without_commit
from nexus.services.resource_graph.refs import ResourceRef

# BASE overlays this proof without the exact-generation production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_service") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.services.generation_intent import GenerationIntent
    from nexus.services.generation_service import ChatToolAuthority
    from nexus.services.generation_spec import decode_generation_spec_document
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import (
        ChatToolGeneration,
        claim_running_chat_tool_job,
        compose_available_product_tool_runtime,
        compose_chat_tool_generation,
        create_readable_media,
        create_scoped_entitled_chat,
        execute_chat_tool,
    )

_WRITE_TOOL_IDS = (
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)

_WRITE_PROMPT_TOOL_NAMES = (
    "nexus__library__add",
    "nexus__note__create",
    "nexus__highlight__create",
    "nexus__edge__create",
    "nexus__queue__add",
)


def _execute_write(
    db: Session,
    *,
    generation: ChatToolGeneration,
    tool_id: str,
    tool_call_index: int,
    arguments: dict[str, object],
) -> Any:
    return execute_chat_tool(
        db,
        generation=generation,
        tool_id=tool_id,
        tool_call_index=tool_call_index,
        arguments=arguments,
    )


def _failure(error_type: str) -> dict[str, object]:
    return {"type": "Failure", "error": {"type": error_type}}


def _assert_rare_owner_refusals_are_closed() -> None:
    # These owner outcomes require a transaction race or the 2,000-row Lectern
    # ceiling. The public scenarios below cover the common mappings; this small
    # pure table proves the remaining closed adapter cases without a huge fixture.
    from nexus.services.tool_runtime.execution import _write_refusal

    for tool_id, code in (
        ("nexus.library.add", ApiErrorCode.E_MEDIA_DELETING),
        ("nexus.queue.add", ApiErrorCode.E_MEDIA_DELETING),
        ("nexus.queue.add", ApiErrorCode.E_LIMIT),
    ):
        with pytest.raises(DeclaredToolFailure) as raised:
            _write_refusal(ApiError(code, "owner refused the write"), tool_id=tool_id)
        assert raised.value.error.model_dump(mode="json") == {"type": "ResourceUnavailable"}


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
            .where(
                MessageToolCall.assistant_message_id == assistant_message_id,
                MessageToolCall.record_kind == "current_execution",
            )
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


def _assert_persisted_prompt_matches_frozen_authority(
    db: Session,
    *,
    run: ChatRun,
    expected_authority: ChatToolAuthority,
) -> None:
    spec = decode_generation_spec_document(run.generation_spec)
    assert spec.tool_effect_mode.kind == "Present", (
        f"Chat run {run.id} omitted its frozen tool authority"
    )
    assert spec.tool_effect_mode.value == expected_authority, (
        f"Chat run {run.id} froze {spec.tool_effect_mode.value!r}, expected {expected_authority!r}"
    )
    prompt = db.scalar(select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id))
    assert prompt is not None, f"Chat run {run.id} omitted its admission-time prompt"
    instructions = GenerationIntent.model_validate(prompt.generation_intent).instructions
    observed = tuple(name for name in _WRITE_PROMPT_TOOL_NAMES if name in instructions)
    expected = _WRITE_PROMPT_TOOL_NAMES if expected_authority == "AdditiveWrites" else ()
    assert observed == expected, (
        f"Chat run {run.id} prompt write tools {observed!r} do not match its "
        f"frozen {expected_authority!r} authority"
    )


def test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo(
    request: pytest.FixtureRequest,
) -> None:
    assert _CUTOVER_PRESENT, "the final generation tool authority is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    _assert_rare_owner_refusals_are_closed()
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
        conversation = conversations.create_conversation(db, owner_id)

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
        for target in (
            ResourceRef(scheme="media", id=quote_media_id),
            ResourceRef(scheme="media", id=edge_media_id),
            ResourceRef(scheme="media", id=queue_media_id),
            ResourceRef(scheme="page", id=owner_page_id),
        ):
            add_context_ref_without_commit(
                db,
                viewer_id=owner_id,
                conversation_id=conversation.id,
                target=target,
                origin="user",
            )
        db.add_all(
            [
                ResourceEdge(
                    user_id=owner_id,
                    source_scheme="conversation",
                    source_id=conversation.id,
                    target_scheme=scheme,
                    target_id=target_id,
                    kind="context",
                    origin="system",
                    source_order_key=f"tool-safety-private-{ordinal}",
                )
                for ordinal, (scheme, target_id) in enumerate(
                    (("media", foreign_media_id), ("page", foreign_page_id)),
                    start=1,
                )
            ]
        )
        db.commit()

        catalog = configured_chat_catalog_service()
        catalog_snapshot = asyncio.run(catalog.read_chat())
        runtime = compose_available_product_tool_runtime()
        chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=conversation.id,
                content="Apply only the five requested additive changes.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="AdditiveWrites",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        _assert_persisted_prompt_matches_frozen_authority(
            db,
            run=run,
            expected_authority="AdditiveWrites",
        )

        read_only_conversation = conversations.create_conversation(db, owner_id)
        db.commit()
        read_only_chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=read_only_conversation.id,
                content="Summarize without changing my library.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        read_only_run = db.get(ChatRun, read_only_chat.run_id)
        assert read_only_run is not None
        _assert_persisted_prompt_matches_frozen_authority(
            db,
            run=read_only_run,
            expected_authority="ReadOnly",
        )

        operation = runtime.operations["ChatReadAdditiveWrite"]
        job_context = claim_running_chat_tool_job(
            db,
            job_id=chat.job_id,
            run=run,
            worker_id=f"write-tools-{uuid4()}",
        )
        generation = compose_chat_tool_generation(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
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
                generation=generation,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
            )
            for index, (tool_id, arguments) in enumerate(successful_cases, start=1)
        )

        assert all(result["type"] == "Success" for result in successes), successes
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

        from nexus.services.tool_authority import read_tool_positions

        first_positions = read_tool_positions(db, generation_id=generation.generation_id)
        assert tuple(position.position for position in first_positions) == (1, 2, 3, 4, 5)
        for row, position in zip(first_rows, first_positions, strict=True):
            assert row.tool_position_id == position.id
            assert position.replay_status == "Completed"
            assert position.effect_identity == {
                "effect_id": str(position.id),
                "generation_id": str(generation.generation_id),
                "position_path": position.path,
            }

        # Re-entering one completed position returns the exact terminal result;
        # no domain owner, trust row, event, or canonical position runs twice.
        replayed_note = _execute_write(
            db,
            generation=generation,
            tool_id="nexus.note.create",
            tool_call_index=2,
            arguments=successful_cases[1][1],
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
                generation=generation,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
            )
            for index, (tool_id, arguments) in enumerate(foreign_cases, start=6)
        )
        assert denied == (_failure("ResourceUnavailable"),) * len(foreign_cases), (
            "foreign mutating tool crossed owner authorization"
        )
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
                "nexus.highlight.create",
                successful_cases[2][1],
                "Conflict",
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
                generation=generation,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=arguments,
            )
            for index, (tool_id, arguments, _error_type) in enumerate(
                refusal_cases,
                start=11,
            )
        )
        assert refusals == tuple(_failure(error_type) for _, _, error_type in refusal_cases)
        assert (
            db.scalar(
                select(func.count()).select_from(Highlight).where(Highlight.user_id == owner_id)
            )
            == 1
        )

        fill_arguments = {
            "resource_uri": quote_uri,
            "library_id": str(target_library_id),
            "library_name": None,
        }
        fill_results = tuple(
            _execute_write(
                db,
                generation=generation,
                tool_id="nexus.library.add",
                tool_call_index=index,
                arguments=fill_arguments,
            )
            for index in range(19, 22)
        )
        assert all(result["type"] == "Success" for result in fill_results)
        assert all(result["value"]["already_present"] is True for result in fill_results)
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        capped = _execute_write(
            db,
            generation=generation,
            tool_id="nexus.library.add",
            tool_call_index=22,
            arguments=fill_arguments,
        )
        assert capped == _failure("WriteCapReached")
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        trust = build_assistant_trust_trail(
            db,
            viewer_id=owner_id,
            assistant_message_id=run.assistant_message_id,
            catalog_snapshot=catalog_snapshot,
        )
        execution_tools = tuple(
            tool for tool in trust.tool_calls if tool.record_kind == "current_execution"
        )
        assert tuple(tool.canonical_tool_id for tool in execution_tools[:5]) == _WRITE_TOOL_IDS
        assert all(tool.provider_wire_name is not None for tool in execution_tools)
        assert all(tool.provider_wire_name == tool.canonical_tool_id for tool in execution_tools)
        assert all(tool.result_kind == "mutation" for tool in execution_tools)
        assert all(tool.effect == ToolEffect.Write for tool in execution_tools)

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
            generation=generation,
            tool_id="nexus.library.add",
            tool_call_index=23,
            arguments=fill_arguments,
        )
        assert reclaimed["type"] == "Success"
        assert reclaimed["value"]["already_present"] is False
        assert _active_write_count(_tool_rows(db, run.assistant_message_id)) == 8

        rows_by_index = {
            row.tool_call_index: row for row in _tool_rows(db, run.assistant_message_id)
        }
        for row in (*first_success_rows[1:], rows_by_index[23]):
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
            catalog_snapshot=catalog_snapshot,
        )
        reverted = {
            tool.tool_call_index for tool in final_trust.tool_calls if tool.reverted_at is not None
        }
        assert {1, 2, 3, 4, 5, 23} <= reverted

        final_rows = _tool_rows(db, run.assistant_message_id)
        final_events = list(
            db.scalars(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == run.id,
                    ChatRunEvent.event_type == "tool_result",
                )
            )
        )
        assert len(final_rows) == len(final_events) == 23
        assert {row.record_kind for row in final_rows} == {"current_execution"}
        assert all("tool_name" not in event.payload for event in final_events)
        final_positions = read_tool_positions(db, generation_id=generation.generation_id)
        assert len(final_positions) == len(final_rows)
        assert all(
            row.tool_position_id == position.id
            for row, position in zip(final_rows, final_positions, strict=True)
        )

    _assert_library_add_closes_podcast_owner_refusals(engine)
    _assert_concurrent_queue_insertion_is_not_claimed_for_undo(engine)


def _assert_library_add_closes_podcast_owner_refusals(engine: Engine) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"podcast-write-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"write-tool-foreign-member-{foreign_id}@example.invalid",
        )
        conversation = conversations.create_conversation(db, owner_id)

        source_library_id = uuid4()
        unsubscribed_target_id = uuid4()
        replacement_target_id = uuid4()
        billing_target_id = uuid4()
        for library_id, name in (
            (source_library_id, "Visible podcast source"),
            (unsubscribed_target_id, "Subscription required"),
            (replacement_target_id, "Episode replacement"),
            (billing_target_id, "Shared destination"),
        ):
            library_governance.create_library(
                db,
                owner_id,
                CreateLibraryRequest(library_id=library_id, name=name),
            )
        db.add(Membership(library_id=billing_target_id, user_id=foreign_id, role="member"))

        unsubscribed_id = uuid4()
        replacement_id = uuid4()
        billing_id = uuid4()
        for podcast_id, title in (
            (unsubscribed_id, "Unsubscribed podcast"),
            (replacement_id, "Replacement podcast"),
            (billing_id, "Shared podcast"),
        ):
            db.add(
                Podcast(
                    id=podcast_id,
                    provider="test",
                    provider_podcast_id=str(podcast_id),
                    title=title,
                    feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
                )
            )
        db.flush()
        library_entries.ensure_entry(
            db,
            source_library_id,
            library_entries.podcast_target(unsubscribed_id),
        )
        for podcast_id in (replacement_id, billing_id):
            db.add(
                PodcastSubscription(
                    id=uuid4(),
                    user_id=owner_id,
                    podcast_id=podcast_id,
                    next_sync_at=datetime.now(UTC),
                )
            )

        episode_id = uuid4()
        db.add(
            Media(
                id=episode_id,
                kind=MediaKind.podcast_episode.value,
                title="Directly filed episode",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=owner_id,
            )
        )
        db.flush()
        db.add(PodcastEpisode(media_id=episode_id, podcast_id=replacement_id))
        library_entries.ensure_entry(
            db,
            replacement_target_id,
            library_entries.media_target(episode_id),
        )
        db.flush()
        db.add_all(
            [
                ResourceEdge(
                    user_id=owner_id,
                    source_scheme="conversation",
                    source_id=conversation.id,
                    target_scheme="podcast",
                    target_id=podcast_id,
                    kind="context",
                    origin="system",
                    source_order_key=f"podcast-tool-safety-{ordinal}",
                )
                for ordinal, podcast_id in enumerate(
                    (unsubscribed_id, replacement_id, billing_id),
                    start=1,
                )
            ]
        )
        db.commit()

        catalog = configured_chat_catalog_service()
        catalog_snapshot = asyncio.run(catalog.read_chat())
        runtime = compose_available_product_tool_runtime()
        chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=conversation.id,
                content="File only podcasts whose placement owner authorizes the change.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="AdditiveWrites",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        revoke_entitlement_override(
            db,
            user_id=owner_id,
            reason="exercise closed library-add billing refusal",
            actor_label="nexus-test",
        )
        db.commit()

        operation = runtime.operations["ChatReadAdditiveWrite"]
        job_context = claim_running_chat_tool_job(
            db,
            job_id=chat.job_id,
            run=run,
            worker_id=f"podcast-write-refusal-{uuid4()}",
        )
        generation = compose_chat_tool_generation(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
        )
        cases = (
            (unsubscribed_id, unsubscribed_target_id, "ResourceUnavailable"),
            (replacement_id, replacement_target_id, "TargetAmbiguous"),
            (billing_id, billing_target_id, "ResourceUnavailable"),
        )
        results = tuple(
            _execute_write(
                db,
                generation=generation,
                tool_id="nexus.library.add",
                tool_call_index=index,
                arguments={
                    "resource_uri": f"podcast:{podcast_id}",
                    "library_id": str(library_id),
                    "library_name": None,
                },
            )
            for index, (podcast_id, library_id, _error_type) in enumerate(cases, start=1)
        )

        assert results == tuple(_failure(error_type) for _, _, error_type in cases)
        assert (
            db.scalar(
                select(func.count())
                .select_from(LibraryEntry)
                .where(
                    LibraryEntry.podcast_id.in_([unsubscribed_id, replacement_id, billing_id]),
                    LibraryEntry.library_id.in_(
                        [unsubscribed_target_id, replacement_target_id, billing_target_id]
                    ),
                )
            )
            == 0
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(LibraryEntry)
                .where(
                    LibraryEntry.library_id == replacement_target_id,
                    LibraryEntry.media_id == episode_id,
                )
            )
            == 1
        )


def _assert_concurrent_queue_insertion_is_not_claimed_for_undo(engine: Engine) -> None:
    owner_id = uuid4()
    with Session(engine, expire_on_commit=False) as setup:
        default_library_id = bootstrap.ensure_user_and_default_library(
            setup,
            owner_id,
            f"queue-race-owner-{owner_id}@example.invalid",
        )
        media_id = create_readable_media(
            setup,
            user_id=owner_id,
            default_library_id=default_library_id,
            title="Concurrent queue target",
            canonical_text="A manually queued item must remain user-owned.",
        )

    media_uri = f"media:{media_id}"
    lock_attempted = Event()

    def execute_blocked_queue_add() -> Any:
        with engine.connect() as connection:

            def observe_viewer_lock(
                _connection: Any,
                _cursor: Any,
                statement: str,
                _parameters: Any,
                _context: Any,
                _executemany: bool,
            ) -> None:
                normalized = " ".join(statement.upper().split())
                if "FROM USERS" in normalized and "FOR UPDATE" in normalized:
                    lock_attempted.set()

            event.listen(connection, "before_cursor_execute", observe_viewer_lock)
            try:
                with Session(bind=connection, expire_on_commit=False) as worker:
                    effect = add_to_queue(worker, owner_id, {"media_uri": media_uri})
                    worker.commit()
                    return effect
            finally:
                event.remove(connection, "before_cursor_execute", observe_viewer_lock)

    with Session(engine) as blocker:
        blocker.execute(
            text("SELECT 1 FROM users WHERE id = :viewer_id FOR UPDATE"),
            {"viewer_id": owner_id},
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            execution = pool.submit(execute_blocked_queue_add)
            assert lock_attempted.wait(timeout=10), "queue add never attempted its owner lock"
            assert not execution.done(), "queue add did not wait for its owner lock"
            inserted = consumption_service.ensure_missing_items_in_txn(
                blocker,
                viewer_id=owner_id,
                media_ids=[media_id],
                source="Manual",
            )
            assert len(inserted) == 1
            blocker.commit()
            result = execution.result(timeout=10)

    assert result.output["already_present"] is True
    assert result.created_refs == []
    with Session(engine, expire_on_commit=False) as oracle:
        queue_row = oracle.scalar(
            select(ConsumptionQueueItem).where(
                ConsumptionQueueItem.user_id == owner_id,
                ConsumptionQueueItem.media_id == media_id,
            )
        )
        assert queue_row is not None and queue_row.source == "manual"
