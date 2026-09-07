"""Priority proof: Nexus read tools preserve scope, evidence, and privacy."""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Mapping
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import pytest
from llm_tools import ToolId, canonical_json_bytes
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    ContentBlock,
    ContentIndexState,
    Fragment,
    MessageRetrieval,
    MessageToolCall,
    ResourceEdge,
)
from nexus.services import bootstrap, conversations
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    admits_resource_for_conversation_read,
)
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate

# BASE overlays this proof without the exact-generation production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_selection") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import (
        claim_running_chat_tool_job,
        compose_available_product_tool_runtime,
        compose_chat_tool_generation,
        create_readable_media,
        create_scoped_entitled_chat,
        execute_chat_tool,
    )

_EVIDENCE_KEYS = {
    "admission_scope",
    "citation_target",
    "content_sha256",
    "context_ref",
    "excerpt_id",
    "locator",
    "machine_authorship",
    "observed_at",
    "resource_uri",
    "snapshot_revision",
}
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _search_arguments(uri: str) -> dict[str, object]:
    # The whitespace query is schema-valid while the format supplies the
    # structured search predicate. This keeps the proof on deterministic
    # PostgreSQL retrieval rather than an external embedding boundary.
    return {
        "query": " ",
        "kinds": ["documents"],
        "formats": ["article"],
        "authors": None,
        "roles": None,
        "scopes": [uri],
        "limit": 2,
    }


def _read_arguments(tool_id: str, uri: str) -> dict[str, object]:
    if tool_id == "nexus.search":
        return _search_arguments(uri)
    if tool_id == "nexus.document.search":
        return {"uri": uri, "query": "singular nebula", "limit": 1}
    if tool_id == "nexus.relations.list":
        return {"uri": uri, "direction": "both", "kinds": ["supports"], "limit": 1}
    return {"uri": uri}


def _assert_canonical_evidence(evidence: object, *, expected_resource_uri: str) -> None:
    assert isinstance(evidence, dict), "read success omitted its typed evidence receipt"
    assert set(evidence) == _EVIDENCE_KEYS, "read evidence escaped its closed Nexus schema"
    assert evidence["resource_uri"] == expected_resource_uri
    assert evidence["machine_authorship"] is None
    assert isinstance(evidence["admission_scope"], str) and evidence["admission_scope"]
    assert isinstance(evidence["citation_target"], str) and evidence["citation_target"]
    revision = evidence["content_sha256"] or evidence["snapshot_revision"]
    assert isinstance(revision, str) and _SHA256.fullmatch(revision), (
        "read evidence was not tied to an immutable content or snapshot revision"
    )


def test_nexus_reads_are_scoped_citable_and_closed(request: pytest.FixtureRequest) -> None:
    assert _CUTOVER_PRESENT, "the final exact-generation selection owner is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        owner_default = bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"read-tool-owner-{owner_id}@example.invalid",
        )
        foreign_default = bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"read-tool-foreign-{foreign_id}@example.invalid",
        )
        conversation = conversations.create_conversation(db, owner_id)

        body = "First section. A singular nebula appears only in this admitted document."
        media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Admitted evidence atlas",
            canonical_text=body,
        )
        related_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Related evidence atlas",
            canonical_text="A second owner-visible source.",
        )
        empty_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Empty evidence atlas",
            canonical_text="",
        )
        oversized_media_id = create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title=f"Oversized evidence atlas {'x' * 17_000}",
            canonical_text="A deliberately oversized search citation.",
        )
        foreign_media_id = create_readable_media(
            db,
            user_id=foreign_id,
            default_library_id=foreign_default,
            title="Foreign private atlas",
            canonical_text="The other user's private evidence.",
        )
        missing_media_id = uuid4()
        media_uri = f"media:{media_id}"
        related_uri = f"media:{related_media_id}"
        empty_uri = f"media:{empty_media_id}"
        oversized_uri = f"media:{oversized_media_id}"
        foreign_uri = f"media:{foreign_media_id}"
        missing_uri = f"media:{missing_media_id}"

        fragment_id = db.scalar(select(Fragment.id).where(Fragment.media_id == media_id))
        assert fragment_id is not None
        db.add(
            ContentIndexState(
                owner_kind="media",
                owner_id=media_id,
                revision=1,
                status="ready",
            )
        )
        db.add(
            ContentBlock(
                owner_kind="media",
                owner_id=media_id,
                block_idx=0,
                block_kind="heading",
                canonical_text="First section",
                extraction_confidence=1.0,
                source_start_offset=0,
                source_end_offset=len(body),
                parent_block_id=None,
                heading_path=["First section"],
                locator={
                    "section_id": "first-section",
                    "fragment_id": str(fragment_id),
                    "fragment_idx": 0,
                    "heading_level": 1,
                    "start_offset": 0,
                    "end_offset": len(body),
                },
                selector={"kind": "heading"},
                metadata_json={"depth": 1, "ordinal": 1},
            )
        )
        for target in (
            ResourceRef(scheme="media", id=media_id),
            ResourceRef(scheme="media", id=related_media_id),
            ResourceRef(scheme="media", id=empty_media_id),
            ResourceRef(scheme="media", id=oversized_media_id),
        ):
            add_context_ref_without_commit(
                db,
                viewer_id=owner_id,
                conversation_id=conversation.id,
                target=target,
                origin="user",
            )
        relation = create_edge(
            db,
            viewer_id=owner_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="media", id=media_id),
                target=ResourceRef(scheme="media", id=related_media_id),
                kind="supports",
                origin="user",
            ),
        )

        # Deliberately unreachable fixture: both refs pass conversation
        # admission, so the binding must still apply ViewerRead and collapse a
        # real foreign row with a nonexistent row. The assertions immediately
        # below independently verify the fixture's intended state.
        db.add_all(
            [
                ResourceEdge(
                    user_id=owner_id,
                    source_scheme="conversation",
                    source_id=conversation.id,
                    target_scheme="media",
                    target_id=target_id,
                    kind="context",
                    origin="system",
                    source_order_key=f"proof-{ordinal}",
                )
                for ordinal, target_id in enumerate(
                    (foreign_media_id, missing_media_id),
                    start=1,
                )
            ]
        )
        db.commit()

        for target_id in (foreign_media_id, missing_media_id):
            target = ResourceRef(scheme="media", id=target_id)
            assert admits_resource_for_conversation_read(
                db,
                conversation_id=conversation.id,
                target=target,
            )
            assert not can_read_media(db, owner_id, target_id)

        catalog = configured_chat_catalog_service()
        catalog_snapshot = asyncio.run(catalog.read_chat())
        runtime = compose_available_product_tool_runtime()
        chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=conversation.id,
                content="Read the admitted evidence only.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        operation = runtime.operations["ChatRead"]
        job_context = claim_running_chat_tool_job(
            db,
            job_id=chat.job_id,
            run=run,
            worker_id=f"read-tools-{uuid4()}",
        )
        generation = compose_chat_tool_generation(
            db,
            operation=operation,
            run=run,
            job_context=job_context,
        )
        tool_ids = (
            "nexus.search",
            "nexus.resource.read",
            "nexus.document.search",
            "nexus.resource.inspect",
            "nexus.relations.list",
        )

        successes = {
            tool_id: execute_chat_tool(
                db,
                generation=generation,
                tool_id=tool_id,
                tool_call_index=index,
                arguments=_read_arguments(tool_id, media_uri),
            )
            for index, tool_id in enumerate(tool_ids, start=1)
        }
        assert all(result["type"] == "Success" for result in successes.values())

        search_value = successes["nexus.search"]["value"]
        assert 1 <= len(search_value["matches"]) <= 2
        search_match = next(item for item in search_value["matches"] if item["uri"] == media_uri)
        assert search_value["total_candidates"] >= len(search_value["matches"])
        _assert_canonical_evidence(search_match["evidence"], expected_resource_uri=media_uri)

        read_value = successes["nexus.resource.read"]["value"]
        assert read_value == {
            "evidence": read_value["evidence"],
            "kind": "full",
            "text": body,
            "uri": media_uri,
        }
        _assert_canonical_evidence(read_value["evidence"], expected_resource_uri=media_uri)
        assert (
            read_value["evidence"]["content_sha256"]
            == hashlib.sha256(body.encode("utf-8")).hexdigest()
        )
        empty_read = execute_chat_tool(
            db,
            generation=generation,
            tool_id="nexus.resource.read",
            tool_call_index=6,
            arguments=_read_arguments("nexus.resource.read", empty_uri),
        )
        assert empty_read["type"] == "Success"
        empty_evidence = empty_read["value"]["evidence"]
        assert empty_evidence["content_sha256"] == hashlib.sha256(b"").hexdigest()
        assert empty_evidence["snapshot_revision"] is None

        document_value = successes["nexus.document.search"]["value"]
        assert document_value["uri"] == media_uri
        assert len(document_value["matches"]) == 1
        document_match = document_value["matches"][0]
        assert "singular nebula" in document_match["text"].casefold()
        _assert_canonical_evidence(
            document_match["evidence"],
            expected_resource_uri=document_match["uri"],
        )

        inspect_value = successes["nexus.resource.inspect"]["value"]
        assert inspect_value["uri"] == media_uri
        assert inspect_value["total_sections"] == 1
        assert inspect_value["sections"] == [
            {
                "fragment_id": str(fragment_id),
                "label": "First section",
                "ordinal": 1,
                "page_end": None,
                "page_start": None,
                "parent_label": None,
                "preview": body,
                "read_uri": f"fragment:{fragment_id}",
                "section_kind": "heading",
                "t_end_ms": None,
                "t_start_ms": None,
            }
        ]
        _assert_canonical_evidence(inspect_value["evidence"], expected_resource_uri=media_uri)

        relations_value = successes["nexus.relations.list"]["value"]
        assert relations_value["uri"] == media_uri
        assert relations_value["relations"] == [
            {
                "direction": "outgoing",
                "edge_id": str(relation.id),
                "kind": "supports",
                "machine_authorship": None,
                "rationale": None,
                "source_label": "Admitted evidence atlas",
                "source_uri": media_uri,
                "target_label": "Related evidence atlas",
                "target_uri": related_uri,
            }
        ]
        _assert_canonical_evidence(relations_value["evidence"], expected_resource_uri=media_uri)

        denied: dict[tuple[str, str], dict[str, object]] = {}
        next_index = len(tool_ids) + 2
        for inaccessible_uri in (foreign_uri, missing_uri):
            for tool_id in tool_ids:
                denied[(tool_id, inaccessible_uri)] = execute_chat_tool(
                    db,
                    generation=generation,
                    tool_id=tool_id,
                    tool_call_index=next_index,
                    arguments=_read_arguments(tool_id, inaccessible_uri),
                )
                next_index += 1

        closed_unavailable = {
            "type": "Failure",
            "error": {"type": "ResourceUnavailable"},
        }
        assert tuple(denied.values()) == (closed_unavailable,) * len(denied), (
            "a foreign or nonexistent read exposed a distinguishable failure envelope"
        )

        empty_scope_conversation = conversations.create_conversation(db, owner_id)
        db.commit()
        empty_scope_chat = asyncio.run(
            create_scoped_entitled_chat(
                db,
                conversation_id=empty_scope_conversation.id,
                content="Search without any admitted resources.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=runtime,
                user_id=owner_id,
            )
        )
        empty_scope_run = db.get(ChatRun, empty_scope_chat.run_id)
        assert empty_scope_run is not None
        empty_scope_job_context = claim_running_chat_tool_job(
            db,
            job_id=empty_scope_chat.job_id,
            run=empty_scope_run,
            worker_id=f"read-tools-empty-scope-{uuid4()}",
        )
        empty_scope_generation = compose_chat_tool_generation(
            db,
            operation=operation,
            run=empty_scope_run,
            job_context=empty_scope_job_context,
        )
        no_admission_search = execute_chat_tool(
            db,
            generation=empty_scope_generation,
            tool_id="nexus.search",
            tool_call_index=1,
            arguments={**_search_arguments(media_uri), "scopes": None},
        )
        assert no_admission_search == {
            "type": "Success",
            "value": {"matches": [], "total_candidates": 0},
        }, "an empty admission set fell through to viewer-global search"

        explicit_empty_scope_search = execute_chat_tool(
            db,
            generation=generation,
            tool_id="nexus.search",
            tool_call_index=next_index,
            arguments={**_search_arguments(media_uri), "scopes": []},
        )
        next_index += 1
        assert explicit_empty_scope_search == {
            "type": "Success",
            "value": {"matches": [], "total_candidates": 0},
        }, "an explicit empty scope widened back to conversation defaults"

        oversized_search = execute_chat_tool(
            db,
            generation=generation,
            tool_id="nexus.search",
            tool_call_index=next_index,
            arguments={
                **_search_arguments(oversized_uri),
                "query": "oversized",
            },
        )
        assert oversized_search["type"] == "Success"
        assert oversized_search["value"]["matches"]

        search_policy = operation.plan.catalog_view.binding(ToolId("nexus.search")).policy_inputs[
            "result_policy"
        ]
        assert isinstance(search_policy, Mapping)
        context_chars = search_policy["context_chars"]
        selected_results = search_policy["selected_results"]
        assert isinstance(context_chars, int) and isinstance(selected_results, int)
        oversized_tool_row = db.scalar(
            select(MessageToolCall).where(
                MessageToolCall.assistant_message_id == run.assistant_message_id,
                MessageToolCall.tool_call_index == next_index,
            )
        )
        assert oversized_tool_row is not None
        oversized_retrievals = list(
            db.scalars(
                select(MessageRetrieval)
                .where(MessageRetrieval.tool_call_id == oversized_tool_row.id)
                .order_by(MessageRetrieval.ordinal)
            )
        )
        result_ref_sizes = [
            len(canonical_json_bytes(row.result_ref)) for row in oversized_retrievals
        ]
        assert any(size > context_chars for size in result_ref_sizes), (
            "the fixture did not exceed the frozen Nexus search context budget"
        )
        assert (
            sum(
                size
                for row, size in zip(oversized_retrievals, result_ref_sizes, strict=True)
                if row.selected
            )
            <= context_chars
        )
        assert sum(row.selected for row in oversized_retrievals) <= selected_results
        assert all(
            not row.selected
            for row, size in zip(oversized_retrievals, result_ref_sizes, strict=True)
            if size > context_chars
        ), "an oversized result_ref escaped the frozen prompt context budget"

        rows = list(
            db.scalars(
                select(MessageToolCall)
                .where(MessageToolCall.assistant_message_id == run.assistant_message_id)
                .order_by(MessageToolCall.tool_call_index)
            )
        )
        assert len(rows) == 18
        assert {row.record_kind for row in rows} == {"current_execution"}
        assert all(row.provider_wire_name is not None for row in rows)
        assert all(row.provider_wire_name == row.canonical_tool_id for row in rows)
        assert [row.canonical_tool_id for row in rows[:5]] == list(tool_ids)
        assert rows[5].canonical_tool_id == "nexus.resource.read"
        assert all(row.canonical_input_sha256 for row in rows)
        from nexus.services.tool_authority import read_tool_positions

        positions = read_tool_positions(db, generation_id=generation.generation_id)
        assert len(positions) == len(rows)
        for row in rows:
            assert row.canonical_tool_id is not None
            binding = operation.plan.catalog_view.binding(ToolId(row.canonical_tool_id))
            assert row.tool_contract_revision == binding.spec.tool_contract_revision
            assert row.binding_policy_revision == binding.policy_revision
        for row, position in zip(rows, positions, strict=True):
            assert row.tool_position_id == position.id
            assert position.replay_status == "Completed"

        result_events = list(
            db.scalars(
                select(ChatRunEvent)
                .where(ChatRunEvent.run_id == run.id, ChatRunEvent.event_type == "tool_result")
                .order_by(ChatRunEvent.seq)
            )
        )
        assert len(result_events) == len(rows)
        assert all(event.payload["record_kind"] == "current_execution" for event in result_events)
        assert all("tool_name" not in event.payload for event in result_events)
