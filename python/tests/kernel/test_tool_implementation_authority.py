"""Executable tool identity is part of every persisted model grant."""

import json
from dataclasses import replace

import pytest
from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    Available,
    Native,
    ToolCatalog,
    Unavailable,
    web_family,
)

from nexus.services.tool_runtime.bindings import NEXUS_TOOL_BINDINGS


def test_frozen_tool_snapshot_and_bearer_digest_bind_handler_implementation() -> None:
    """A handler change cannot reuse authority with unchanged schemas and policy."""
    from nexus.services.tool_authority import tool_binding_revisions_digest
    from nexus.services.tool_runtime.composition import (
        compose_tool_runtime,
        freeze_tool_plan_snapshot,
        validate_tool_plan_snapshot,
    )

    web = ToolCatalog.compose((web_family(),)).binding(WEB_SEARCH_SPEC.id)
    bindings = NEXUS_TOOL_BINDINGS
    first = compose_tool_runtime(web, nexus_bindings=bindings).operations["LibraryDossierRead"]
    snapshot = freeze_tool_plan_snapshot(first)
    assert all(grant.implementation_revision == "nexus-tools.v2" for grant in snapshot.grants)
    changed = (
        replace(
            bindings[0],
            implementation_revision="reviewed-new-handler.v2",
            # ToolBinding accepts plain JSON inputs and exposes frozen metadata.
            policy_inputs=json.loads(json.dumps(bindings[0].policy_inputs, default=dict)),
        ),
        *bindings[1:],
    )
    assert changed[0].policy_revision == bindings[0].policy_revision
    second = compose_tool_runtime(web, nexus_bindings=changed).operations["LibraryDossierRead"]
    updated = freeze_tool_plan_snapshot(second)
    assert tool_binding_revisions_digest(snapshot) != tool_binding_revisions_digest(updated), (
        "tool grant digest ignored a handler implementation change with unchanged tool schema"
    )
    with pytest.raises(ValueError, match="differs from current authority"):
        validate_tool_plan_snapshot(snapshot.model_dump_json(), operation=second)


def test_projection_runtime_preserves_exact_authority_without_local_execution() -> None:
    """The credential host may project durable plans but must not own dispatch."""

    from nexus.services.tool_runtime.composition import (
        compose_product_tool_runtime,
        compose_projection_tool_runtime,
        freeze_tool_plan_snapshot,
    )

    executable = compose_product_tool_runtime(None)
    projection = compose_projection_tool_runtime()

    assert tuple(projection.operations) == tuple(executable.operations)
    assert {
        plan_id: freeze_tool_plan_snapshot(operation)
        for plan_id, operation in projection.operations.items()
    } == {
        plan_id: freeze_tool_plan_snapshot(operation)
        for plan_id, operation in executable.operations.items()
    }
    assert all(
        isinstance(projection.catalog.binding(tool_id).execute, Unavailable)
        for tool_id in projection.catalog.tool_ids
    )


def test_metadata_has_only_bounded_scoped_reads_and_the_pinned_web_reader() -> None:
    from nexus.services.tool_runtime.composition import (
        compose_product_tool_runtime,
        freeze_tool_plan_snapshot,
    )

    runtime = compose_product_tool_runtime(None)
    operation = runtime.operations["MetadataRead"]
    snapshot = freeze_tool_plan_snapshot(operation)
    assert [grant.id for grant in snapshot.grants] == [
        "web.search",
        "web.read",
        "nexus.document.search",
        "nexus.resource.read",
    ]
    assert isinstance(operation.plan.exposure, Native)
    assert snapshot.run_limits.model_dump() == {
        "max_calls": 8,
        "max_external_attempts": 64,
        "max_input_bytes": 262_144,
        "max_output_bytes": 4_194_304,
        "max_in_flight": 1,
        "max_elapsed_seconds": 120.0,
    }
    reader = runtime.catalog.binding(WEB_READ_SPEC.id)
    assert isinstance(reader.execute, Available)
    assert reader.implementation_revision == "llm-tools-web-read-v2"
    assert all(
        grant.id != "web.read"
        for grant in freeze_tool_plan_snapshot(runtime.operations["ChatRead"]).grants
    )
