"""Standalone read-only public web-search route.

Reuses the chat tool's provider and projection (``search_web_readonly``) with no
persistence; the persisting wrapper (``execute_web_search``) stays chat-only.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from web_search_tool.types import WebSearchError, WebSearchProvider

from nexus.api.deps import get_web_search_provider
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.responses import success_response
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_QUERY_MAX_CHARS,
    WEB_SEARCH_QUERY_MIN_CHARS,
    WebSearchQueryError,
    search_web_readonly,
)

logger = get_logger(__name__)

router = APIRouter(tags=["web_search"])


@router.get("/web/search")
async def web_search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    provider: Annotated[WebSearchProvider, Depends(get_web_search_provider)],
    q: Annotated[
        str, Query(min_length=WEB_SEARCH_QUERY_MIN_CHARS, max_length=WEB_SEARCH_QUERY_MAX_CHARS)
    ],
    freshness_days: Annotated[int | None, Query(ge=1)] = None,
) -> dict:
    """Search the open public web and return projected results without persisting.

    ``q`` is bounded at the request boundary (``min_length``/``max_length``) and
    further normalized + word-count validated by ``search_web_readonly`` via the
    shared ``normalize_web_search_query`` owner; an out-of-range query yields a clean
    400, never a 500. Provider transport failures map to 503.
    """
    try:
        result = await search_web_readonly(provider, q, freshness_days=freshness_days)
    except WebSearchQueryError as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, str(exc)) from exc
    except WebSearchError as exc:
        logger.warning(
            "web_search_provider_error",
            provider=exc.provider,
            code=exc.code.value,
            status_code=exc.status_code,
        )
        raise ApiError(
            ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            "Web search provider is unavailable",
        ) from exc
    return success_response({"results": [citation.to_json() for citation in result.citations]})
