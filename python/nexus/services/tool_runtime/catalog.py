"""Closed catalogue, frozen operations, and transport lowering for Nexus tools."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Final

import httpx
from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    Available,
    BraveSearchProvider,
    FrozenCapabilityProfile,
    FrozenToolPlan,
    ReplayPolicy,
    SafeWebReader,
    ToolBinding,
    ToolCatalog,
    ToolEffect,
    ToolFamily,
    WebSearchProvider,
    bind_brave_web_search,
    bind_web_read,
    web_family,
)

from nexus.config import Settings
from nexus.schemas.presence import Presence
from nexus.services.memory_client import MemoryClientConfig
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.plans import TOOL_PLAN_DEFINITIONS, ToolPlanDefinition


@dataclass(frozen=True, slots=True)
class FrozenToolOperation:
    definition: ToolPlanDefinition
    profile: FrozenCapabilityProfile
    plan: FrozenToolPlan


@dataclass(frozen=True, slots=True)
class ComposedToolRuntime:
    catalog: ToolCatalog
    operations: Mapping[str, FrozenToolOperation]
    memory_config: Presence[MemoryClientConfig]


def unavailable_tool_ids(operation: FrozenToolOperation) -> tuple[str, ...]:
    """Report required grants whose composed binding cannot execute."""

    return tuple(
        str(grant.id)
        for grant in operation.profile.ordered_grants
        if not isinstance(operation.plan.catalog_view.binding(grant.id).execute, Available)
    )


WEB_SEARCH_MAX_RESULTS: Final[int] = 6
WEB_SEARCH_SELECTED_RESULTS: Final[int] = 5
WEB_SEARCH_CONTEXT_CHARS: Final[int] = 12_000
_WEB_SEARCH_POLICY_INPUTS: Final[Mapping[str, object]] = MappingProxyType(
    {
        "context_chars": WEB_SEARCH_CONTEXT_CHARS,
        "locale": "US/en",
        "max_results": WEB_SEARCH_MAX_RESULTS,
        "safe_search": "moderate",
        "selected_results": WEB_SEARCH_SELECTED_RESULTS,
    }
)


def compose_tool_runtime(
    web_search_provider: WebSearchProvider | None,
    *,
    embedding_available: bool,
    memory_config: Presence[MemoryClientConfig],
) -> ComposedToolRuntime:
    """Compose the one process-owned runtime."""

    from nexus.services.tool_runtime.bindings import nexus_tool_bindings
    from nexus.services.tool_runtime.memory import memory_family

    portable = ToolCatalog.compose((web_family(),))
    search_source = (
        portable.binding(WEB_SEARCH_SPEC.id)
        if web_search_provider is None
        else bind_brave_web_search(web_search_provider, max_results=WEB_SEARCH_MAX_RESULTS)
    )
    read_source = bind_web_read(SafeWebReader())
    # These four facts come from the pinned llm_tools revision and nothing else
    # in Nexus would notice a flip; invariant 3 depends on both replay policies.
    if search_source.spec is not WEB_SEARCH_SPEC or read_source.spec is not WEB_READ_SPEC:
        raise ValueError("web bindings must own the imported declarations")
    if search_source.replay_policy is not ReplayPolicy.BilledOnce:
        raise ValueError("web.search must remain BilledOnce")
    if read_source.replay_policy is not ReplayPolicy.ReDispatchable:
        raise ValueError("web.read must remain ReDispatchable")

    web_search_binding: ToolBinding[Any, Any, Any] = ToolBinding(
        spec=WEB_SEARCH_SPEC,
        execute=search_source.execute,
        replay_policy=ReplayPolicy.BilledOnce,
        implementation_revision=search_source.implementation_revision,
        policy_epoch=search_source.policy_epoch,
        policy_inputs={**search_source.policy_inputs, **_WEB_SEARCH_POLICY_INPUTS},
    )
    nexus_bindings = nexus_tool_bindings(embedding_available=embedding_available)
    catalog = ToolCatalog.compose(
        (
            web_family(search=web_search_binding, read=read_source),
            ToolFamily(
                namespace="nexus",
                declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                bindings=nexus_bindings,
            ),
            memory_family(memory_config),
        )
    )
    operations: dict[str, FrozenToolOperation] = {}
    for definition in TOOL_PLAN_DEFINITIONS:
        profile = definition.profile.freeze(catalog)
        operation = FrozenToolOperation(
            definition=definition,
            profile=profile,
            plan=definition.plan.freeze(catalog, profile),
        )
        if operation.plan.profile is not profile:
            raise ValueError("frozen tool plan and profile do not share one value")
        if tuple(grant.id for grant in profile.ordered_grants) != tuple(
            grant.id for grant in definition.profile.grants
        ):
            raise ValueError("frozen tool grant order differs from its authority definition")
        operations[definition.plan_id] = operation
    return ComposedToolRuntime(
        catalog=catalog, operations=MappingProxyType(operations), memory_config=memory_config
    )


def compose_configured_web_search_provider(
    client: httpx.AsyncClient,
    *,
    settings: Settings,
) -> WebSearchProvider | None:
    """Bind the sole configured Brave dependency shared by every process."""

    if settings.brave_search_api_key is None:
        return None
    return BraveSearchProvider(
        client,
        api_key=settings.brave_search_api_key,
        base_url=settings.brave_search_base_url,
        timeout_seconds=settings.brave_search_timeout_seconds,
    )


def write_tool_ids() -> tuple[str, ...]:
    """The canonical ids of every additive-write Nexus tool."""

    return tuple(
        str(entry.spec.id)
        for entry in NEXUS_TOOL_DECLARATIONS
        if entry.spec.effect is ToolEffect.Write
    )


__all__ = [
    "WEB_SEARCH_CONTEXT_CHARS",
    "WEB_SEARCH_MAX_RESULTS",
    "WEB_SEARCH_SELECTED_RESULTS",
    "ComposedToolRuntime",
    "FrozenToolOperation",
    "compose_configured_web_search_provider",
    "compose_tool_runtime",
    "unavailable_tool_ids",
    "write_tool_ids",
]
