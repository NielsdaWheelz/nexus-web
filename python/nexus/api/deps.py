"""FastAPI dependencies owned by the API layer."""

from fastapi import Request
from llm_calling.router import LLMRouter


def get_llm_router(request: Request) -> LLMRouter:
    """Get the shared LLM router from app state.

    App lifecycle contract:
    - LLMRouter is initialized at app startup with shared httpx.AsyncClient
    - Provides connection pooling and proper cleanup

    Args:
        request: The incoming request (provides access to app.state)

    Returns:
        The shared LLMRouter instance.
    """
    return request.app.state.llm_router
