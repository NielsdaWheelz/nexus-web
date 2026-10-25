"""The FastAPI application: routes, error handlers and two middlewares.

A request passes the edge middleware (request id, wire revision, last-resort error), then
auth (internal secret, bearer, viewer), then the router. Every answer is the envelope of
``nexus.responses``. The lifespan owns the shared outbound http client, the tools and the
generation catalog, and prepares configured embedding SDK code before readiness.
"""

import re
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from nexus.api.edge import EdgeMiddleware
from nexus.api.routes import create_api_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import TokenVerifier
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.responses import api_error_handler, error_response, http_exception_handler
from nexus.runtime_health import get_runtime_identity
from nexus.services.embeddings import prepare_embeddings
from nexus.services.generation.catalog import Catalog
from nexus.services.generation.policy import validate_policy
from nexus.services.tools.memory import load_memory_client_config
from nexus.services.tools.run import compose_tools, configured_web_search

logger = get_logger(__name__)
# a generation selection the body got wrong is 422 E_INVALID_GENERATION_SELECTION
_SELECTION_ROUTES = re.compile(r"/chat-runs|/messages/[^/]+/(?:rerun|regenerate)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Validate composition and prepare local embedding SDK code before serving reads."""
    settings = get_settings()
    get_runtime_identity()
    validate_policy()
    prepare_embeddings()
    memory_config = load_memory_client_config(settings.memory_client_config_path)
    app.state.httpx_client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        trust_env=False,
    )
    app.state.web_search_provider = configured_web_search(app.state.httpx_client, settings)
    app.state.toolbox = compose_tools(
        app.state.web_search_provider,
        memory_config=memory_config,
    )
    app.state.generation_catalog = Catalog(settings, app.state.toolbox)
    yield
    await app.state.httpx_client.aclose()


async def _invalid_request(request: Request, exc: Exception) -> JSONResponse:
    """400 ``E_INVALID_REQUEST``, or 422 for a chat send's bad generation selection.

    The log keeps each error's location and type only: pydantic's ``input`` and ``ctx``
    echo request content (locators, quotes, urls) that must never reach logs.
    """
    assert isinstance(exc, RequestValidationError)
    errors = exc.errors()
    logger.warning(
        "request_validation_failed",
        errors=[{"type": e.get("type"), "loc": e.get("loc"), "msg": e.get("msg")} for e in errors],
    )
    selection = (
        request.method == "POST"
        and _SELECTION_ROUTES.fullmatch(request.url.path) is not None
        and any(tuple(e.get("loc", ()))[:2] == ("body", "selection") for e in errors)
    )
    code = (
        ApiErrorCode.E_INVALID_GENERATION_SELECTION if selection else ApiErrorCode.E_INVALID_REQUEST
    )
    return JSONResponse(error_response(code, "Invalid request body"), status_code=code.status)


def create_app() -> FastAPI:
    settings = get_settings()
    # the schema and its docs are served outside staging and prod only
    hidden = settings.deployed
    app = FastAPI(
        title="Nexus API",
        version="0.1.0",
        docs_url=None if hidden else "/docs",
        redoc_url=None if hidden else "/redoc",
        openapi_url=None if hidden else "/openapi.json",
        lifespan=lifespan,
    )
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, _invalid_request)
    app.include_router(create_api_router())
    # added first, runs second: auth sits inside the edge
    app.add_middleware(
        AuthMiddleware,
        verifier=TokenVerifier(
            settings.supabase_jwks_url, settings.supabase_issuer, settings.supabase_audiences
        ),
        internal_secret=settings.nexus_internal_secret if settings.deployed else None,
    )
    app.add_middleware(EdgeMiddleware)
    return app
