"""Closed catalogue and operation-plan composition for Nexus tools."""

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
    ToolSpec,
    Unavailable,
    WebSearchProvider,
    bind_brave_web_search,
    bind_web_read,
    web_family,
)
from provider_runtime.agent_runtime import (
    CredentialRef,
)
from provider_runtime.agent_runtime.tool_projection import (
    McpToolPublication,
    PublishedMcpTools,
    lower_mcp_tools,
)
from provider_runtime.tool_adapter import PublishedTools, ToolPublication, lower_tools
from pydantic import ValidationError

from nexus.config import Settings
from nexus.services.tool_runtime.declarations import (
    CHAT_TOOL_DECLARATIONS_BY_ID,
    NEXUS_TOOL_DECLARATIONS,
    PresentedToolDeclaration,
)
from nexus.services.tool_runtime.profiles import (
    TOOL_PLAN_DEFINITIONS,
    ToolPlanDefinition,
)
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


_WEB_SEARCH_POLICY_INPUTS: Final[Mapping[str, object]] = MappingProxyType(
    {
        "context_chars": 12_000,
        "locale": "US/en",
        "max_results": 6,
        "safe_search": "moderate",
        "selected_results": 5,
    }
)


def _validate_binding_metadata(
    web_search_binding: ToolBinding[Any, Any, Any],
    web_read_binding: ToolBinding[Any, Any, Any],
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...],
) -> None:
    if web_search_binding.spec is not WEB_SEARCH_SPEC:
        raise ValueError("web.search binding must own the imported declaration")
    if web_search_binding.replay_policy is not ReplayPolicy.BilledOnce:
        raise ValueError("web.search must remain BilledOnce")
    if web_read_binding.spec is not WEB_READ_SPEC:
        raise ValueError("web.read binding must own the imported declaration")
    if web_read_binding.replay_policy is not ReplayPolicy.ReDispatchable:
        raise ValueError("web.read must remain ReDispatchable")
    for binding in nexus_bindings:
        if (
            binding.spec.effect is ToolEffect.Write
            and binding.replay_policy is not ReplayPolicy.ReDispatchable
        ):
            raise ValueError(f"Nexus write lacks replay metadata: {binding.spec.id!s}")
        if binding.replay_policy is not ReplayPolicy.ReDispatchable:
            raise ValueError(f"Nexus binding must be ReDispatchable: {binding.spec.id!s}")


def _require_nexus_execution(
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...],
    *,
    available: bool,
) -> None:
    label = "available" if available else "unavailable"
    for binding in nexus_bindings:
        if available and not isinstance(binding.execute, Available):
            raise ValueError(f"Nexus binding must be {label}: {binding.spec.id!s}")
        if not available and not isinstance(binding.execute, Unavailable):
            raise ValueError(f"Nexus binding must be {label}: {binding.spec.id!s}")


def _compose_tool_runtime(
    web_search_binding: ToolBinding[Any, Any, Any],
    *,
    web_read_binding: ToolBinding[Any, Any, Any],
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...],
) -> ComposedToolRuntime:
    _validate_binding_metadata(web_search_binding, web_read_binding, nexus_bindings)
    catalog = ToolCatalog.compose(
        (
            web_family(search=web_search_binding, read=web_read_binding),
            ToolFamily(
                namespace="nexus",
                declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                bindings=nexus_bindings,
            ),
        )
    )

    operations_by_id: dict[str, FrozenToolOperation] = {}
    for definition in TOOL_PLAN_DEFINITIONS:
        profile = definition.profile.freeze(catalog)
        operation = FrozenToolOperation(
            definition=definition,
            profile=profile,
            plan=definition.plan.freeze(catalog, profile),
        )
        _validate_frozen_operation(operation)
        if definition.plan_id in operations_by_id:
            raise ValueError(f"duplicate tool plan id: {definition.plan_id}")
        operations_by_id[definition.plan_id] = operation
    operations = MappingProxyType(operations_by_id)
    return ComposedToolRuntime(catalog=catalog, operations=operations)


def _validate_frozen_operation(operation: FrozenToolOperation) -> None:
    definition = operation.definition
    profile = operation.profile
    plan = operation.plan
    if plan.profile is not profile:
        raise ValueError("frozen tool plan and profile do not share one value")
    expected_ids = tuple(grant.id for grant in definition.profile.grants)
    if tuple(grant.id for grant in profile.ordered_grants) != expected_ids:
        raise ValueError("frozen tool grant order differs from its authority definition")
    write_count = sum(
        plan.catalog_view.spec(tool_id).effect is ToolEffect.Write for tool_id in expected_ids
    )
    if write_count == 0 and definition.max_live_writes is not None:
        raise ValueError("read-only frozen tool plan carries a write-effect bound")
    if write_count > 0 and definition.max_live_writes is None:
        raise ValueError("write-capable frozen tool plan lacks its effect bound")


def operation_tool_specs(
    operation: FrozenToolOperation | None,
) -> tuple[ToolSpec[Any, Any, Any], ...]:
    """Project exact ordered declarations from one frozen authority."""

    if operation is None:
        return ()
    return tuple(
        operation.plan.catalog_view.spec(grant.id) for grant in operation.profile.ordered_grants
    )


def operation_presented_declarations(
    operation: FrozenToolOperation | None,
) -> tuple[PresentedToolDeclaration, ...]:
    """Join plan-owned membership to its canonical presentation metadata."""

    declarations: list[PresentedToolDeclaration] = []
    for spec in operation_tool_specs(operation):
        try:
            entry = CHAT_TOOL_DECLARATIONS_BY_ID[spec.id]
        except KeyError as exc:
            raise ValueError(f"frozen tool lacks presentation metadata: {spec.id!s}") from exc
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


def project_codex_model_tools(
    operation: FrozenToolOperation | None,
    *,
    server_name: str | None = None,
    url: str | None = None,
    bearer: CredentialRef | None = None,
) -> PublishedMcpTools | None:
    """Lower one plan to authenticated Codex MCP configuration."""

    endpoint_supplied = server_name is not None or url is not None or bearer is not None
    if operation is None:
        if endpoint_supplied:
            raise ValueError("NoModelTools forbids MCP endpoint or bearer configuration")
        return None
    if not isinstance(operation.plan.exposure, Native):
        raise ValueError("only Native model-tool plans can be MCP-published")
    if server_name is None or url is None or bearer is None:
        raise ValueError("model-tool MCP publication requires its complete endpoint authority")
    return lower_mcp_tools(
        McpToolPublication(
            plan=operation.plan,
            server_name=server_name,
            url=url,
            bearer=bearer,
        )
    )


def compose_product_tool_runtime(
    web_search_provider: WebSearchProvider | None,
) -> ComposedToolRuntime:
    """Compose one process-owned runtime with stable configured/keyless authority."""

    from nexus.services.tool_runtime.bindings import NEXUS_TOOL_BINDINGS

    if web_search_provider is None:
        portable = ToolCatalog.compose((web_family(),)).binding(WEB_SEARCH_SPEC.id)
        web_search_binding: ToolBinding[Any, Any, Any] = ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Unavailable("Brave credential is absent"),
            replay_policy=ReplayPolicy.BilledOnce,
            implementation_revision=portable.implementation_revision,
            policy_epoch=portable.policy_epoch,
            policy_inputs={**portable.policy_inputs, **_WEB_SEARCH_POLICY_INPUTS},
        )
    else:
        portable = bind_brave_web_search(web_search_provider, max_results=6)
        web_search_binding = ToolBinding(
            spec=portable.spec,
            execute=portable.execute,
            replay_policy=portable.replay_policy,
            implementation_revision=portable.implementation_revision,
            policy_epoch=portable.policy_epoch,
            policy_inputs={**portable.policy_inputs, **_WEB_SEARCH_POLICY_INPUTS},
        )
    _require_nexus_execution(NEXUS_TOOL_BINDINGS, available=True)
    return _compose_tool_runtime(
        web_search_binding,
        web_read_binding=bind_web_read(SafeWebReader()),
        nexus_bindings=NEXUS_TOOL_BINDINGS,
    )


def compose_projection_tool_runtime() -> ComposedToolRuntime:
    """Compose exact plan metadata for a process that never dispatches tools."""

    from nexus.services.tool_runtime.binding_contract import compose_nexus_bindings

    portable = ToolCatalog.compose((web_family(),)).binding(WEB_SEARCH_SPEC.id)
    web_search_binding: ToolBinding[Any, Any, Any] = ToolBinding(
        spec=WEB_SEARCH_SPEC,
        execute=Unavailable("Projection processes do not dispatch web.search"),
        replay_policy=ReplayPolicy.BilledOnce,
        implementation_revision=portable.implementation_revision,
        policy_epoch=portable.policy_epoch,
        policy_inputs={**portable.policy_inputs, **_WEB_SEARCH_POLICY_INPUTS},
    )
    unavailable = Unavailable("Projection processes dispatch Nexus tools through MCP")
    nexus_bindings = compose_nexus_bindings(
        {entry.spec.id: unavailable for entry in NEXUS_TOOL_DECLARATIONS}
    )
    _require_nexus_execution(nexus_bindings, available=False)
    return _compose_tool_runtime(
        web_search_binding,
        web_read_binding=ToolCatalog.compose((web_family(),)).binding(WEB_READ_SPEC.id),
        nexus_bindings=nexus_bindings,
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
    profile_id = str(profile.id)
    return FrozenToolPlanSnapshot(
        exposure=exposure,
        grants=tuple(grants),
        max_live_writes=operation.definition.max_live_writes,
        plan_id=operation.definition.plan_id,
        plan_revision=operation.plan.plan_revision,
        profile_id=profile_id,
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


__all__ = [
    "ComposedToolRuntime",
    "FrozenToolPlanSnapshot",
    "FrozenToolOperation",
    "compose_configured_web_search_provider",
    "compose_provider_model_tools",
    "compose_product_tool_runtime",
    "compose_projection_tool_runtime",
    "encode_tool_plan_snapshot",
    "freeze_tool_plan_snapshot",
    "operation_presented_declarations",
    "operation_tool_specs",
    "project_codex_model_tools",
    "project_provider_model_tools",
    "validate_tool_plan_snapshot",
]
