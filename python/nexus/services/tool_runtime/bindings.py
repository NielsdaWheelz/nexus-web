"""Executable Nexus bindings over the canonical binding contract."""

from __future__ import annotations

from typing import Any, Protocol

from llm_tools import (
    Available,
    ExecutionContext,
    HandlerSuccess,
    ToolBinding,
    ToolId,
)

from nexus.services.tool_runtime.binding_contract import (
    NexusToolAvailability,
    compose_nexus_bindings,
)
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.execution import NexusToolExecution


class NexusToolExecutionService(Protocol):
    """Explicit execution owner supplied when the application binds dispatch."""

    async def execute(
        self,
        *,
        tool_id: ToolId,
        value: object,
        context: ExecutionContext,
    ) -> HandlerSuccess[Any]: ...


def bind_nexus_tools(
    execution: NexusToolExecutionService,
) -> tuple[ToolBinding[Any, Any, Any], ...]:
    """Bind every declaration to one explicit application execution owner."""

    availability_by_id: dict[ToolId, NexusToolAvailability] = {}
    for entry in NEXUS_TOOL_DECLARATIONS:
        tool_id = entry.spec.id

        async def handler(
            value: object,
            context: ExecutionContext,
            *,
            _tool_id: ToolId = tool_id,
        ) -> HandlerSuccess[Any]:
            return await execution.execute(tool_id=_tool_id, value=value, context=context)

        availability_by_id[tool_id] = Available(handler)
    return compose_nexus_bindings(availability_by_id)


NEXUS_TOOL_BINDINGS = bind_nexus_tools(NexusToolExecution())


__all__ = [
    "NEXUS_TOOL_BINDINGS",
    "NexusToolExecutionService",
    "bind_nexus_tools",
]
