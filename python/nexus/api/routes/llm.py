"""Authenticated generation catalog endpoint."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from nexus.api.deps import get_generation_catalog_service
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import ok
from nexus.services.generation_catalog import (
    GenerationCatalogRefreshError,
    GenerationCatalogService,
)

router = APIRouter(tags=["llm"])


@router.get("/llm-catalog")
async def get_llm_catalog(
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog_service: Annotated[
        GenerationCatalogService,
        Depends(get_generation_catalog_service),
    ],
) -> dict:
    """Return exact selectable and visible-ineligible generation facts."""

    del viewer
    response.headers["Cache-Control"] = "private, no-store"
    try:
        snapshot = await catalog_service.read_chat()
    except GenerationCatalogRefreshError as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "Generation catalog is temporarily unavailable",
        ) from error
    return ok(snapshot.catalog)
