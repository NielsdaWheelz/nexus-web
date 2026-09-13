"""LLM profile registry route.

Route contract:
- GET /llm-profiles: the entire product-facing profile contract (§10). Thin
  adapter — the response is built entirely by `LlmProfilesOut.from_profiles()`
  over the `services.llm_profiles.PROFILES` registry; this module owns no
  provider/model/reasoning policy.

All routes require authentication (the response is identical for every
viewer; no per-user filtering applies).
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import ok
from nexus.schemas.llm import LlmProfilesOut

router = APIRouter(tags=["llm-profiles"])


@router.get("/llm-profiles")
def get_llm_profiles(viewer: Annotated[Viewer, Depends(get_viewer)]) -> dict:
    """List the product LLM profiles available to chat.

    Returns:
        {"data": LlmProfilesOut}
    """
    return ok(LlmProfilesOut.from_profiles())
