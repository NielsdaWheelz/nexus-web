"""Executable tool identity is part of every persisted model grant."""

import json
from dataclasses import replace

import pytest
from llm_tools import WEB_SEARCH_SPEC, ToolCatalog, web_family

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
        "bearer authority ignored a handler implementation change with unchanged tool schema"
    )
    with pytest.raises(ValueError, match="differs from current authority"):
        validate_tool_plan_snapshot(snapshot.model_dump_json(), operation=second)
