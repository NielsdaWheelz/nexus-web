"""Executable Nexus bindings over the canonical binding contract."""

from __future__ import annotations

from typing import Any

from llm_tools import (
    Available,
    ExecutionContext,
    HandlerSuccess,
    ToolId,
)

from nexus.services.tool_runtime.binding_contract import (
    NexusToolAvailability,
    compose_nexus_bindings,
)
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.execution import NexusToolExecution

_EXECUTION = NexusToolExecution()
_AVAILABILITY_BY_ID: dict[ToolId, NexusToolAvailability] = {}
for _entry in NEXUS_TOOL_DECLARATIONS:

    async def _handler(
        value: object,
        context: ExecutionContext,
        *,
        _tool_id: ToolId = _entry.spec.id,
    ) -> HandlerSuccess[Any]:
        return await _EXECUTION.execute(tool_id=_tool_id, value=value, context=context)

    _AVAILABILITY_BY_ID[_entry.spec.id] = Available(_handler)

NEXUS_TOOL_BINDINGS = compose_nexus_bindings(_AVAILABILITY_BY_ID)


__all__ = ["NEXUS_TOOL_BINDINGS"]
