"""LLM adapter layer for provider-agnostic LLM integration.

This module provides a unified interface for calling OpenAI, Anthropic, and Gemini
models. It includes:

- Provider adapters with async support (non-streaming + streaming)
- Error classification and normalization
- Prompt rendering (provider-agnostic)
- Feature-flag enforcement
- Provider availability gating

Usage:
    from nexus.services.llm import LLMRouter, LLMRequest, Turn

    router = LLMRouter(httpx_client, settings)
    request = LLMRequest(
        model_name="gpt-4",
        messages=[Turn(role="user", content="Hello!")],
        max_tokens=100,
    )
    response = await router.generate("openai", request, api_key="sk-...")

Per PR-04 spec:
- Adapters are async using httpx.AsyncClient
- No retries inside adapters
- No DB access inside adapters
- No logging of request/response bodies
- Raw provider errors bubble up to router for classification
"""

from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.errors import LLMError, LLMErrorClass, classify_provider_error
from nexus.services.llm.prompt import (
    DEFAULT_SYSTEM_PROMPT,
    PromptTooLargeError,
    render_prompt,
    validate_prompt_size,
)
from nexus.services.llm.router import LLMRouter
from nexus.services.llm.types import (
    LLMCallContext,
    LLMChunk,
    LLMOperation,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    Turn,
)

__all__ = [
    # Core types
    "Turn",
    "LLMRequest",
    "LLMResponse",
    "LLMChunk",
    "LLMUsage",
    "LLMOperation",
    "LLMCallContext",
    # Adapter interface
    "LLMAdapter",
    # Router
    "LLMRouter",
    # Errors
    "LLMError",
    "LLMErrorClass",
    "classify_provider_error",
    # Prompt rendering
    "render_prompt",
    "validate_prompt_size",
    "PromptTooLargeError",
    "DEFAULT_SYSTEM_PROMPT",
]
