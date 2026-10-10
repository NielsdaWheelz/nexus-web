"""Authenticated generation catalog endpoint."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from nexus.api.deps import get_generation_catalog
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import Data
from nexus.schemas.llm import GenerationCatalog
from nexus.services.generation.catalog import Catalog, CatalogUnavailable

router = APIRouter(tags=["llm"])


@router.get("/llm-catalog")
async def get_llm_catalog(
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[Catalog, Depends(get_generation_catalog)],
) -> Data[GenerationCatalog]:
    """Return exact selectable and visible-ineligible generation facts."""

    del viewer
    response.headers["Cache-Control"] = "private, no-store"
    try:
        snapshot = await catalog.read()
    except CatalogUnavailable as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "Generation catalog is temporarily unavailable",
        ) from error
    return Data(data=snapshot.wire)
