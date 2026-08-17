"""Closed catalogue and operation-plan composition for Nexus tools."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    FrozenCapabilityProfile,
    FrozenToolPlan,
    ReplayPolicy,
    ToolBinding,
    ToolCatalog,
    ToolEffect,
    ToolFamily,
    web_family,
)

from nexus.services.tool_runtime.bindings import NEXUS_TOOL_BINDINGS
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.profiles import (
    CHAT_TOOL_PLAN,
    CHAT_TOOL_PROFILE,
    IDEA_DOSSIER_RESEARCH_TOOL_PLAN,
    IDEA_DOSSIER_RESEARCH_TOOL_PROFILE,
)


@dataclass(frozen=True, slots=True)
class FrozenToolOperation:
    profile: FrozenCapabilityProfile
    plan: FrozenToolPlan


@dataclass(frozen=True, slots=True)
class ComposedToolRuntime:
    catalog: ToolCatalog
    operations: Mapping[str, FrozenToolOperation]


def _validate_binding_metadata(
    web_search_binding: ToolBinding[Any, Any, Any],
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...],
) -> None:
    if web_search_binding.spec is not WEB_SEARCH_SPEC:
        raise ValueError("web.search binding must own the imported declaration")
    if web_search_binding.replay_policy is not ReplayPolicy.BilledOnce:
        raise ValueError("web.search must remain BilledOnce")
    for binding in nexus_bindings:
        if not isinstance(binding.execute, Available):
            raise ValueError(f"Nexus binding must be available: {binding.spec.id!s}")
        if (
            binding.spec.effect is ToolEffect.Write
            and binding.replay_policy is not ReplayPolicy.ReDispatchable
        ):
            raise ValueError(f"Nexus write lacks replay metadata: {binding.spec.id!s}")
        if binding.replay_policy is not ReplayPolicy.ReDispatchable:
            raise ValueError(f"Nexus binding must be ReDispatchable: {binding.spec.id!s}")


def compose_tool_runtime(
    web_search_binding: ToolBinding[Any, Any, Any],
    *,
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...] = NEXUS_TOOL_BINDINGS,
) -> ComposedToolRuntime:
    """Freeze the exact Chat Native and Idea-research HostTable operations."""

    _validate_binding_metadata(web_search_binding, nexus_bindings)
    catalog = ToolCatalog.compose(
        (
            web_family(search=web_search_binding),
            ToolFamily(
                namespace="nexus",
                declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                bindings=nexus_bindings,
            ),
        )
    )

    chat_profile = CHAT_TOOL_PROFILE.freeze(catalog)
    idea_profile = IDEA_DOSSIER_RESEARCH_TOOL_PROFILE.freeze(catalog)
    operations = MappingProxyType(
        {
            "chat": FrozenToolOperation(
                profile=chat_profile,
                plan=CHAT_TOOL_PLAN.freeze(catalog, chat_profile),
            ),
            "idea_dossier_research": FrozenToolOperation(
                profile=idea_profile,
                plan=IDEA_DOSSIER_RESEARCH_TOOL_PLAN.freeze(catalog, idea_profile),
            ),
        }
    )
    return ComposedToolRuntime(catalog=catalog, operations=operations)


__all__ = [
    "ComposedToolRuntime",
    "FrozenToolOperation",
    "compose_tool_runtime",
]
