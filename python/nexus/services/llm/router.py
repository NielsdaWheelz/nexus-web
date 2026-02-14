"""LLM router for adapter selection and error normalization.

Per PR-04 spec section 6:
- Resolves adapter based on provider name
- Checks feature flags for provider availability
- Wraps adapter calls with error normalization
- Centralizes error classification (one place, not per adapter)

PR-09: Observability instrumentation:
- Emits llm.request.started / llm.request.finished / llm.request.failed events
- All events use safe_kv() to prevent sensitive data leakage
- Events include LLMOperation context for field requirements

Error handling:
- Provider 401/403 → E_LLM_INVALID_KEY
- Provider 429 → E_LLM_RATE_LIMIT
- Timeout → E_LLM_TIMEOUT
- Context too large → E_LLM_CONTEXT_TOO_LARGE
- Other → E_LLM_PROVIDER_DOWN
"""

import time
from collections.abc import AsyncIterator

import httpx

from nexus.logging import get_logger
from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.anthropic_adapter import AnthropicAdapter
from nexus.services.llm.errors import LLMError, LLMErrorClass, classify_provider_error
from nexus.services.llm.gemini_adapter import GeminiAdapter
from nexus.services.llm.openai_adapter import OpenAIAdapter
from nexus.services.llm.types import (
    LLMCallContext,
    LLMChunk,
    LLMOperation,
    LLMRequest,
    LLMResponse,
)
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

# Default timeout for LLM requests in seconds
DEFAULT_TIMEOUT_S = 45


def _base_log_fields(
    provider: str,
    req: LLMRequest,
    key_mode: str,
    streaming: bool,
    call_ctx: LLMCallContext | None,
) -> dict:
    """Build base log fields for LLM events."""
    fields: dict = {
        "provider": provider,
        "model_name": req.model_name,
        "key_mode": key_mode,
        "streaming": streaming,
        "llm_operation": call_ctx.operation.value if call_ctx else LLMOperation.OTHER.value,
    }
    if call_ctx and call_ctx.operation == LLMOperation.CHAT_SEND:
        if call_ctx.conversation_id:
            fields["conversation_id"] = call_ctx.conversation_id
        if call_ctx.assistant_message_id:
            fields["assistant_message_id"] = call_ctx.assistant_message_id
    return fields


class LLMRouter:
    """Routes LLM requests to appropriate provider adapters.

    Handles:
    - Adapter selection based on provider name
    - Feature flag enforcement
    - Error normalization across all providers
    - Observability event emission (PR-09)
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
        key_mode: str = "unknown",
        call_context: LLMCallContext | None = None,
    ) -> LLMResponse:
        """Non-streaming LLM generation with error normalization.

        Args:
            provider: Provider name ("openai", "anthropic", or "gemini").
            req: The LLM request.
            api_key: API key for the provider.
            timeout_s: Request timeout in seconds (default 45).
            key_mode: Key resolution mode for logging (platform/byok).
            call_context: Observability metadata for this call.

        Returns:
            LLMResponse with generated text and usage info.

        Raises:
            LLMError: With normalized error class on failure.
        """
        adapter = self.resolve_adapter(provider)
        base = _base_log_fields(provider, req, key_mode, streaming=False, call_ctx=call_context)

        # Compute safe size metrics for logging
        message_chars = sum(len(m.content) for m in req.messages)
        context_chars = sum(
            len(m.content) for m in req.messages if m.role == "user" and m != req.messages[-1]
        )
        num_context_items = max(0, sum(1 for m in req.messages if m.role == "user") - 1)

        logger.info(
            "llm.request.started",
            **safe_kv(
                **base,
                message_chars=message_chars,
                context_chars=context_chars,
                num_context_items=num_context_items,
            ),
        )

        start = time.monotonic()

        try:
            response = await adapter.generate(req, api_key=api_key, timeout_s=timeout_s)
            latency_ms = int((time.monotonic() - start) * 1000)

            usage = response.usage
            logger.info(
                "llm.request.finished",
                **safe_kv(
                    **base,
                    outcome="success",
                    latency_ms=latency_ms,
                    tokens_input=usage.prompt_tokens if usage else None,
                    tokens_output=usage.completion_tokens if usage else None,
                    tokens_total=usage.total_tokens if usage else None,
                    provider_request_id=response.provider_request_id,
                ),
            )
            return response

        except httpx.TimeoutException as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.TIMEOUT.value,
                    latency_ms=latency_ms,
                ),
            )
            raise LLMError(
                LLMErrorClass.TIMEOUT,
                "Request timed out",
                provider=provider,
            ) from e

        except httpx.HTTPStatusError as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            json_body = self._safe_parse_json(e.response)
            error_class = classify_provider_error(provider, e.response.status_code, json_body, None)
            provider_req_id = e.response.headers.get("x-request-id") or e.response.headers.get(
                "request-id"
            )
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=error_class.value,
                    latency_ms=latency_ms,
                    provider_request_id=provider_req_id,
                ),
            )
            raise LLMError(
                error_class,
                f"Provider returned HTTP {e.response.status_code}",
                provider=provider,
            ) from e

        except httpx.NetworkError as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.PROVIDER_DOWN.value,
                    latency_ms=latency_ms,
                ),
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
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.PROVIDER_DOWN.value,
                    latency_ms=latency_ms,
                ),
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
        key_mode: str = "unknown",
        call_context: LLMCallContext | None = None,
    ) -> AsyncIterator[LLMChunk]:
        """Streaming LLM generation with error normalization.

        Args:
            provider: Provider name ("openai", "anthropic", or "gemini").
            req: The LLM request.
            api_key: API key for the provider.
            timeout_s: Request timeout in seconds (default 45).
            key_mode: Key resolution mode for logging.
            call_context: Observability metadata for this call.

        Yields:
            LLMChunk objects until terminal chunk (done=True).

        Raises:
            LLMError: With normalized error class on failure.
        """
        adapter = self.resolve_adapter(provider)
        base = _base_log_fields(provider, req, key_mode, streaming=True, call_ctx=call_context)

        message_chars = sum(len(m.content) for m in req.messages)

        logger.info(
            "llm.request.started",
            **safe_kv(
                **base,
                message_chars=message_chars,
            ),
        )

        start = time.monotonic()

        try:
            async for chunk in adapter.generate_stream(req, api_key=api_key, timeout_s=timeout_s):
                # Emit finished on terminal chunk
                if chunk.done:
                    latency_ms = int((time.monotonic() - start) * 1000)
                    usage = chunk.usage
                    logger.info(
                        "llm.request.finished",
                        **safe_kv(
                            **base,
                            outcome="success",
                            latency_ms=latency_ms,
                            tokens_input=usage.prompt_tokens if usage else None,
                            tokens_output=usage.completion_tokens if usage else None,
                            tokens_total=usage.total_tokens if usage else None,
                            provider_request_id=chunk.provider_request_id,
                        ),
                    )
                yield chunk

        except httpx.TimeoutException as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.TIMEOUT.value,
                    latency_ms=latency_ms,
                ),
            )
            raise LLMError(
                LLMErrorClass.TIMEOUT,
                "Stream timed out",
                provider=provider,
            ) from e

        except httpx.HTTPStatusError as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            json_body = self._safe_parse_json(e.response)
            error_class = classify_provider_error(provider, e.response.status_code, json_body, None)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=error_class.value,
                    latency_ms=latency_ms,
                ),
            )
            raise LLMError(
                error_class,
                f"Provider returned HTTP {e.response.status_code}",
                provider=provider,
            ) from e

        except httpx.NetworkError as e:
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.PROVIDER_DOWN.value,
                    latency_ms=latency_ms,
                ),
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
            latency_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **base,
                    outcome="error",
                    error_class=LLMErrorClass.PROVIDER_DOWN.value,
                    latency_ms=latency_ms,
                ),
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
