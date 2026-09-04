"""Machine-authorship proof across additive writes, retrieval, trust, and Undo."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from importlib.util import find_spec
from typing import cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select

# BASE overlays this proof without the candidate persistence/projection owner.
_CUTOVER_PRESENT = find_spec("nexus.services.assistant_write_authorship") is not None


def test_all_additive_writes_publish_durable_authorship_into_later_model_reads(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: assistant-created content is later presented as user-authored data."""

    assert _CUTOVER_PRESENT, "the machine-authorship owner is absent"
    # Candidate-only fixture resolution must not become the BASE red oracle.
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_machine_authorship_lifecycle(engine))


async def _prove_machine_authorship_lifecycle(engine: Engine) -> None:
    from llm_tools import ToolId
    from sqlalchemy.orm import Session, sessionmaker

    from nexus.db.models import (
        AssistantWriteAuthorship,
        ChatRun,
        Fragment,
        MessageToolCall,
    )
    from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job
    from nexus.schemas.chat_reader_selection import ReaderSelectionInput, ReaderSelectionKey
    from nexus.schemas.library import CreateLibraryRequest
    from nexus.schemas.presence import Present
    from nexus.services import bootstrap, highlights, library_governance
    from nexus.services.agent_tools.writes import undo_tool_call
    from nexus.services.assistant_write_authorship import (
        machine_authorship_for_resource_uri,
        persist_assistant_write_authorships,
    )
    from nexus.services.chat_reader_selection import (
        build_reader_selection_snapshot,
        compute_reader_selection_revision,
    )
    from nexus.services.generation_spec import (
        FrozenToolScope,
        GenerationSpec,
        GenerationSpecFacts,
        decode_generation_spec_document,
        tool_scope_digest,
    )
    from nexus.services.llm_ledger import (
        GenerationStart,
        LlmCallOwner,
        generation_spec_document,
        start_generation_in_current_transaction,
    )
    from nexus.services.message_trust_trails import build_assistant_trust_trail
    from nexus.services.tool_authority import compose_generation_tool_executor
    from nexus.services.tool_runtime.composition import freeze_tool_plan_snapshot
    from nexus.services.tool_runtime.execution import ChatToolExecutionProjection
    from tests.testkit.chat import create_entitled_chat
    from tests.testkit.codex_generation import codex_generation_draft
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import (
        claim_running_chat_tool_job,
        compose_available_product_tool_runtime,
        create_readable_media,
    )

    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    catalog = configured_chat_catalog_service()
    catalog_snapshot = await catalog.read_chat()
    tool_runtime = compose_available_product_tool_runtime()
    owner_id = uuid4()
    source_text = (
        "The reader selected this seed quote. "
        "This assistant-authored highlight is independently addressable. "
        "This second assistant highlight has no attached note."
    )
    selected_exact = "The reader selected this seed quote."
    authored_exact = "This assistant-authored highlight is independently addressable."
    authored_without_note_exact = "This second assistant highlight has no attached note."
    foreign_owner_id = uuid4()

    with Session(engine, expire_on_commit=False) as db:
        default_library_id = bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"machine-authorship-{owner_id}@example.invalid",
        )
        media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=default_library_id,
            title="Machine authorship source",
            canonical_text=source_text,
        )
        fragment = db.scalar(select(Fragment).where(Fragment.media_id == media_id))
        assert fragment is not None, "readable-media fixture omitted its canonical fragment"
        selected_highlight = highlights.create_fragment_highlight_in_txn(
            db,
            viewer_id=owner_id,
            highlight_id=uuid4(),
            fragment_id=fragment.id,
            start_offset=source_text.index(selected_exact),
            end_offset=source_text.index(selected_exact) + len(selected_exact),
            color="yellow",
        )
        selected_highlight_id = selected_highlight.id
        foreign_library_id = bootstrap.ensure_user_and_default_library(
            db,
            foreign_owner_id,
            f"machine-authorship-foreign-{foreign_owner_id}@example.invalid",
        )
        foreign_media_id = create_readable_media(
            db,
            user_id=foreign_owner_id,
            default_library_id=foreign_library_id,
            title="Foreign machine-authorship source",
            canonical_text="A foreign owner's independently addressable passage.",
        )
        foreign_fragment = db.scalar(select(Fragment).where(Fragment.media_id == foreign_media_id))
        assert foreign_fragment is not None, "foreign fixture omitted its canonical fragment"
        foreign_highlight = highlights.create_fragment_highlight_in_txn(
            db,
            viewer_id=foreign_owner_id,
            highlight_id=uuid4(),
            fragment_id=foreign_fragment.id,
            start_offset=0,
            end_offset=len("A foreign owner's independently addressable passage."),
            color="yellow",
        )
        foreign_highlight_id = foreign_highlight.id
        selection_key = ReaderSelectionKey(
            media_id=media_id,
            highlight_id=selected_highlight.id,
        )
        selection_snapshot = build_reader_selection_snapshot(
            db,
            viewer_id=owner_id,
            key=selection_key,
        )
        db.commit()

        chat = await create_entitled_chat(
            db,
            content="Make each of the five requested additive changes.",
            catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
            selection=CHAT_TEST_SELECTION,
            tool_authority="AdditiveWrites",
            catalog=catalog,
            tool_runtime=tool_runtime,
            user_id=owner_id,
            reader_selection=ReaderSelectionInput(
                key=selection_key,
                revision=compute_reader_selection_revision(selection_snapshot),
            ),
        )
        target_library_id = uuid4()
        library_governance.create_library(
            db,
            owner_id,
            CreateLibraryRequest(
                library_id=target_library_id,
                name="Assistant-authored filing",
            ),
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None, "admitted Chat run disappeared before tool execution"
        job_context = claim_running_chat_tool_job(
            db,
            job_id=chat.job_id,
            run=run,
            worker_id=f"machine-authorship-write-{uuid4()}",
        )
        chat_spec = decode_generation_spec_document(run.generation_spec)
        generation_id = uuid4()
        owner = LlmCallOwner(kind="chat_run", id=run.id)
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=generation_id,
                owner=owner,
                spec=generation_spec_document(chat_spec),
            ),
        )
        db.commit()
        assistant_message_id = run.assistant_message_id
        conversation_id = run.conversation_id

    write_operation = tool_runtime.operations["ChatReadAdditiveWrite"]
    write_executor = compose_generation_tool_executor(
        session_factory=session_factory,
        user_id=owner_id,
        owner=owner,
        generation_id=generation_id,
        job_context=job_context,
        operation=write_operation,
        projection=ChatToolExecutionProjection(
            run_id=chat.run_id,
            initial_citation_ordinal=1,
        ),
    )
    media_uri = f"media:{media_id}"
    selected_highlight_uri = f"highlight:{selected_highlight.id}"
    write_cases: tuple[tuple[str, dict[str, object]], ...] = (
        (
            "nexus.library.add",
            {
                "library_id": str(target_library_id),
                "library_name": None,
                "resource_uri": media_uri,
            },
        ),
        (
            "nexus.note.create",
            {
                "markdown": "This note was authored by the assistant write tool.",
                "page_uri": None,
            },
        ),
        (
            "nexus.highlight.create",
            {
                "color": "blue",
                "exact": authored_exact,
                "media_uri": media_uri,
                "note": "This attached note was also authored by the assistant.",
                "prefix": None,
                "suffix": None,
            },
        ),
        (
            "nexus.edge.create",
            {
                "kind": "context",
                "rationale": "The assistant linked the selected quote to its source.",
                "source_uri": media_uri,
                "target_uri": selected_highlight_uri,
            },
        ),
        ("nexus.queue.add", {"media_uri": media_uri}),
    )
    write_results = []
    for position, (tool_id, arguments) in enumerate(write_cases, start=1):
        executed = await write_executor.execute_canonical(
            transport_kind="CodexMcp" if position % 2 else "ProviderApi",
            model_turn_seq=1,
            transport_call_id=f"machine-authorship-write-{position}",
            provider_wire_name=tool_id,
            tool_id=ToolId(tool_id),
            arguments=arguments,
        )
        assert not executed.model_output.is_error, (
            f"{tool_id} did not reach its successful authorship boundary: "
            f"{executed.model_output.output}"
        )
        assert executed.position.path == f"generation/1/tool/{position}"
        write_results.append(executed)

    replayed_note = await write_executor.execute_canonical(
        transport_kind="ProviderApi",
        model_turn_seq=1,
        transport_call_id="machine-authorship-write-2",
        provider_wire_name="nexus.note.create",
        tool_id=ToolId("nexus.note.create"),
        arguments=write_cases[1][1],
    )
    assert replayed_note.model_output.output == write_results[1].model_output.output
    assert replayed_note.position.id == write_results[1].position.id

    # Library and queue writes are successful no-ops when the exact target is
    # already present. Reissuing each operation at a new canonical position must
    # retain an empty target/authorship set; replaying that position must remain
    # the same empty effect rather than claiming the pre-existing user state.
    no_target_results = []
    for position, write_case in enumerate((write_cases[0], write_cases[4]), start=6):
        tool_id, arguments = write_case
        executed = await write_executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=2,
            transport_call_id=f"machine-authorship-no-target-{position}",
            provider_wire_name=tool_id,
            tool_id=ToolId(tool_id),
            arguments=arguments,
        )
        assert not executed.model_output.is_error, executed.model_output.output
        assert executed.position is not None
        assert executed.position.path == f"generation/1/tool/{position}"
        replayed = await write_executor.execute_canonical(
            transport_kind="ProviderApi",
            model_turn_seq=2,
            transport_call_id=f"machine-authorship-no-target-{position}",
            provider_wire_name=tool_id,
            tool_id=ToolId(tool_id),
            arguments=arguments,
        )
        assert replayed.model_output.output == executed.model_output.output
        assert replayed.position is not None
        assert replayed.position.id == executed.position.id
        no_target_results.append(executed)

    highlight_without_note_arguments = dict(write_cases[2][1])
    highlight_without_note_arguments["exact"] = authored_without_note_exact
    highlight_without_note_arguments["note"] = None
    highlight_without_note_result = await write_executor.execute_canonical(
        transport_kind="CodexMcp",
        model_turn_seq=2,
        transport_call_id="machine-authorship-highlight-without-note",
        provider_wire_name="nexus.highlight.create",
        tool_id=ToolId("nexus.highlight.create"),
        arguments=highlight_without_note_arguments,
    )
    assert not highlight_without_note_result.model_output.is_error, (
        highlight_without_note_result.model_output.output
    )
    assert highlight_without_note_result.position is not None
    assert highlight_without_note_result.position.path == "generation/1/tool/8"

    expected_target_kinds = {
        "nexus.library.add": ("library_entry",),
        "nexus.note.create": ("note_block",),
        "nexus.highlight.create": ("highlight", "note_block"),
        "nexus.edge.create": ("resource_edge",),
        "nexus.queue.add": ("queue_item",),
    }
    result_kind_to_target_kind = {
        "entry": "library_entry",
        "note_block": "note_block",
        "highlight": "highlight",
        "edge": "resource_edge",
        "queue": "queue_item",
    }
    with Session(engine) as db:
        trust = build_assistant_trust_trail(
            db,
            viewer_id=owner_id,
            assistant_message_id=assistant_message_id,
            catalog_snapshot=catalog_snapshot,
        )
    tools_by_position = {
        tool.tool_call_index: tool
        for tool in trust.tool_calls
        if tool.canonical_tool_id in expected_target_kinds
    }
    writes = {
        tool_id: tools_by_position[position]
        for position, (tool_id, _arguments) in enumerate(write_cases, start=1)
    }
    assert set(writes) == set(expected_target_kinds), (
        "trust projection omitted one of the five successful additive writes"
    )
    for tool_id, expected_kinds in expected_target_kinds.items():
        tool = writes[tool_id]
        assert tuple(item.target_kind for item in tool.machine_authorships) == expected_kinds
        ref_targets = {
            (result_kind_to_target_kind[str(ref["kind"])], UUID(str(ref["id"])))
            for ref in tool.result_refs
        }
        assert {
            (item.target_kind, item.target_id) for item in tool.machine_authorships
        } == ref_targets
        for item in tool.machine_authorships:
            assert item.generation_id == generation_id
            assert item.generation_seq == 1
            assert item.tool_position == tool.tool_call_index
            assert item.position_path == f"generation/1/tool/{tool.tool_call_index}"
            assert item.effect_id == write_results[tool.tool_call_index - 1].position.id

    no_target_writes = tuple(tools_by_position[position] for position in (6, 7))
    for no_target_result, tool in zip(no_target_results, no_target_writes, strict=True):
        assert tool.result_refs == []
        assert tool.machine_authorships == []
        assert no_target_result.position is not None
        assert tool.tool_call_index == no_target_result.position.position
    highlight_without_note = tools_by_position[8]
    assert tuple(item.target_kind for item in highlight_without_note.machine_authorships) == (
        "highlight",
    )
    assert highlight_without_note_result.position is not None
    assert highlight_without_note.machine_authorships[0].effect_id == (
        highlight_without_note_result.position.id
    )

    # Cardinality and provenance are trusted-state invariants. Exercise the
    # terminal persistence boundary with malformed successful write receipts;
    # every underflow, overflow, duplicate, foreign target, position mismatch,
    # and effect-identity mismatch must defect before staging an association.
    def created_ref(kind: str, target_id: UUID | None = None) -> dict[str, object]:
        return {"kind": kind, "id": str(target_id or uuid4())}

    original_highlight_target_id = next(
        item.target_id
        for item in writes["nexus.highlight.create"].machine_authorships
        if item.target_kind == "highlight"
    )
    cardinality_faults = (
        (
            "nexus.highlight.create",
            [
                created_ref("highlight", original_highlight_target_id),
                created_ref("highlight", selected_highlight_id),
            ],
            "exceeded",
        ),
        ("nexus.library.add", [created_ref("entry"), created_ref("entry")], "exceeded"),
        ("nexus.queue.add", [created_ref("queue"), created_ref("queue")], "exceeded"),
        ("nexus.note.create", [], "omitted"),
        (
            "nexus.note.create",
            [created_ref("note_block"), created_ref("note_block")],
            "exceeded",
        ),
        (
            "nexus.note.create",
            [
                created_ref(
                    "note_block",
                    writes["nexus.note.create"].machine_authorships[0].target_id,
                ),
                created_ref(
                    "note_block",
                    writes["nexus.note.create"].machine_authorships[0].target_id,
                ),
            ],
            "repeated",
        ),
        ("nexus.note.create", [created_ref("highlight")], "outside its closed contract"),
        ("nexus.edge.create", [], "omitted"),
        ("nexus.edge.create", [created_ref("edge"), created_ref("edge")], "exceeded"),
        ("nexus.highlight.create", [], "omitted"),
        ("nexus.highlight.create", [created_ref("note_block")], "omitted"),
        (
            "nexus.highlight.create",
            [created_ref("highlight"), created_ref("note_block"), created_ref("note_block")],
            "exceeded",
        ),
    )
    position_by_tool_id = {
        tool_id: write_results[position - 1].position
        for position, (tool_id, _arguments) in enumerate(write_cases, start=1)
    }
    with Session(engine) as db:
        note_position = position_by_tool_id["nexus.note.create"]
        assert note_position is not None
        with pytest.raises(AssertionError, match="created refs differ from its Chat projection"):
            persist_assistant_write_authorships(
                db,
                viewer_id=owner_id,
                tool_call_id=writes["nexus.note.create"].id,
                position=note_position,
                created_refs=[],
            )

        for tool_id, refs, expected_error in cardinality_faults:
            position = position_by_tool_id[tool_id]
            assert position is not None
            projection = db.get(MessageToolCall, writes[tool_id].id)
            assert projection is not None
            projection.result_refs = refs
            db.flush()
            with pytest.raises(AssertionError, match=expected_error):
                persist_assistant_write_authorships(
                    db,
                    viewer_id=owner_id,
                    tool_call_id=writes[tool_id].id,
                    position=position,
                    created_refs=refs,
                )
            db.rollback()

        highlight_position = position_by_tool_id["nexus.highlight.create"]
        assert highlight_position is not None
        foreign_refs = [created_ref("highlight", foreign_highlight_id)]
        highlight_projection = db.get(
            MessageToolCall,
            writes["nexus.highlight.create"].id,
        )
        assert highlight_projection is not None
        highlight_projection.result_refs = foreign_refs
        db.flush()
        with pytest.raises(AssertionError, match="absent or not owned by its actor"):
            persist_assistant_write_authorships(
                db,
                viewer_id=owner_id,
                tool_call_id=writes["nexus.highlight.create"].id,
                position=highlight_position,
                created_refs=foreign_refs,
            )
        db.rollback()

        library_position = position_by_tool_id["nexus.library.add"]
        assert library_position is not None
        library_projection = db.get(MessageToolCall, writes["nexus.library.add"].id)
        assert library_projection is not None
        library_projection.result_refs = []
        db.flush()
        with pytest.raises(
            AssertionError,
            match="persisted assistant write authorship differs from its exact created targets",
        ):
            persist_assistant_write_authorships(
                db,
                viewer_id=owner_id,
                tool_call_id=writes["nexus.library.add"].id,
                position=library_position,
                created_refs=[],
            )
        db.rollback()

        edge_position = position_by_tool_id["nexus.edge.create"]
        assert edge_position is not None
        with pytest.raises(AssertionError, match="differs from its canonical position"):
            persist_assistant_write_authorships(
                db,
                viewer_id=owner_id,
                tool_call_id=writes["nexus.note.create"].id,
                position=edge_position,
                created_refs=writes["nexus.note.create"].result_refs,
            )
        with pytest.raises(AssertionError, match="exact stable effect identity"):
            persist_assistant_write_authorships(
                db,
                viewer_id=owner_id,
                tool_call_id=writes["nexus.note.create"].id,
                position=replace(note_position, effect_identity=None),
                created_refs=writes["nexus.note.create"].result_refs,
            )
        db.rollback()

    note_authorship = writes["nexus.note.create"].machine_authorships[0]
    highlight_authorship = next(
        item
        for item in writes["nexus.highlight.create"].machine_authorships
        if item.target_kind == "highlight"
    )
    edge_authorship = writes["nexus.edge.create"].machine_authorships[0]
    note_uri = f"note_block:{note_authorship.target_id}"
    highlight_uri = f"highlight:{highlight_authorship.target_id}"

    # Controlled trusted-state faults: the API projection must defect instead
    # of omitting, guessing, or relabeling machine authorship. Each mutation is
    # rolled back before the product lifecycle continues.
    with Session(engine) as db:
        stored_note_authorship = db.scalar(
            select(AssistantWriteAuthorship).where(
                AssistantWriteAuthorship.target_kind == "note_block",
                AssistantWriteAuthorship.target_id == note_authorship.target_id,
            )
        )
        assert stored_note_authorship is not None
        stored_note_authorship.target_id = uuid4()
        db.flush()
        with pytest.raises(
            AssertionError,
            match="persisted machine authorship has an invalid stable identity",
        ):
            build_assistant_trust_trail(
                db,
                viewer_id=owner_id,
                assistant_message_id=assistant_message_id,
                catalog_snapshot=catalog_snapshot,
            )
        with pytest.raises(
            AssertionError,
            match="retrieval target lacks its exact association",
        ):
            machine_authorship_for_resource_uri(
                db,
                viewer_id=owner_id,
                resource_uri=note_uri,
            )
        db.rollback()
    with Session(engine) as db:
        stored_note_authorship = db.scalar(
            select(AssistantWriteAuthorship).where(
                AssistantWriteAuthorship.target_kind == "note_block",
                AssistantWriteAuthorship.target_id == note_authorship.target_id,
            )
        )
        assert stored_note_authorship is not None
        db.delete(stored_note_authorship)
        db.flush()
        with pytest.raises(
            AssertionError,
            match="authorship differs from its exact created targets",
        ):
            build_assistant_trust_trail(
                db,
                viewer_id=owner_id,
                assistant_message_id=assistant_message_id,
                catalog_snapshot=catalog_snapshot,
            )
        with pytest.raises(
            AssertionError,
            match="retrieval target lacks its exact association",
        ):
            machine_authorship_for_resource_uri(
                db,
                viewer_id=owner_id,
                resource_uri=note_uri,
            )
        db.rollback()

    read_operation = tool_runtime.operations["LibraryDossierRead"]
    read_generation_id = uuid4()
    read_scope = FrozenToolScope(
        admitted_refs=tuple(sorted((highlight_uri, media_uri, note_uri))),
        predicates=(),
    )
    draft = codex_generation_draft(
        request_id=read_generation_id,
        operation="dossier_library",
        instructions="Read only the admitted evidence and preserve its authorship labels.",
        input_text="Inspect the assistant-created targets.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=120,
        model_tool_plan=freeze_tool_plan_snapshot(read_operation),
    )
    read_facts = draft.spec.model_dump(
        mode="python",
        by_alias=True,
        exclude={"fingerprint"},
    )
    read_facts["admitted_tool_scope"] = Present(value=read_scope)
    read_facts["admitted_tool_scope_digest"] = Present(value=tool_scope_digest(read_scope))
    read_spec = GenerationSpec.freeze(GenerationSpecFacts.model_validate(read_facts))
    read_owner = LlmCallOwner(kind="artifact_build", id=uuid4())
    read_worker = f"machine-authorship-read-{uuid4()}"
    with Session(engine) as db:
        read_job = enqueue_job(
            db,
            kind="machine_authorship_retrieval_proof",
            max_attempts=2,
        )
        claimed = claim_job(
            db,
            job_id=read_job.id,
            worker_id=read_worker,
            lease_seconds=300,
            heavy_kinds=(),
        )
        assert claimed is not None, "later-read proof could not claim its durable job"
        read_job_context = JobExecutionContext(
            job_id=read_job.id,
            worker_id=read_worker,
            attempt_no=claimed.attempts,
            resource_class="Light",
        )
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=read_generation_id,
                owner=read_owner,
                spec=generation_spec_document(read_spec),
            ),
        )
        db.commit()

    read_executor = compose_generation_tool_executor(
        session_factory=session_factory,
        user_id=owner_id,
        owner=read_owner,
        generation_id=read_generation_id,
        job_context=read_job_context,
        operation=read_operation,
    )
    note_read = await read_executor.execute_canonical(
        transport_kind="CodexMcp",
        model_turn_seq=1,
        transport_call_id="machine-authorship-read-note",
        provider_wire_name="nexus.resource.read",
        tool_id=ToolId("nexus.resource.read"),
        arguments={"uri": note_uri},
    )
    highlight_read = await read_executor.execute_canonical(
        transport_kind="ProviderApi",
        model_turn_seq=2,
        transport_call_id="machine-authorship-read-highlight",
        provider_wire_name="nexus.resource.read",
        tool_id=ToolId("nexus.resource.read"),
        arguments={"uri": highlight_uri},
    )
    relation_read = await read_executor.execute_canonical(
        transport_kind="CodexMcp",
        model_turn_seq=3,
        transport_call_id="machine-authorship-read-edge",
        provider_wire_name="nexus.relations.list",
        tool_id=ToolId("nexus.relations.list"),
        arguments={
            "direction": "both",
            "kinds": None,
            "limit": 10,
            "uri": media_uri,
        },
    )
    for result in (note_read, highlight_read, relation_read):
        assert not result.model_output.is_error, result.model_output.output
        binding = read_operation.plan.catalog_view.binding(
            ToolId(result.position.canonical_tool_id)
        )
        assert len(result.model_output.output.encode()) <= binding.spec.limits.max_output_bytes

    note_payload = json.loads(note_read.model_output.output)
    assert note_payload["value"]["text"] == ("This note was authored by the assistant write tool.")
    assert note_payload["value"]["evidence"]["machine_authorship"] == (
        note_authorship.model_dump(mode="json")
    )
    highlight_payload = json.loads(highlight_read.model_output.output)
    assert highlight_payload["value"]["text"] == authored_exact
    assert highlight_payload["value"]["evidence"]["machine_authorship"] == (
        highlight_authorship.model_dump(mode="json")
    )
    relation_payload = json.loads(relation_read.model_output.output)
    authored_relation = next(
        relation
        for relation in relation_payload["value"]["relations"]
        if relation["edge_id"] == str(edge_authorship.target_id)
    )
    assert authored_relation["rationale"] == (
        "The assistant linked the selected quote to its source."
    )
    assert authored_relation["machine_authorship"] == edge_authorship.model_dump(mode="json")

    targetful_writes = (*writes.values(), highlight_without_note)
    original_authorships = {
        tool.id: tuple(item.model_dump(mode="json") for item in tool.machine_authorships)
        for tool in targetful_writes
    }
    with Session(engine) as db:
        for tool in targetful_writes:
            first = undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=conversation_id,
                tool_call_id=tool.id,
            )
            second = undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=conversation_id,
                tool_call_id=tool.id,
            )
            assert first == second == assistant_message_id
        reverted_trust = build_assistant_trust_trail(
            db,
            viewer_id=owner_id,
            assistant_message_id=assistant_message_id,
            catalog_snapshot=catalog_snapshot,
        )
    targetful_tool_ids = {tool.id for tool in targetful_writes}
    reverted_writes = {
        tool.id: tool for tool in reverted_trust.tool_calls if tool.id in targetful_tool_ids
    }
    assert set(reverted_writes) == targetful_tool_ids
    assert all(tool.reverted_at is not None for tool in reverted_writes.values())
    assert {
        tool.id: tuple(item.model_dump(mode="json") for item in tool.machine_authorships)
        for tool in reverted_writes.values()
    } == original_authorships

    expected_durable_rows = {
        (item.effect_id, item.target_kind, item.target_id)
        for tool in targetful_writes
        for item in tool.machine_authorships
    }
    with Session(engine) as db:
        durable_after_undo = {
            (row.tool_position_id, row.target_kind, row.target_id)
            for row in db.scalars(
                select(AssistantWriteAuthorship).where(
                    AssistantWriteAuthorship.tool_position_id.in_(
                        item.effect_id
                        for tool in targetful_writes
                        for item in tool.machine_authorships
                    )
                )
            )
        }
        assert durable_after_undo == expected_durable_rows
        for tool_id in targetful_tool_ids:
            projection = db.get(MessageToolCall, tool_id)
            assert projection is not None, "Undo unexpectedly deleted its Chat projection"
            db.delete(projection)
        db.commit()

    with Session(engine) as db:
        assert (
            list(
                db.scalars(
                    select(MessageToolCall.id).where(MessageToolCall.id.in_(targetful_tool_ids))
                )
            )
            == []
        )
        durable_after_projection_deletion = {
            (row.tool_position_id, row.target_kind, row.target_id)
            for row in db.scalars(
                select(AssistantWriteAuthorship).where(
                    AssistantWriteAuthorship.tool_position_id.in_(
                        effect_id for effect_id, _target_kind, _target_id in expected_durable_rows
                    )
                )
            )
        }
    assert durable_after_projection_deletion == expected_durable_rows
