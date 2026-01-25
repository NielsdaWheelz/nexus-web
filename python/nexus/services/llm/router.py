"""LLM router for adapter selection and error normalization.

Per PR-04 spec section 6:
- Resolves adapter based on provider name
- Checks feature flags for provider availability
- Wraps adapter calls with error normalization
- Centralizes error classification (one place, not per adapter)

Error handling:
- Provider 401/403 → E_LLM_INVALID_KEY
- Provider 429 → E_LLM_RATE_LIMIT
- Timeout → E_LLM_TIMEOUT
- Context too large → E_LLM_CONTEXT_TOO_LARGE
- Other → E_LLM_PROVIDER_DOWN
"""

from collections.abc import AsyncIterator

import httpx

from nexus.logging import get_logger
from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.anthropic_adapter import AnthropicAdapter
from nexus.services.llm.errors import LLMError, LLMErrorClass, classify_provider_error
from nexus.services.llm.gemini_adapter import GeminiAdapter
from nexus.services.llm.openai_adapter import OpenAIAdapter
from nexus.services.llm.types import LLMChunk, LLMRequest, LLMResponse

logger = get_logger(__name__)

# Default timeout for LLM requests in seconds
DEFAULT_TIMEOUT_S = 45


class LLMRouter:
    """Routes LLM requests to appropriate provider adapters.

    Handles:
    - Adapter selection based on provider name
    - Feature flag enforcement
    - Error normalization across all providers
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        enable_openai: bool = True,
        enable_anthropic: bool = True,
        enable_gemini: bool = True,
    ):
        """Initialize router with shared HTTP client and feature flags.

        Args:
            client: Shared httpx.AsyncClient for connection pooling.
            enable_openai: Whether OpenAI provider is enabled.
            enable_anthropic: Whether Anthropic provider is enabled.
            enable_gemini: Whether Gemini provider is enabled.
        """
        self._client = client
        self._feature_flags = {
            "openai": enable_openai,
            "anthropic": enable_anthropic,
            "gemini": enable_gemini,
        }
        self._adapters: dict[str, LLMAdapter] = {
            "openai": OpenAIAdapter(client),
            "anthropic": AnthropicAdapter(client),
            "gemini": GeminiAdapter(client),
        }

    def resolve_adapter(self, provider: str) -> LLMAdapter:
        """Get adapter for provider, checking feature flags.

        Args:
            provider: Provider name ("openai", "anthropic", or "gemini").

        Returns:
            The adapter instance for the provider.

        Raises:
            LLMError: If provider is unknown or disabled.
        """
        if provider not in self._adapters:
            raise LLMError(
                LLMErrorClass.MODEL_NOT_AVAILABLE,
                f"Unknown provider: {provider}",
                provider=provider,
            )

        if not self._is_provider_enabled(provider):
            raise LLMError(
                LLMErrorClass.MODEL_NOT_AVAILABLE,
                f"Provider {provider} is disabled",
                provider=provider,
            )

        return self._adapters[provider]

    def _is_provider_enabled(self, provider: str) -> bool:
        """Check if provider is enabled via feature flags."""
        return self._feature_flags.get(provider, False)

    def is_provider_available(self, provider: str) -> bool:
        """Check if a provider is available (known and enabled).

        Args:
            provider: Provider name to check.

        Returns:
            True if provider exists and is enabled.
        """
        return provider in self._adapters and self._is_provider_enabled(provider)

    async def generate(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int = DEFAULT_TIMEOUT_S,
    ) -> LLMResponse:
        """Non-streaming LLM generation with error normalization.

        Args:
            provider: Provider name ("openai", "anthropic", or "gemini").
            req: The LLM request.
            api_key: API key for the provider.
            timeout_s: Request timeout in seconds (default 45).

        Returns:
            LLMResponse with generated text and usage info.

        Raises:
            LLMError: With normalized error class on failure.
        """
        adapter = self.resolve_adapter(provider)

        try:
            return await adapter.generate(req, api_key=api_key, timeout_s=timeout_s)

        except httpx.TimeoutException as e:
            logger.warning(
                "llm_request_timeout",
                provider=provider,
                model=req.model_name,
            )
            raise LLMError(
                LLMErrorClass.TIMEOUT,
                "Request timed out",
                provider=provider,
            ) from e

        except httpx.HTTPStatusError as e:
            json_body = self._safe_parse_json(e.response)
            error_class = classify_provider_error(provider, e.response.status_code, json_body, None)
            logger.warning(
                "llm_request_http_error",
                provider=provider,
                model=req.model_name,
                status_code=e.response.status_code,
                error_class=error_class.value,
            )
            raise LLMError(
                error_class,
                f"Provider returned HTTP {e.response.status_code}",
                provider=provider,
            ) from e

        except httpx.NetworkError as e:
            logger.warning(
                "llm_request_network_error",
                provider=provider,
                model=req.model_name,
                error=str(e),
            )
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                "Network error",
                provider=provider,
            ) from e

        except LLMError:
            # Re-raise LLMError as-is (e.g., from adapter stream parsing)
            raise

        except Exception as e:
            logger.error(
                "llm_request_unexpected_error",
                provider=provider,
                model=req.model_name,
                error=str(e),
                error_type=type(e).__name__,
            )
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                f"Unexpected error: {type(e).__name__}",
                provider=provider,
            ) from e

    async def generate_stream(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int = DEFAULT_TIMEOUT_S,
    ) -> AsyncIterator[LLMChunk]:
        """Streaming LLM generation with error normalization.

        Args:
            provider: Provider name ("openai", "anthropic", or "gemini").
            req: The LLM request.
            api_key: API key for the provider.
            timeout_s: Request timeout in seconds (default 45).

        Yields:
            LLMChunk objects until terminal chunk (done=True).

        Raises:
            LLMError: With normalized error class on failure.
        """
        adapter = self.resolve_adapter(provider)

        try:
            async for chunk in adapter.generate_stream(req, api_key=api_key, timeout_s=timeout_s):
                yield chunk

        except httpx.TimeoutException as e:
            logger.warning(
                "llm_stream_timeout",
                provider=provider,
                model=req.model_name,
            )
            raise LLMError(
                LLMErrorClass.TIMEOUT,
                "Stream timed out",
                provider=provider,
            ) from e

        except httpx.HTTPStatusError as e:
            json_body = self._safe_parse_json(e.response)
            error_class = classify_provider_error(provider, e.response.status_code, json_body, None)
            logger.warning(
                "llm_stream_http_error",
                provider=provider,
                model=req.model_name,
                status_code=e.response.status_code,
                error_class=error_class.value,
            )
            raise LLMError(
                error_class,
                f"Provider returned HTTP {e.response.status_code}",
                provider=provider,
            ) from e

        except httpx.NetworkError as e:
            logger.warning(
                "llm_stream_network_error",
                provider=provider,
                model=req.model_name,
                error=str(e),
            )
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                "Network error during stream",
                provider=provider,
            ) from e

        except LLMError:
            # Re-raise LLMError as-is
            raise

        except Exception as e:
            logger.error(
                "llm_stream_unexpected_error",
                provider=provider,
                model=req.model_name,
                error=str(e),
                error_type=type(e).__name__,
            )
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                f"Unexpected stream error: {type(e).__name__}",
                provider=provider,
            ) from e

    def _safe_parse_json(self, response: httpx.Response) -> dict | None:
        """Safely parse JSON from response, returning None on failure."""
        try:
            return response.json()
        except Exception:
            return None
