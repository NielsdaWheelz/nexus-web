"""OpenAI LLM adapter implementation.

Per PR-04 spec section 4.1:
- Endpoint: POST https://api.openai.com/v1/chat/completions
- Headers: Authorization: Bearer <key>, Content-Type: application/json
- Streaming: Server-Sent Events with data: {...} format
- Terminal event: data: [DONE]
- Usage may appear in final chunk (OpenAI returns it in stream if requested)

Request body (minimal required fields):
{
  "model": "<model_name>",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "max_tokens": 1024,
  "temperature": 0.7,
  "stream": false
}

Response (non-stream) - extract:
{
  "id": "chatcmpl-...",
  "choices": [{"message": {"content": "<output_text>"}}],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}

- text = choices[0].message.content
- usage = direct mapping
- provider_request_id = response header x-request-id or body id
"""

import json
from collections.abc import AsyncIterator

import httpx

from nexus.logging import get_logger
from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.types import LLMChunk, LLMRequest, LLMResponse, LLMUsage, Turn

logger = get_logger(__name__)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


class OpenAIAdapter(LLMAdapter):
    """OpenAI API adapter for chat completions.

    Handles conversion between Turn objects and OpenAI message format,
    and parses both streaming and non-streaming responses.
    """

    async def generate(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> LLMResponse:
        """Non-streaming chat completion."""
        headers = self._build_headers(api_key)
        body = self._build_request_body(req, stream=False)

        response = await self._client.post(
            OPENAI_CHAT_URL,
            headers=headers,
            json=body,
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        )
        response.raise_for_status()

        data = response.json()
        return self._parse_response(data, response.headers)

    async def generate_stream(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]:
        """Streaming chat completion using Server-Sent Events."""
        headers = self._build_headers(api_key)
        body = self._build_request_body(req, stream=True)

        async with self._client.stream(
            "POST",
            OPENAI_CHAT_URL,
            headers=headers,
            json=body,
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        ) as response:
            response.raise_for_status()

            provider_request_id = response.headers.get("x-request-id")
            received_done = False

            async for line in response.aiter_lines():
                if not line:
                    continue

                # OpenAI SSE format: "data: {...}" or "data: [DONE]"
                if not line.startswith("data: "):
                    continue

                data_str = line[6:]  # Remove "data: " prefix

                if data_str == "[DONE]":
                    received_done = True
                    yield LLMChunk(
                        delta_text="",
                        done=True,
                        usage=None,  # Usage comes in preceding chunks
                        provider_request_id=provider_request_id,
                    )
                    break

                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # Extract delta content
                choices = data.get("choices", [])
                if not choices:
                    continue

                delta = choices[0].get("delta", {})
                delta_text = delta.get("content", "")

                # Check for finish_reason
                finish_reason = choices[0].get("finish_reason")

                # Extract usage if present (OpenAI includes it in stream with stream_options)
                usage = None
                if "usage" in data:
                    usage_data = data["usage"]
                    usage = LLMUsage(
                        prompt_tokens=usage_data.get("prompt_tokens"),
                        completion_tokens=usage_data.get("completion_tokens"),
                        total_tokens=usage_data.get("total_tokens"),
                    )

                if finish_reason:
                    # This is the last content chunk before [DONE]
                    # Continue yielding - [DONE] will mark done=True
                    if delta_text or usage:
                        yield LLMChunk(delta_text=delta_text, done=False, usage=usage)
                else:
                    if delta_text:
                        yield LLMChunk(delta_text=delta_text, done=False, usage=usage)

            if not received_done:
                raise LLMError(
                    LLMErrorClass.PROVIDER_DOWN,
                    "OpenAI stream ended without [DONE] marker",
                    provider="openai",
                )

    def _build_headers(self, api_key: str) -> dict[str, str]:
        """Build request headers."""
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def _build_request_body(self, req: LLMRequest, stream: bool) -> dict:
        """Build request body from LLMRequest."""
        body: dict = {
            "model": req.model_name,
            "messages": [self._turn_to_message(turn) for turn in req.messages],
            "max_tokens": req.max_tokens,
            "stream": stream,
        }

        if req.temperature is not None:
            body["temperature"] = req.temperature

        return body

    def _turn_to_message(self, turn: Turn) -> dict[str, str]:
        """Convert Turn to OpenAI message format.

        OpenAI uses the same role names as our Turn type.
        """
        return {
            "role": turn.role,
            "content": turn.content,
        }

    def _parse_response(self, data: dict, headers: httpx.Headers) -> LLMResponse:
        """Parse non-streaming response."""
        # Extract text from choices[0].message.content
        choices = data.get("choices", [])
        if not choices:
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                "OpenAI response missing choices",
                provider="openai",
            )

        text = choices[0].get("message", {}).get("content", "")

        # Extract usage
        usage = None
        usage_data = data.get("usage")
        if usage_data:
            usage = LLMUsage(
                prompt_tokens=usage_data.get("prompt_tokens"),
                completion_tokens=usage_data.get("completion_tokens"),
                total_tokens=usage_data.get("total_tokens"),
            )

        # Extract request ID from header or body
        provider_request_id = headers.get("x-request-id") or data.get("id")

        return LLMResponse(
            text=text,
            usage=usage,
            provider_request_id=provider_request_id,
        )
