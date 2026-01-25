"""Abstract base class for LLM adapters.

Per PR-04 spec section 3:
- Async adapters with httpx.AsyncClient
- No retries inside adapters
- No DB access
- No logging of request/response bodies
- Raw provider errors bubble up to router for classification
- Each adapter handles Turn → provider format conversion internally

Why async: FastAPI is async. Blocking HTTP inside async endpoints stalls the event loop.
Streaming with sync httpx inside FastAPI is error-prone.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

import httpx

from nexus.services.llm.types import LLMChunk, LLMRequest, LLMResponse


class LLMAdapter(ABC):
    """Abstract base class for LLM provider adapters.

    Each adapter implements provider-specific HTTP communication and
    Turn → provider format conversion.

    Rules:
    - No retries inside adapters
    - No DB access
    - No logging of request/response bodies
    - Raw provider errors bubble up to router for classification
    """

    def __init__(self, client: httpx.AsyncClient):
        """Initialize adapter with shared HTTP client.

        Args:
            client: Shared httpx.AsyncClient for connection pooling.
        """
        self._client = client

    @abstractmethod
    async def generate(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> LLMResponse:
        """Non-streaming generation. Returns complete response.

        Args:
            req: The LLM request containing model, messages, and parameters.
            api_key: The API key for authentication.
            timeout_s: Request timeout in seconds.

        Returns:
            LLMResponse with the complete generated text and usage info.

        Raises:
            httpx.HTTPStatusError: On non-2xx HTTP response.
            httpx.TimeoutException: On request timeout.
            httpx.NetworkError: On network failure.
        """
        pass

    @abstractmethod
    async def generate_stream(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]:
        """Streaming generation. Yields chunks until done=True.

        Streaming invariants:
        - Chunks with done=False have usage=None
        - Exactly one terminal chunk with done=True
        - Terminal chunk may have usage and provider_request_id

        Args:
            req: The LLM request containing model, messages, and parameters.
            api_key: The API key for authentication.
            timeout_s: Request timeout in seconds.

        Yields:
            LLMChunk objects until a terminal chunk (done=True).

        Raises:
            httpx.HTTPStatusError: On non-2xx HTTP response.
            httpx.TimeoutException: On request timeout.
            httpx.NetworkError: On network failure.
            LLMError: If stream ends without proper terminal marker.
        """
        pass
        # This is an abstract async generator, must yield to be valid
        yield  # type: ignore
