"""Unbound Nexus capability profiles and presentation plans."""

from llm_tools import (
    CapabilityProfile,
    HostTable,
    Native,
    ProfileId,
    RunLimits,
    ToolGrant,
    ToolId,
    ToolPlan,
)

from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

CHAT_TOOL_PROFILE = CapabilityProfile(
    id=ProfileId("chat"),
    grants=tuple(ToolGrant(id=entry.spec.id, limits=None) for entry in CHAT_TOOL_DECLARATIONS),
    run_limits=RunLimits(
        max_calls=64,
        max_external_attempts=128,
        max_input_bytes=4_194_304,
        max_output_bytes=16_777_216,
        max_in_flight=1,
        max_elapsed_seconds=900.0,
    ),
)
CHAT_TOOL_PLAN = ToolPlan(profile=CHAT_TOOL_PROFILE.id, exposure=Native())

IDEA_DOSSIER_RESEARCH_TOOL_PROFILE = CapabilityProfile(
    id=ProfileId("idea_dossier_research"),
    grants=(ToolGrant(id=ToolId("web.search"), limits=None),),
    run_limits=RunLimits(
        max_calls=3,
        max_external_attempts=6,
        max_input_bytes=12_288,
        max_output_bytes=98_304,
        max_in_flight=1,
        max_elapsed_seconds=60.0,
    ),
)
IDEA_DOSSIER_RESEARCH_TOOL_PLAN = ToolPlan(
    profile=IDEA_DOSSIER_RESEARCH_TOOL_PROFILE.id,
    exposure=HostTable(),
)

__all__ = [
    "CHAT_TOOL_PLAN",
    "CHAT_TOOL_PROFILE",
    "IDEA_DOSSIER_RESEARCH_TOOL_PLAN",
    "IDEA_DOSSIER_RESEARCH_TOOL_PROFILE",
]
