"""Anthropic LLM adapter.

Implements the LLM adapter interface for Anthropic's Messages API.

API Reference: https://docs.anthropic.com/en/api/messages
Endpoint: POST https://api.anthropic.com/v1/messages

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

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"


class AnthropicAdapter(LLMAdapter):
    """Anthropic Messages API adapter."""

    @property
    def provider(self) -> str:
        return "anthropic"

    def generate(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> LLMResponse:
        """Generate a complete response from Anthropic."""
        headers = {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        }

        # Extract system message if present
        system_content = None
        messages = []
        for m in request.messages:
            if m.role == "system":
                system_content = m.content
            else:
                messages.append({"role": m.role, "content": m.content})

        payload: dict = {
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens,
        }
        if system_content:
            payload["system"] = system_content

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                response = client.post(ANTHROPIC_API_URL, headers=headers, json=payload)

            if response.status_code != 200:
                self._handle_error_response(response)

            data = response.json()

            # Extract content from content blocks
            content_blocks = data.get("content", [])
            content = ""
            for block in content_blocks:
                if block.get("type") == "text":
                    content += block.get("text", "")

            finish_reason = data.get("stop_reason")

            # Extract usage
            usage_data = data.get("usage", {})
            usage = LLMUsage(
                prompt_tokens=usage_data.get("input_tokens"),
                completion_tokens=usage_data.get("output_tokens"),
                total_tokens=(
                    (usage_data.get("input_tokens") or 0) + (usage_data.get("output_tokens") or 0)
                    if usage_data.get("input_tokens") is not None
                    else None
                ),
            )

            return LLMResponse(
                content=content,
                usage=usage,
                model=data.get("model", request.model),
                finish_reason=finish_reason,
            )

        except httpx.TimeoutException as e:
            logger.warning("anthropic_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Anthropic request timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("anthropic_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"Anthropic request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("anthropic_unexpected_error", error=str(e))
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
        """Generate a streaming response from Anthropic."""
        headers = {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        }

        # Extract system message if present
        system_content = None
        messages = []
        for m in request.messages:
            if m.role == "system":
                system_content = m.content
            else:
                messages.append({"role": m.role, "content": m.content})

        payload: dict = {
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "stream": True,
        }
        if system_content:
            payload["system"] = system_content

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                with client.stream(
                    "POST", ANTHROPIC_API_URL, headers=headers, json=payload
                ) as response:
                    if response.status_code != 200:
                        response.read()
                        self._handle_error_response(response)

                    for line in response.iter_lines():
                        if not line:
                            continue

                        # SSE format: "event: <type>\ndata: {...}"
                        if line.startswith("data: "):
                            data_str = line[6:]

                            try:
                                data = json.loads(data_str)
                                event_type = data.get("type")

                                if event_type == "content_block_delta":
                                    delta = data.get("delta", {})
                                    if delta.get("type") == "text_delta":
                                        text = delta.get("text", "")
                                        if text:
                                            yield LLMChunk(delta=text, finish_reason=None)

                                elif event_type == "message_stop":
                                    yield LLMChunk(delta="", finish_reason="stop")

                                elif event_type == "message_delta":
                                    # Final message with stop reason
                                    stop_reason = data.get("delta", {}).get("stop_reason")
                                    if stop_reason:
                                        yield LLMChunk(delta="", finish_reason=stop_reason)

                            except json.JSONDecodeError:
                                logger.warning("anthropic_stream_parse_error", line=line[:100])
                                continue

        except httpx.TimeoutException as e:
            logger.warning("anthropic_stream_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Anthropic stream timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("anthropic_stream_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"Anthropic stream request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("anthropic_stream_unexpected_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Unexpected error: {e}",
            ) from e

    def _handle_error_response(self, response: httpx.Response) -> None:
        """Handle non-200 HTTP responses from Anthropic."""
        status = response.status_code

        try:
            error_data = response.json()
            error_message = error_data.get("error", {}).get("message", "Unknown error")
            error_type = error_data.get("error", {}).get("type", "")
        except Exception:
            error_message = response.text[:200] if response.text else "Unknown error"
            error_type = ""

        logger.warning(
            "anthropic_error_response",
            status=status,
            error_type=error_type,
            error_message=error_message[:200],
        )

        if status == 401 or status == 403:
            raise LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="Anthropic API key is invalid",
                provider_message=error_message,
            )
        elif status == 429:
            raise LLMError(
                error_class=LLMErrorClass.RATE_LIMIT,
                message="Anthropic rate limit exceeded",
                provider_message=error_message,
            )
        elif status == 400 and (
            "token" in error_message.lower() or "context" in error_message.lower()
        ):
            raise LLMError(
                error_class=LLMErrorClass.CONTEXT_TOO_LARGE,
                message="Context too large for model",
                provider_message=error_message,
            )
        elif status >= 500 or error_type == "overloaded_error":
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message="Anthropic service unavailable",
                provider_message=error_message,
            )
        else:
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Anthropic error (status {status})",
                provider_message=error_message,
            )
