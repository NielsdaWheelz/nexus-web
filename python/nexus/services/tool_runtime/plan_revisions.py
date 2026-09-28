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
        "CodexGenerationApi": "13099e39cc392652119dada086b87e69c50c2f2cfea081430fecbddd47b9e865",
        "ChatReadAdditiveWrite": (
            "1a80ecc5878f45937a54567f2cc86916f90421c1181b4b0a5f69e28da9177476"
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
