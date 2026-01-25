"""OpenAI LLM adapter.

Implements the LLM adapter interface for OpenAI's Chat Completions API.

API Reference: https://platform.openai.com/docs/api-reference/chat/create
Endpoint: POST https://api.openai.com/v1/chat/completions

Per PR-04 spec:
- Raw httpx, no official SDK
- Timeouts: connect 10s, read 45s
"""

import json
from collections.abc import Iterator

import httpx

from nexus.logging import get_logger
from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.types import (
    LLMChunk,
    LLMError,
    LLMErrorClass,
    LLMRequest,
    LLMResponse,
    LLMUsage,
)

logger = get_logger(__name__)

OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"


class OpenAIAdapter(LLMAdapter):
    """OpenAI Chat Completions API adapter."""

    @property
    def provider(self) -> str:
        return "openai"

    def generate(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> LLMResponse:
        """Generate a complete response from OpenAI."""
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": request.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                response = client.post(OPENAI_API_URL, headers=headers, json=payload)

            # Check for HTTP errors
            if response.status_code != 200:
                self._handle_error_response(response)

            data = response.json()

            # Extract content
            choices = data.get("choices", [])
            if not choices:
                raise LLMError(
                    error_class=LLMErrorClass.UNKNOWN,
                    message="No choices in OpenAI response",
                )

            content = choices[0].get("message", {}).get("content", "")
            finish_reason = choices[0].get("finish_reason")

            # Extract usage
            usage_data = data.get("usage", {})
            usage = LLMUsage(
                prompt_tokens=usage_data.get("prompt_tokens"),
                completion_tokens=usage_data.get("completion_tokens"),
                total_tokens=usage_data.get("total_tokens"),
            )

            return LLMResponse(
                content=content,
                usage=usage,
                model=data.get("model", request.model),
                finish_reason=finish_reason,
            )

        except httpx.TimeoutException as e:
            logger.warning("openai_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="OpenAI request timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("openai_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"OpenAI request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("openai_unexpected_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Unexpected error: {e}",
            ) from e

    def generate_stream(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> Iterator[LLMChunk]:
        """Generate a streaming response from OpenAI."""
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": request.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": True,
        }

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                with client.stream(
                    "POST", OPENAI_API_URL, headers=headers, json=payload
                ) as response:
                    if response.status_code != 200:
                        # Read the response body for error handling
                        response.read()
                        self._handle_error_response(response)

                    for line in response.iter_lines():
                        if not line:
                            continue

                        # SSE format: "data: {...}"
                        if line.startswith("data: "):
                            data_str = line[6:]  # Remove "data: " prefix

                            if data_str == "[DONE]":
                                return

                            try:
                                data = json.loads(data_str)
                                choices = data.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    content = delta.get("content", "")
                                    finish_reason = choices[0].get("finish_reason")

                                    if content or finish_reason:
                                        yield LLMChunk(
                                            delta=content,
                                            finish_reason=finish_reason,
                                        )
                            except json.JSONDecodeError:
                                logger.warning("openai_stream_parse_error", line=line[:100])
                                continue

        except httpx.TimeoutException as e:
            logger.warning("openai_stream_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="OpenAI stream timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("openai_stream_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"OpenAI stream request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("openai_stream_unexpected_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Unexpected error: {e}",
            ) from e

    def _handle_error_response(self, response: httpx.Response) -> None:
        """Handle non-200 HTTP responses from OpenAI."""
        status = response.status_code

        try:
            error_data = response.json()
            error_message = error_data.get("error", {}).get("message", "Unknown error")
        except Exception:
            error_message = response.text[:200] if response.text else "Unknown error"

        logger.warning(
            "openai_error_response",
            status=status,
            error_message=error_message[:200],
        )

        if status == 401 or status == 403:
            raise LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="OpenAI API key is invalid",
                provider_message=error_message,
            )
        elif status == 429:
            raise LLMError(
                error_class=LLMErrorClass.RATE_LIMIT,
                message="OpenAI rate limit exceeded",
                provider_message=error_message,
            )
        elif status == 400 and "context_length" in error_message.lower():
            raise LLMError(
                error_class=LLMErrorClass.CONTEXT_TOO_LARGE,
                message="Context too large for model",
                provider_message=error_message,
            )
        elif status >= 500:
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message="OpenAI service unavailable",
                provider_message=error_message,
            )
        else:
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"OpenAI error (status {status})",
                provider_message=error_message,
            )
