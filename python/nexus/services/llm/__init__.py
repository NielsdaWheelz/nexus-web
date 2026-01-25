"""LLM adapter layer for multi-provider LLM execution.

This module provides:
- Unified adapter interface for OpenAI, Anthropic, and Gemini
- Error normalization across providers
- Prompt rendering with context windows
- Streaming support (feature-flagged)

Per PR-04/PR-05 specs:
- Raw httpx for all providers (no official SDKs)
- Consistent error mapping
- Timeouts: connect 10s, read 45s, write 10s
"""

from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.router import generate, generate_stream, get_adapter
from nexus.services.llm.types import (
    LLMChunk,
    LLMError,
    LLMErrorClass,
    LLMRequest,
    LLMResponse,
    ResolvedKey,
)

__all__ = [
    "LLMAdapter",
    "LLMRequest",
    "LLMResponse",
    "LLMChunk",
    "LLMError",
    "LLMErrorClass",
    "ResolvedKey",
    "get_adapter",
    "generate",
    "generate_stream",
]
