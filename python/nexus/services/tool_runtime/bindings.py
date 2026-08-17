"""Ordered Nexus bindings over the locally owned tool declarations."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, Protocol

from llm_tools import (
    Available,
    ExecutionContext,
    ExecutorConfigurationDefect,
    HandlerSuccess,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolId,
)

from nexus.services.agent_tools.app_search import (
    APP_SEARCH_CONTEXT_CHARS,
    APP_SEARCH_LIMIT,
    APP_SEARCH_SELECTED_LIMIT,
)
from nexus.services.resource_items.capabilities import (
    RESOURCE_ITEM_CAPABILITIES,
    app_search_scope_schemes,
)
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS


class NexusToolExecutionService(Protocol):
    """Explicit execution owner supplied when the application binds dispatch."""

    async def execute(
        self,
        *,
        tool_id: ToolId,
        value: object,
        context: ExecutionContext,
    ) -> HandlerSuccess[Any]: ...


class _UncomposedNexusToolExecution:
    async def execute(
        self,
        *,
        tool_id: ToolId,
        value: object,
        context: ExecutionContext,
    ) -> HandlerSuccess[Any]:
        del value, context
        raise ExecutorConfigurationDefect(
            f"Nexus execution service is not composed for {tool_id!s}"
        )


def _resource_modes(field: str, absent: str) -> dict[str, object]:
    return {
        scheme: value
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if (value := getattr(capability, field)) != absent
    }


def _link_policy() -> dict[str, object]:
    return {
        scheme: {
            "source": capability.user_relation.user_link_source,
            "target": capability.user_relation.user_link_target,
        }
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.user_relation.user_link_source
        or capability.user_relation.user_link_target != "none"
    }


_POLICY_INPUTS: Final[Mapping[str, Mapping[str, object]]] = {
    "nexus.search": {
        "authorization": "ConversationAdmission+ViewerRead",
        "result_policy": {
            "context_chars": APP_SEARCH_CONTEXT_CHARS,
            "max_results": APP_SEARCH_LIMIT,
            "selected_results": APP_SEARCH_SELECTED_LIMIT,
        },
        "scope_schemes": list(app_search_scope_schemes()),
        "semantic_owner": "AppSearch",
    },
    "nexus.resource.read": {
        "authorization": "ConversationAdmission+ViewerRead",
        "read_modes": _resource_modes("readable", "none"),
        "result_policy": "BoundedCitableText",
        "semantic_owner": "ResourceReadPolicy",
    },
    "nexus.document.search": {
        "authorization": "ConversationAdmission+ViewerRead",
        "read_modes": _resource_modes("readable", "none"),
        "result_policy": "BoundedCitablePassages",
        "semantic_owner": "ScopedDocumentSearch",
    },
    "nexus.resource.inspect": {
        "authorization": "ConversationAdmission+ViewerRead",
        "inspect_modes": _resource_modes("inspectable", "none"),
        "result_policy": "OrderedDocumentMap",
        "semantic_owner": "MediaReadMap",
    },
    "nexus.relations.list": {
        "authorization": "ConversationAdmission+ViewerRead",
        "link_policy": _link_policy(),
        "relation_filtering": "ViewerVisibleOneHop",
        "result_policy": "CitableRelations",
        "semantic_owner": "ResourceGraphConnections",
    },
    "nexus.library.add": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "placement_modes": _resource_modes("library_placement", "None"),
        "result_policy": "ConvergentMembership+Trust+Undo",
        "semantic_owner": "LibraryEntries",
    },
    "nexus.note.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "AdditiveNote+Trust+Undo",
        "semantic_owner": "DailyNotes",
        "target_schemes": ["page"],
    },
    "nexus.highlight.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "ExactQuote+Trust+Undo",
        "semantic_owner": "Highlights",
        "target_schemes": ["media"],
    },
    "nexus.edge.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "link_policy": _link_policy(),
        "result_policy": "AdditiveEdge+Trust+Undo",
        "semantic_owner": "ResourceGraphEdges",
    },
    "nexus.queue.add": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "ConvergentQueueEntry+Trust+Undo",
        "semantic_owner": "ConsumptionQueue",
        "target_schemes": ["media"],
    },
}


def bind_nexus_tools(
    execution: NexusToolExecutionService,
) -> tuple[ToolBinding[Any, Any, Any], ...]:
    """Bind every declaration to one explicit application execution owner."""

    declaration_ids = tuple(str(entry.spec.id) for entry in NEXUS_TOOL_DECLARATIONS)
    if tuple(_POLICY_INPUTS) != declaration_ids:
        raise ExecutorConfigurationDefect(
            "Nexus binding policy does not cover declarations exactly"
        )

    bindings: list[ToolBinding[Any, Any, Any]] = []
    for entry in NEXUS_TOOL_DECLARATIONS:
        tool_id = entry.spec.id

        async def handler(
            value: object,
            context: ExecutionContext,
            *,
            _tool_id: ToolId = tool_id,
        ) -> HandlerSuccess[Any]:
            return await execution.execute(tool_id=_tool_id, value=value, context=context)

        bindings.append(
            ToolBinding(
                spec=entry.spec,
                execute=Available(handler),
                replay_policy=ReplayPolicy.ReDispatchable,
                policy_epoch=PolicyEpoch("nexus-v1"),
                policy_inputs=_POLICY_INPUTS[str(tool_id)],
            )
        )
    return tuple(bindings)


# The declaration/profile boundary is executable-shaped but deliberately cannot
# dispatch until the application composes its explicit execution service.
NEXUS_TOOL_BINDINGS = bind_nexus_tools(_UncomposedNexusToolExecution())


__all__ = [
    "NEXUS_TOOL_BINDINGS",
    "NexusToolExecutionService",
    "bind_nexus_tools",
]
