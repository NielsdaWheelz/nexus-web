"""Base LLM adapter interface.

Defines the abstract interface that all LLM provider adapters must implement.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterator

from nexus.services.llm.types import LLMChunk, LLMRequest, LLMResponse


class LLMAdapter(ABC):
    """Abstract base class for LLM provider adapters.

    Each provider (OpenAI, Anthropic, Gemini) implements this interface.
    Error handling is done in the router layer for consistency.
    """

    @property
    @abstractmethod
    def provider(self) -> str:
        """Return the provider name (openai, anthropic, gemini)."""
        ...

    @abstractmethod
    def generate(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> LLMResponse:
        """Generate a complete response synchronously.

        Args:
            request: The LLM request with messages and model.
            api_key: The API key to use (platform or BYOK).
            timeout_seconds: Read timeout for the request.

        Returns:
            Complete LLM response with content and usage.

        Raises:
            LLMError: On any provider error (normalized by router).
        """
        ...

    @abstractmethod
    def generate_stream(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> Iterator[LLMChunk]:
        """Generate a streaming response.

        Args:
            request: The LLM request with messages and model.
            api_key: The API key to use (platform or BYOK).
            timeout_seconds: Inactivity timeout between chunks.

        Yields:
            LLMChunk objects with incremental content.

        Raises:
            LLMError: On any provider error (normalized by router).
        """
        ...
