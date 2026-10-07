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
        "CodexGenerationApi": "37c649da223621910c12effd8a6158516702a52bc5b6e0427cd95481378677a0",
        "ChatReadAdditiveWrite": (
            "ec934f863e34db66d5aa07f5bd7ad18d169cc049dc12a5e7961a6128c47637f1"
        ),
        "idea_dossier_research": (
            "a6681b1d722ca5e27c9f697c6a2d4c96045eb7c20a17576cf69f2682a6bd755d"
        ),
    }
)


def tool_plan_authority_revision(plan_id: str) -> str:
    try:
        return TOOL_PLAN_AUTHORITY_REVISIONS[plan_id]
    except KeyError as error:
        raise ValueError(f"unknown reviewed tool plan {plan_id!r}") from error


__all__ = ["TOOL_PLAN_AUTHORITY_REVISIONS", "tool_plan_authority_revision"]
