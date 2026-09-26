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
            "1a80ecc5878f45937a54567f2cc86916f90421c1181b4b0a5f69e28da9177476"
        ),
        "LibraryDossierRead": ("b6b91ec256ef4113aee8aff329affdfeff08f855eb71cbcce6bf05d1bed93902"),
        "IdeaDossierRead": ("35ae7ab9ab1b2da96b3c7809b93c1cce8122e9a4eb7ef146d14aec0b2ca34d8b"),
        "MetadataRead": "19fb9c0910831b79eeec599c8da6f3980268abccac96f880d9357f09b9d62256",
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
