"""Gemini LLM adapter.

Implements the LLM adapter interface for Google's Gemini API.

API Reference: https://ai.google.dev/api/rest/v1beta/models/generateContent
Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent

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

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiAdapter(LLMAdapter):
    """Google Gemini API adapter."""

    @property
    def provider(self) -> str:
        return "gemini"

    def generate(
        self,
        request: LLMRequest,
        api_key: str,
        timeout_seconds: float = 45.0,
    ) -> LLMResponse:
        """Generate a complete response from Gemini."""
        url = f"{GEMINI_API_BASE}/{request.model}:generateContent?key={api_key}"
        headers = {
            "Content-Type": "application/json",
        }

        # Convert messages to Gemini format
        # Gemini uses "contents" with "parts" structure
        # System instructions are separate
        system_instruction = None
        contents = []

        for m in request.messages:
            if m.role == "system":
                system_instruction = m.content
            else:
                # Gemini uses "user" and "model" roles
                role = "model" if m.role == "assistant" else "user"
                contents.append(
                    {
                        "role": role,
                        "parts": [{"text": m.content}],
                    }
                )

        payload: dict = {
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": request.max_tokens,
                "temperature": request.temperature,
            },
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                response = client.post(url, headers=headers, json=payload)

            if response.status_code != 200:
                self._handle_error_response(response)

            data = response.json()

            # Extract content
            candidates = data.get("candidates", [])
            if not candidates:
                # Check for prompt feedback (blocked content)
                prompt_feedback = data.get("promptFeedback", {})
                if prompt_feedback.get("blockReason"):
                    raise LLMError(
                        error_class=LLMErrorClass.UNKNOWN,
                        message=f"Gemini blocked the prompt: {prompt_feedback.get('blockReason')}",
                    )
                raise LLMError(
                    error_class=LLMErrorClass.UNKNOWN,
                    message="No candidates in Gemini response",
                )

            content_parts = candidates[0].get("content", {}).get("parts", [])
            content = "".join(part.get("text", "") for part in content_parts)
            finish_reason = candidates[0].get("finishReason")

            # Extract usage
            usage_metadata = data.get("usageMetadata", {})
            usage = LLMUsage(
                prompt_tokens=usage_metadata.get("promptTokenCount"),
                completion_tokens=usage_metadata.get("candidatesTokenCount"),
                total_tokens=usage_metadata.get("totalTokenCount"),
            )

            return LLMResponse(
                content=content,
                usage=usage,
                model=request.model,
                finish_reason=finish_reason,
            )

        except httpx.TimeoutException as e:
            logger.warning("gemini_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Gemini request timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("gemini_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"Gemini request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("gemini_unexpected_error", error=str(e))
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
        """Generate a streaming response from Gemini."""
        url = f"{GEMINI_API_BASE}/{request.model}:streamGenerateContent?key={api_key}&alt=sse"
        headers = {
            "Content-Type": "application/json",
        }

        # Convert messages to Gemini format
        system_instruction = None
        contents = []

        for m in request.messages:
            if m.role == "system":
                system_instruction = m.content
            else:
                role = "model" if m.role == "assistant" else "user"
                contents.append(
                    {
                        "role": role,
                        "parts": [{"text": m.content}],
                    }
                )

        payload: dict = {
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": request.max_tokens,
                "temperature": request.temperature,
            },
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=10.0, read=timeout_seconds, write=10.0)
            ) as client:
                with client.stream("POST", url, headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        response.read()
                        self._handle_error_response(response)

                    for line in response.iter_lines():
                        if not line:
                            continue

                        # SSE format: "data: {...}"
                        if line.startswith("data: "):
                            data_str = line[6:]

                            try:
                                data = json.loads(data_str)
                                candidates = data.get("candidates", [])

                                if candidates:
                                    content_parts = (
                                        candidates[0].get("content", {}).get("parts", [])
                                    )
                                    text = "".join(part.get("text", "") for part in content_parts)
                                    finish_reason = candidates[0].get("finishReason")

                                    if text or finish_reason:
                                        yield LLMChunk(
                                            delta=text,
                                            finish_reason=finish_reason,
                                        )

                            except json.JSONDecodeError:
                                logger.warning("gemini_stream_parse_error", line=line[:100])
                                continue

        except httpx.TimeoutException as e:
            logger.warning("gemini_stream_timeout", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Gemini stream timed out",
            ) from e
        except httpx.RequestError as e:
            logger.warning("gemini_stream_request_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message=f"Gemini stream request failed: {e}",
            ) from e
        except LLMError:
            raise
        except Exception as e:
            logger.error("gemini_stream_unexpected_error", error=str(e))
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Unexpected error: {e}",
            ) from e

    def _handle_error_response(self, response: httpx.Response) -> None:
        """Handle non-200 HTTP responses from Gemini."""
        status = response.status_code

        try:
            error_data = response.json()
            error = error_data.get("error", {})
            error_message = error.get("message", "Unknown error")
            error_status = error.get("status", "")
        except Exception:
            error_message = response.text[:200] if response.text else "Unknown error"
            error_status = ""

        logger.warning(
            "gemini_error_response",
            status=status,
            error_status=error_status,
            error_message=error_message[:200],
        )

        if status == 401 or status == 403 or error_status == "PERMISSION_DENIED":
            raise LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="Gemini API key is invalid",
                provider_message=error_message,
            )
        elif status == 429 or error_status == "RESOURCE_EXHAUSTED":
            raise LLMError(
                error_class=LLMErrorClass.RATE_LIMIT,
                message="Gemini rate limit exceeded",
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
        elif status >= 500 or error_status == "UNAVAILABLE":
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message="Gemini service unavailable",
                provider_message=error_message,
            )
        else:
            raise LLMError(
                error_class=LLMErrorClass.UNKNOWN,
                message=f"Gemini error (status {status})",
                provider_message=error_message,
            )
