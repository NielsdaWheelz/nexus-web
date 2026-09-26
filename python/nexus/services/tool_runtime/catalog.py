"""Closed catalogue, frozen operations, and transport lowering for Nexus tools."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final

import httpx
from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    Available,
    BraveSearchProvider,
    FrozenCapabilityProfile,
    FrozenToolPlan,
    HostTable,
    Native,
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
from provider_runtime.tool_adapter import PublishedTools, ToolPublication, lower_tools
from pydantic import ValidationError

from nexus.config import Settings
from nexus.services.tool_runtime.declarations import (
    CHAT_TOOL_DECLARATIONS_BY_ID,
    NEXUS_TOOL_DECLARATIONS,
    PresentedToolDeclaration,
)
from nexus.services.tool_runtime.plans import TOOL_PLAN_DEFINITIONS, ToolPlanDefinition
from nexus.services.tool_runtime.snapshots import (
    FrozenRunLimitsSnapshot,
    FrozenToolExposureSnapshot,
    FrozenToolGrantSnapshot,
    FrozenToolLimitsSnapshot,
    FrozenToolPlanSnapshot,
)

if TYPE_CHECKING:
    from nexus.services.provider_generation_contract import ProviderModelTools


@dataclass(frozen=True, slots=True)
class FrozenToolOperation:
    definition: ToolPlanDefinition
    profile: FrozenCapabilityProfile
    plan: FrozenToolPlan


@dataclass(frozen=True, slots=True)
class ComposedToolRuntime:
    catalog: ToolCatalog
    operations: Mapping[str, FrozenToolOperation]


def required_tool_operation(
    runtime: ComposedToolRuntime, *, plan_id: str, authority_revision: str
) -> FrozenToolOperation:
    """Resolve the reviewed plan shared by catalog and admission."""

    operation = runtime.operations.get(plan_id)
    if operation is None:
        raise ValueError(f"unknown model-tool plan {plan_id!r}")
    if operation.definition.authority_revision != authority_revision:
        raise ValueError(f"model-tool plan {plan_id!r} authority drifted")
    return operation


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


def compose_tool_runtime(web_search_provider: WebSearchProvider | None) -> ComposedToolRuntime:
    """Compose the one process-owned runtime."""

    from nexus.services.tool_runtime.bindings import nexus_tool_bindings

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
    nexus_bindings = nexus_tool_bindings()
    catalog = ToolCatalog.compose(
        (
            web_family(search=web_search_binding, read=read_source),
            ToolFamily(
                namespace="nexus",
                declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                bindings=nexus_bindings,
            ),
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
    return ComposedToolRuntime(catalog=catalog, operations=MappingProxyType(operations))


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


def operation_presented_declarations(
    operation: FrozenToolOperation | None,
) -> tuple[PresentedToolDeclaration, ...]:
    """Join plan-owned membership to its canonical presentation metadata."""

    if operation is None:
        return ()
    declarations: list[PresentedToolDeclaration] = []
    for grant in operation.profile.ordered_grants:
        spec = operation.plan.catalog_view.spec(grant.id)
        entry = CHAT_TOOL_DECLARATIONS_BY_ID.get(str(spec.id))
        if entry is None:
            raise ValueError(f"frozen tool lacks presentation metadata: {spec.id!s}")
        if entry.spec is not spec:
            raise ValueError(f"frozen tool declaration identity drifted: {spec.id!s}")
        declarations.append(entry)
    return tuple(declarations)


def project_provider_model_tools(
    operation: FrozenToolOperation | None,
) -> PublishedTools | None:
    """Lower one plan to API-provider function declarations; ``None`` means no tools."""

    if operation is None:
        return None
    if not isinstance(operation.plan.exposure, Native):
        raise ValueError("only Native model-tool plans can be provider-published")
    return lower_tools(ToolPublication(plan=operation.plan, revealed_targets=()))


def compose_provider_model_tools(operation: FrozenToolOperation) -> ProviderModelTools:
    """Bind provider publication and frozen authority into one route value."""

    from nexus.services.provider_generation_contract import ProviderModelTools

    publication = project_provider_model_tools(operation)
    if publication is None:
        raise ValueError("provider model tools require one Native operation")
    return ProviderModelTools(
        snapshot=freeze_tool_plan_snapshot(operation),
        publication=publication,
    )


def freeze_tool_plan_snapshot(operation: FrozenToolOperation) -> FrozenToolPlanSnapshot:
    """Encode the exact immutable semantic authority used by one tool run."""

    if isinstance(operation.plan.exposure, HostTable):
        exposure = FrozenToolExposureSnapshot(type="HostTable")
    elif isinstance(operation.plan.exposure, Native):
        exposure = FrozenToolExposureSnapshot(type="Native")
    else:
        raise ValueError("operation uses an unsupported tool exposure")
    profile = operation.profile
    if operation.plan.profile is not profile:
        raise ValueError("operation plan and profile do not share one frozen value")
    grants: list[FrozenToolGrantSnapshot] = []
    for grant in profile.ordered_grants:
        binding = operation.plan.catalog_view.binding(grant.id)
        if binding.policy_revision != grant.policy_revision:
            raise ValueError("frozen tool grant changed binding policy after freeze")
        grants.append(
            FrozenToolGrantSnapshot(
                binding_policy_revision=grant.policy_revision,
                id=str(grant.id),
                implementation_revision=grant.implementation_revision,
                limits=FrozenToolLimitsSnapshot.model_validate(grant.limits.json()),
                replay_policy=binding.replay_policy.value,
                tool_contract_revision=grant.tool_contract_revision,
            )
        )
    return FrozenToolPlanSnapshot(
        exposure=exposure,
        grants=tuple(grants),
        max_live_writes=operation.definition.max_live_writes,
        plan_id=operation.definition.plan_id,
        plan_revision=operation.plan.plan_revision,
        profile_id=str(profile.id),
        profile_revision=profile.profile_revision,
        run_limits=FrozenRunLimitsSnapshot.model_validate(profile.run_limits.json()),
    )


def encode_tool_plan_snapshot(operation: FrozenToolOperation) -> str:
    return freeze_tool_plan_snapshot(operation).model_dump_json()


def validate_tool_plan_snapshot(
    raw: str,
    *,
    operation: FrozenToolOperation,
) -> FrozenToolPlanSnapshot:
    """Decode a durable snapshot and reject any semantic authority drift."""

    try:
        decoded = FrozenToolPlanSnapshot.model_validate_json(raw)
    except ValidationError as exc:
        raise ValueError("durable tool plan snapshot is malformed") from exc
    expected = freeze_tool_plan_snapshot(operation)
    if decoded != expected:
        raise ValueError("durable tool plan snapshot differs from current authority")
    return decoded


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
    "FrozenToolPlanSnapshot",
    "compose_configured_web_search_provider",
    "compose_provider_model_tools",
    "compose_tool_runtime",
    "encode_tool_plan_snapshot",
    "freeze_tool_plan_snapshot",
    "operation_presented_declarations",
    "project_provider_model_tools",
    "required_tool_operation",
    "unavailable_tool_ids",
    "validate_tool_plan_snapshot",
    "write_tool_ids",
]
