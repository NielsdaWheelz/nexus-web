"""Closed catalogue and operation-plan composition for Nexus tools."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Final, Literal

import httpx
from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    BraveSearchProvider,
    FrozenCapabilityProfile,
    FrozenToolPlan,
    HostTable,
    Native,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolCatalog,
    ToolEffect,
    ToolFamily,
    Unavailable,
    WebSearchProvider,
    bind_brave_web_search,
    web_family,
)
from pydantic import BaseModel, ConfigDict, ValidationError

from nexus.config import Settings
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


class _FrozenSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class FrozenToolLimitsSnapshot(_FrozenSnapshot):
    deadline_seconds: float
    max_attempts: int
    max_input_bytes: int
    max_output_bytes: int


class FrozenRunLimitsSnapshot(_FrozenSnapshot):
    max_calls: int
    max_elapsed_seconds: float
    max_external_attempts: int
    max_in_flight: int
    max_input_bytes: int
    max_output_bytes: int


class FrozenToolGrantSnapshot(_FrozenSnapshot):
    binding_policy_revision: str
    id: str
    limits: FrozenToolLimitsSnapshot
    replay_policy: Literal["BilledOnce", "ReDispatchable"]
    tool_contract_revision: str


class FrozenToolExposureSnapshot(_FrozenSnapshot):
    type: Literal["HostTable", "Native"]


class FrozenToolPlanSnapshot(_FrozenSnapshot):
    exposure: FrozenToolExposureSnapshot
    grants: tuple[FrozenToolGrantSnapshot, ...]
    plan_id: str
    plan_revision: str
    profile_id: str
    profile_revision: str
    run_limits: FrozenRunLimitsSnapshot


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


def compose_product_tool_runtime(
    web_search_provider: WebSearchProvider | None,
) -> ComposedToolRuntime:
    """Compose one process-owned runtime with stable configured/keyless authority."""

    if web_search_provider is None:
        web_search_binding: ToolBinding[Any, Any, Any] = ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Unavailable("Brave credential is absent"),
            replay_policy=ReplayPolicy.BilledOnce,
            policy_epoch=PolicyEpoch("web-search-v1"),
            policy_inputs=_WEB_SEARCH_POLICY_INPUTS,
        )
    else:
        portable = bind_brave_web_search(web_search_provider, max_results=6)
        web_search_binding = ToolBinding(
            spec=portable.spec,
            execute=portable.execute,
            replay_policy=portable.replay_policy,
            policy_epoch=portable.policy_epoch,
            policy_inputs=_WEB_SEARCH_POLICY_INPUTS,
        )
    return compose_tool_runtime(web_search_binding)


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
            raise ValueError("HostTable grant changed binding policy after freeze")
        grants.append(
            FrozenToolGrantSnapshot(
                binding_policy_revision=grant.policy_revision,
                id=str(grant.id),
                limits=FrozenToolLimitsSnapshot.model_validate(grant.limits.json()),
                replay_policy=binding.replay_policy.value,
                tool_contract_revision=grant.tool_contract_revision,
            )
        )
    profile_id = str(profile.id)
    return FrozenToolPlanSnapshot(
        exposure=exposure,
        grants=tuple(grants),
        plan_id=profile_id,
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
    "compose_product_tool_runtime",
    "compose_tool_runtime",
    "encode_tool_plan_snapshot",
    "freeze_tool_plan_snapshot",
    "validate_tool_plan_snapshot",
]
