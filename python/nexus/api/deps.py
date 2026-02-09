"""FastAPI dependencies for route handlers.

Common dependencies like database sessions, authentication, etc.
"""

from fastapi import Request

from nexus.db.session import get_db, get_session_factory
from nexus.services.llm import LLMRouter

__all__ = ["get_db", "get_llm_router", "get_session_factory"]


def get_llm_router(request: Request) -> LLMRouter:
    """Get the shared LLM router from app state.

    Per PR-04 spec Section 8:
    - LLMRouter is initialized at app startup with shared httpx.AsyncClient
    - Provides connection pooling and proper cleanup

    Args:
        request: The incoming request (provides access to app.state)

    Returns:
        The shared LLMRouter instance.
    """
    return request.app.state.llm_router
