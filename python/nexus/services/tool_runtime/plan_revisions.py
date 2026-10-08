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
        "MetadataResearch": "a042a8026212be785e5a23c34308844b9c8d6f6fc2abc32c37621868fa68f1e4",
        "NoModelTools": "f1ec4334cd09255df2f1ba43b9b82e2c55a8c93a2026c4ba1309e445d08568ed",
        "ChatReadAdditiveWrite": "78a9d21800fec6cd2a003ecd23b59b9fee2b9fa54f836fb821c9256f503ae3f4",
    }
)


def tool_plan_authority_revision(plan_id: str) -> str:
    try:
        return TOOL_PLAN_AUTHORITY_REVISIONS[plan_id]
    except KeyError as error:
        raise ValueError(f"unknown reviewed tool plan {plan_id!r}") from error


__all__ = ["TOOL_PLAN_AUTHORITY_REVISIONS", "tool_plan_authority_revision"]
