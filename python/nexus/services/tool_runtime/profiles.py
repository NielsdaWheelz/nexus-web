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
    ToolLimits,
    ToolPlan,
    ToolSpec,
    canonical_json_bytes,
)

from nexus.services.tool_runtime.authority import TOOL_PLAN_AUTHORITY_REVISIONS
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS

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
_MODEL_TOOL_PLAN_IDS: Final[tuple[str, ...]] = (
    "ChatRead",
    "ChatReadAdditiveWrite",
    "LibraryDossierRead",
    "IdeaDossierRead",
    "MetadataRead",
)


def _closed_tool_specs() -> MappingProxyType[ToolId, ToolSpec[Any, Any, Any]]:
    specs = (WEB_SEARCH_SPEC, WEB_READ_SPEC, *(entry.spec for entry in NEXUS_TOOL_DECLARATIONS))
    if len({spec.id for spec in specs}) != len(specs):
        raise ValueError("model-tool declarations contain a duplicate canonical id")
    return MappingProxyType({spec.id: spec for spec in specs})


_TOOL_SPECS = _closed_tool_specs()


@dataclass(frozen=True, slots=True)
class ToolGrantPolicyFacts:
    """Immutable semantic facts covered by one plan-definition revision."""

    effect: ToolEffect
    id: ToolId
    limits: ToolLimits
    tool_contract_revision: str

    def json(self) -> dict[str, object]:
        return {
            "effect": self.effect.value,
            "id": str(self.id),
            "limits": self.limits.json(),
            "tool_contract_revision": self.tool_contract_revision,
        }


@dataclass(frozen=True, slots=True)
class ToolPlanPolicyFacts:
    """Pure policy projection; safe to hash without composing runtime bindings."""

    authority_revision: str
    exposure: ToolExposureName
    grants: tuple[ToolGrantPolicyFacts, ...]
    max_live_writes: int | None
    plan_id: str
    profile_id: str
    run_limits: RunLimits

    def json(self) -> dict[str, object]:
        return {
            "authority_revision": self.authority_revision,
            "exposure": self.exposure,
            "grants": [grant.json() for grant in self.grants],
            "max_live_writes": self.max_live_writes,
            "plan_id": self.plan_id,
            "profile_id": self.profile_id,
            "run_limits": self.run_limits.json(),
        }


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

    def policy_facts(self) -> ToolPlanPolicyFacts:
        return ToolPlanPolicyFacts(
            authority_revision=self.authority_revision,
            exposure=_exposure_name(self.plan),
            grants=tuple(
                ToolGrantPolicyFacts(
                    effect=(spec := _TOOL_SPECS[grant.id]).effect,
                    id=grant.id,
                    limits=grant.limits or spec.limits,
                    tool_contract_revision=spec.tool_contract_revision,
                )
                for grant in self.profile.grants
            ),
            max_live_writes=self.max_live_writes,
            plan_id=self.plan_id,
            profile_id=str(self.profile.id),
            run_limits=self.profile.run_limits,
        )


def _exposure_name(plan: ToolPlan) -> ToolExposureName:
    if isinstance(plan.exposure, Native):
        return "Native"
    if isinstance(plan.exposure, HostTable):
        return "HostTable"
    raise ValueError("Nexus tool plans support only Native or HostTable exposure")


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
        exposure=Native() if exposure == "Native" else HostTable(),
    )
    return ToolPlanDefinition(
        plan_id=plan_id,
        profile=profile,
        plan=plan,
        max_live_writes=max_live_writes,
    )


_CHAT_RUN_LIMITS: Final[RunLimits] = RunLimits(
    max_calls=64,
    max_external_attempts=128,
    max_input_bytes=4_194_304,
    max_output_bytes=16_777_216,
    max_in_flight=1,
    max_elapsed_seconds=900.0,
)

CHAT_READ_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "ChatRead",
    "chat_read",
    (WEB_SEARCH_SPEC.id, *_NEXUS_READ_TOOL_IDS),
    _CHAT_RUN_LIMITS,
    exposure="Native",
)
CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "ChatReadAdditiveWrite",
    "chat_read_additive_write",
    (WEB_SEARCH_SPEC.id, *_NEXUS_READ_TOOL_IDS, *_NEXUS_ADDITIVE_WRITE_TOOL_IDS),
    _CHAT_RUN_LIMITS,
    exposure="Native",
    max_live_writes=8,
)
LIBRARY_DOSSIER_READ_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "LibraryDossierRead",
    "library_dossier_read",
    _NEXUS_READ_TOOL_IDS,
    RunLimits(
        max_calls=16,
        max_external_attempts=0,
        max_input_bytes=262_144,
        max_output_bytes=4_194_304,
        max_in_flight=1,
        max_elapsed_seconds=120.0,
    ),
    exposure="Native",
)
IDEA_DOSSIER_READ_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "IdeaDossierRead",
    "idea_dossier_read",
    _NEXUS_READ_TOOL_IDS,
    RunLimits(
        max_calls=12,
        max_external_attempts=0,
        max_input_bytes=131_072,
        max_output_bytes=2_097_152,
        max_in_flight=1,
        max_elapsed_seconds=120.0,
    ),
    exposure="Native",
)
IDEA_DOSSIER_RESEARCH_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "idea_dossier_research",
    "idea_dossier_research",
    (WEB_SEARCH_SPEC.id,),
    RunLimits(
        max_calls=3,
        max_external_attempts=6,
        max_input_bytes=12_288,
        max_output_bytes=98_304,
        max_in_flight=1,
        max_elapsed_seconds=60.0,
    ),
    exposure="HostTable",
)

METADATA_READ_TOOL_DEFINITION: Final[ToolPlanDefinition] = _definition(
    "MetadataRead",
    "metadata_read",
    (
        WEB_SEARCH_SPEC.id,
        WEB_READ_SPEC.id,
        ToolId("nexus.document.search"),
        ToolId("nexus.resource.read"),
    ),
    RunLimits(
        max_calls=8,
        max_external_attempts=64,
        max_input_bytes=262_144,
        max_output_bytes=4_194_304,
        max_in_flight=1,
        max_elapsed_seconds=120.0,
    ),
    exposure="Native",
)

TOOL_PLAN_DEFINITIONS: Final[tuple[ToolPlanDefinition, ...]] = (
    CHAT_READ_TOOL_DEFINITION,
    CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION,
    LIBRARY_DOSSIER_READ_TOOL_DEFINITION,
    IDEA_DOSSIER_READ_TOOL_DEFINITION,
    IDEA_DOSSIER_RESEARCH_TOOL_DEFINITION,
    METADATA_READ_TOOL_DEFINITION,
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

CHAT_READ_TOOL_PROFILE = CHAT_READ_TOOL_DEFINITION.profile
CHAT_READ_TOOL_PLAN = CHAT_READ_TOOL_DEFINITION.plan
CHAT_READ_ADDITIVE_WRITE_TOOL_PROFILE = CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION.profile
CHAT_READ_ADDITIVE_WRITE_TOOL_PLAN = CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION.plan
LIBRARY_DOSSIER_READ_TOOL_PROFILE = LIBRARY_DOSSIER_READ_TOOL_DEFINITION.profile
LIBRARY_DOSSIER_READ_TOOL_PLAN = LIBRARY_DOSSIER_READ_TOOL_DEFINITION.plan
IDEA_DOSSIER_READ_TOOL_PROFILE = IDEA_DOSSIER_READ_TOOL_DEFINITION.profile
IDEA_DOSSIER_READ_TOOL_PLAN = IDEA_DOSSIER_READ_TOOL_DEFINITION.plan
IDEA_DOSSIER_RESEARCH_TOOL_PROFILE = IDEA_DOSSIER_RESEARCH_TOOL_DEFINITION.profile
IDEA_DOSSIER_RESEARCH_TOOL_PLAN = IDEA_DOSSIER_RESEARCH_TOOL_DEFINITION.plan


def tool_plan_policy_facts() -> tuple[ToolPlanPolicyFacts, ...]:
    """Return model-callable plan definitions in canonical order."""

    facts = tuple(
        TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].policy_facts() for plan_id in _MODEL_TOOL_PLAN_IDS
    )
    if tuple(fact.plan_id for fact in facts) != _MODEL_TOOL_PLAN_IDS:
        raise AssertionError("model tool-plan policy order drifted")
    return facts


__all__ = [
    "CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION",
    "CHAT_READ_ADDITIVE_WRITE_TOOL_PLAN",
    "CHAT_READ_ADDITIVE_WRITE_TOOL_PROFILE",
    "CHAT_READ_TOOL_DEFINITION",
    "CHAT_READ_TOOL_PLAN",
    "CHAT_READ_TOOL_PROFILE",
    "IDEA_DOSSIER_READ_TOOL_DEFINITION",
    "IDEA_DOSSIER_READ_TOOL_PLAN",
    "IDEA_DOSSIER_READ_TOOL_PROFILE",
    "IDEA_DOSSIER_RESEARCH_TOOL_DEFINITION",
    "IDEA_DOSSIER_RESEARCH_TOOL_PLAN",
    "IDEA_DOSSIER_RESEARCH_TOOL_PROFILE",
    "LIBRARY_DOSSIER_READ_TOOL_DEFINITION",
    "LIBRARY_DOSSIER_READ_TOOL_PLAN",
    "LIBRARY_DOSSIER_READ_TOOL_PROFILE",
    "TOOL_PLAN_DEFINITIONS",
    "TOOL_PLAN_DEFINITIONS_BY_ID",
    "ToolGrantPolicyFacts",
    "ToolPlanDefinition",
    "ToolPlanPolicyFacts",
    "tool_plan_policy_facts",
]
