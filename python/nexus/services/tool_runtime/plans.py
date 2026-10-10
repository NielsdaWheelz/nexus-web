"""Operation-owned Nexus capability profiles and presentation plans.

This module is the dependency-light semantic owner for model-tool plans. It
does not compose bindings or read process configuration. Runtime composition
freezes these definitions against one catalogue so schemas, effects, per-tool
limits, revisions, and transport publication all originate from the resulting
``FrozenToolPlan``.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Final, Literal

from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    CapabilityProfile,
    HostTable,
    Native,
    ProfileId,
    RunLimits,
    ToolEffect,
    ToolGrant,
    ToolId,
    ToolPlan,
    ToolSpec,
    canonical_json_bytes,
)
from universal_memory.tools import MEMORY_READ_IDS, MEMORY_READ_SPECS, MEMORY_SAVE_NOTE_SPEC

from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.plan_revisions import TOOL_PLAN_AUTHORITY_REVISIONS

type ToolExposureName = Literal["HostTable", "Native"]

_NEXUS_READ_TOOL_IDS: Final[tuple[ToolId, ...]] = tuple(
    ToolId(value)
    for value in (
        "nexus.search",
        "nexus.resource.read",
        "nexus.document.search",
        "nexus.resource.inspect",
        "nexus.relations.list",
    )
)
_NEXUS_ADDITIVE_WRITE_TOOL_IDS: Final[tuple[ToolId, ...]] = tuple(
    ToolId(value)
    for value in (
        "nexus.library.add",
        "nexus.note.create",
        "nexus.highlight.create",
        "nexus.edge.create",
        "nexus.queue.add",
    )
)


def _closed_tool_specs() -> MappingProxyType[ToolId, ToolSpec[Any, Any, Any]]:
    specs = (
        WEB_SEARCH_SPEC,
        WEB_READ_SPEC,
        *(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
        *MEMORY_READ_SPECS,
        MEMORY_SAVE_NOTE_SPEC,
    )
    if len({spec.id for spec in specs}) != len(specs):
        raise ValueError("model-tool declarations contain a duplicate canonical id")
    return MappingProxyType({spec.id: spec for spec in specs})


_TOOL_SPECS = _closed_tool_specs()


@dataclass(frozen=True, slots=True)
class ToolPlanDefinition:
    """One reviewed plan definition before binding-policy freeze."""

    plan_id: str
    profile: CapabilityProfile
    plan: ToolPlan
    max_live_writes: int | None
    authority_revision: str = field(init=False)

    def __post_init__(self) -> None:
        if not self.plan_id:
            raise ValueError("tool plan id must not be empty")
        if self.plan.profile != self.profile.id:
            raise ValueError("tool plan and capability profile ids differ")
        grant_ids = tuple(grant.id for grant in self.profile.grants)
        if len(set(grant_ids)) != len(grant_ids):
            raise ValueError("tool plan grants must be unique")
        try:
            specs = tuple(_TOOL_SPECS[tool_id] for tool_id in grant_ids)
        except KeyError as exc:
            raise ValueError("tool plan references an undeclared tool") from exc
        write_count = sum(spec.effect is ToolEffect.Write for spec in specs)
        if write_count == 0 and self.max_live_writes is not None:
            raise ValueError("read-only tool plans cannot carry a write-effect bound")
        if write_count > 0 and (type(self.max_live_writes) is not int or self.max_live_writes < 1):
            raise ValueError("write-capable tool plans require a positive live-write bound")
        semantic = _definition_json(
            plan_id=self.plan_id,
            profile=self.profile,
            plan=self.plan,
            max_live_writes=self.max_live_writes,
        )
        object.__setattr__(
            self,
            "authority_revision",
            hashlib.sha256(canonical_json_bytes(semantic)).hexdigest(),
        )


def _exposure_name(plan: ToolPlan) -> ToolExposureName:
    if isinstance(plan.exposure, Native):
        return "Native"
    if isinstance(plan.exposure, HostTable):
        return "HostTable"
    raise ValueError("Nexus tool plan has an unsupported exposure")


def _definition_json(
    *,
    plan_id: str,
    profile: CapabilityProfile,
    plan: ToolPlan,
    max_live_writes: int | None,
) -> dict[str, object]:
    grants: list[dict[str, object]] = []
    for grant in profile.grants:
        spec = _TOOL_SPECS[grant.id]
        effective_limits = grant.limits or spec.limits
        grants.append(
            {
                "effect": spec.effect.value,
                "id": str(grant.id),
                "limits": effective_limits.json(),
                "tool_contract_revision": spec.tool_contract_revision,
            }
        )
    return {
        "exposure": _exposure_name(plan),
        "grants": grants,
        "max_live_writes": max_live_writes,
        "plan_id": plan_id,
        "profile_id": str(profile.id),
        "run_limits": profile.run_limits.json(),
    }


def _definition(
    plan_id: str,
    profile_id: str,
    tool_ids: tuple[ToolId, ...],
    run_limits: RunLimits,
    *,
    exposure: ToolExposureName,
    max_live_writes: int | None = None,
) -> ToolPlanDefinition:
    profile = CapabilityProfile(
        id=ProfileId(profile_id),
        grants=tuple(ToolGrant(id=tool_id, limits=None) for tool_id in tool_ids),
        run_limits=run_limits,
    )
    plan = ToolPlan(
        profile=profile.id,
        exposure={"Native": Native, "HostTable": HostTable}[exposure](),
    )
    return ToolPlanDefinition(
        plan_id=plan_id,
        profile=profile,
        plan=plan,
        max_live_writes=max_live_writes,
    )


_NATIVE_RUN_LIMITS: Final[RunLimits] = RunLimits(
    max_calls=None,
    max_external_attempts=None,
    max_input_bytes=None,
    max_output_bytes=None,
    max_in_flight=1,
    max_elapsed_seconds=None,
)

CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "ChatReadAdditiveWrite",
    "chat_read_additive_write",
    (WEB_SEARCH_SPEC.id, WEB_READ_SPEC.id, *_NEXUS_READ_TOOL_IDS, *_NEXUS_ADDITIVE_WRITE_TOOL_IDS),
    _NATIVE_RUN_LIMITS,
    exposure="Native",
    max_live_writes=8,
)
CHAT_MEMORY_READ_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "ChatMemoryRead",
    "chat_memory_read",
    (
        WEB_SEARCH_SPEC.id,
        WEB_READ_SPEC.id,
        *_NEXUS_READ_TOOL_IDS,
        *_NEXUS_ADDITIVE_WRITE_TOOL_IDS,
        *MEMORY_READ_IDS,
    ),
    _NATIVE_RUN_LIMITS,
    exposure="Native",
    max_live_writes=8,
)
CHAT_MEMORY_READ_SAVE_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "ChatMemoryReadSave",
    "chat_memory_read_save",
    (
        WEB_SEARCH_SPEC.id,
        WEB_READ_SPEC.id,
        *_NEXUS_READ_TOOL_IDS,
        *_NEXUS_ADDITIVE_WRITE_TOOL_IDS,
        *MEMORY_READ_IDS,
        MEMORY_SAVE_NOTE_SPEC.id,
    ),
    _NATIVE_RUN_LIMITS,
    exposure="Native",
    max_live_writes=8,
)
METADATA_RESEARCH_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "MetadataResearch",
    "metadata_research",
    (
        ToolId("nexus.document.search"),
        ToolId("nexus.resource.read"),
        WEB_SEARCH_SPEC.id,
        WEB_READ_SPEC.id,
    ),
    _NATIVE_RUN_LIMITS,
    exposure="Native",
)
NO_MODEL_TOOLS_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "NoModelTools",
    "no_model_tools",
    (),
    _NATIVE_RUN_LIMITS,
    exposure="Native",
)

TOOL_PLAN_DEFINITIONS: Final[tuple[ToolPlanDefinition, ...]] = (
    METADATA_RESEARCH_TOOL_DEFINITION,
    NO_MODEL_TOOLS_DEFINITION,
    CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION,
    CHAT_MEMORY_READ_TOOL_DEFINITION,
    CHAT_MEMORY_READ_SAVE_TOOL_DEFINITION,
)
_computed_authority_revisions = {
    definition.plan_id: definition.authority_revision for definition in TOOL_PLAN_DEFINITIONS
}
if _computed_authority_revisions != dict(TOOL_PLAN_AUTHORITY_REVISIONS):
    raise ValueError("tool plan definitions differ from the reviewed authority-revision lock")
if len({definition.plan_id for definition in TOOL_PLAN_DEFINITIONS}) != len(TOOL_PLAN_DEFINITIONS):
    raise ValueError("tool plan definitions contain a duplicate plan id")
if len({definition.profile.id for definition in TOOL_PLAN_DEFINITIONS}) != len(
    TOOL_PLAN_DEFINITIONS
):
    raise ValueError("tool plan definitions contain a duplicate profile id")
TOOL_PLAN_DEFINITIONS_BY_ID: Final[MappingProxyType[str, ToolPlanDefinition]] = MappingProxyType(
    {definition.plan_id: definition for definition in TOOL_PLAN_DEFINITIONS}
)


__all__ = [
    "METADATA_RESEARCH_TOOL_DEFINITION",
    "NO_MODEL_TOOLS_DEFINITION",
    "CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION",
    "CHAT_MEMORY_READ_TOOL_DEFINITION",
    "CHAT_MEMORY_READ_SAVE_TOOL_DEFINITION",
    "TOOL_PLAN_DEFINITIONS",
    "TOOL_PLAN_DEFINITIONS_BY_ID",
    "ToolPlanDefinition",
]
