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
        "ChatReadAdditiveWrite": (
            "3fc34933d27eeb7518984e1274a3be5001902dfb8d4a3669bc83160302d2ceff"
        ),
        "LibraryDossierRead": ("b6b91ec256ef4113aee8aff329affdfeff08f855eb71cbcce6bf05d1bed93902"),
        "IdeaDossierRead": ("35ae7ab9ab1b2da96b3c7809b93c1cce8122e9a4eb7ef146d14aec0b2ca34d8b"),
        "MetadataRead": "422ab2500e893ad24cb5cf079ab0edd4beb7c9915f818492723eb95e9a5e31f0",
        "idea_dossier_research": (
            "7486ba6f9b6e4bedc4b0e57ebd81fd398ef65df2dfe4fa2c0a9a06c76e3fd2af"
        ),
    }
)


def tool_plan_authority_revision(plan_id: str) -> str:
    try:
        return TOOL_PLAN_AUTHORITY_REVISIONS[plan_id]
    except KeyError as error:
        raise ValueError(f"unknown reviewed tool plan {plan_id!r}") from error


__all__ = ["TOOL_PLAN_AUTHORITY_REVISIONS", "tool_plan_authority_revision"]
