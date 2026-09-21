"""Canonical Nexus binding contract and its executable availability."""

from __future__ import annotations

from collections.abc import Mapping
from functools import partial
from typing import Any

from llm_tools import (
    Available,
    ExecutorConfigurationDefect,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolId,
    Unavailable,
)

from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.handlers import execute_nexus_tool

type NexusToolAvailability = Available[Any] | Unavailable

# Rotate when a handler or its transitive domain behavior changes.
_IMPLEMENTATION_REVISION = "nexus-tools.v3"
_POLICY_EPOCH = PolicyEpoch("nexus-v1")


def compose_nexus_bindings(
    availability_by_id: Mapping[ToolId, NexusToolAvailability],
) -> tuple[ToolBinding[Any, Any, Any], ...]:
    """Attach one explicit availability owner to the canonical binding contract."""

    if set(availability_by_id) != {entry.spec.id for entry in NEXUS_TOOL_DECLARATIONS}:
        raise ExecutorConfigurationDefect(
            "Nexus binding availability does not cover declarations exactly"
        )
    return tuple(
        ToolBinding(
            spec=entry.spec,
            execute=availability_by_id[entry.spec.id],
            replay_policy=ReplayPolicy.ReDispatchable,
            implementation_revision=_IMPLEMENTATION_REVISION,
            policy_epoch=_POLICY_EPOCH,
            policy_inputs={},
        )
        for entry in NEXUS_TOOL_DECLARATIONS
    )


def nexus_tool_bindings() -> tuple[ToolBinding[Any, Any, Any], ...]:
    """The executable bindings used by every process that dispatches tools."""

    return compose_nexus_bindings(
        {
            entry.spec.id: Available(partial(execute_nexus_tool, tool_id=entry.spec.id))
            for entry in NEXUS_TOOL_DECLARATIONS
        }
    )


__all__ = ["NexusToolAvailability", "compose_nexus_bindings", "nexus_tool_bindings"]
