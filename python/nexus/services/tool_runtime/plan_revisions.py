"""Dependency-light lock for reviewed Nexus tool-plan authority revisions.

The runtime definitions recompute these digests from canonical tool contracts,
limits, effects, and exposure. Domain generation policy reads only this lock so
tool-free imports do not materialize the executable tool runtime.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

TOOL_PLAN_AUTHORITY_REVISIONS: Final[MappingProxyType[str, str]] = MappingProxyType(
    {
        "MetadataResearch": "518ee7ad642516a3af37ed0c176ab3b974b15dfa7f4f3f12c9ae335f6f4b1000",
        "NoModelTools": "f1ec4334cd09255df2f1ba43b9b82e2c55a8c93a2026c4ba1309e445d08568ed",
        "ChatReadAdditiveWrite": "a5b394078ea8098172038e5b4d45226bec07b9a4112ead33f77f011f21ed2858",
    }
)


def tool_plan_authority_revision(plan_id: str) -> str:
    try:
        return TOOL_PLAN_AUTHORITY_REVISIONS[plan_id]
    except KeyError as error:
        raise ValueError(f"unknown reviewed tool plan {plan_id!r}") from error


__all__ = ["TOOL_PLAN_AUTHORITY_REVISIONS", "tool_plan_authority_revision"]
