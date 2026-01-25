"""Gemini LLM adapter implementation.

Per PR-04 spec section 4.3:
- Non-streaming: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
- Streaming: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse

Auth:
- Header: x-goog-api-key: <key>
- NEVER put key in query param
- NEVER log URL if key accidentally in query

Turn conversion:
- System turn → systemInstruction.parts[0].text
- "assistant" role → "model" role in Gemini
- Each turn's content → parts: [{"text": "..."}]

Request body:
{
  "contents": [
    {"role": "user", "parts": [{"text": "..."}]},
    {"role": "model", "parts": [{"text": "..."}]}
  ],
  "systemInstruction": {"parts": [{"text": "<system_prompt>"}]},
  "generationConfig": {
    "maxOutputTokens": 1024,
    "temperature": 0.7
  }
}

Response (non-stream):
{
  "candidates": [{
    "content": {"parts": [{"text": "<output_text>"}]}
  }],
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "totalTokenCount": 150
  }
}

- text = concatenate candidates[0].content.parts[].text
- usage.prompt_tokens = promptTokenCount
- usage.completion_tokens = candidatesTokenCount
- usage.total_tokens = totalTokenCount
- provider_request_id = None (Gemini doesn't return one)

Streaming:
- Use :streamGenerateContent?alt=sse endpoint
- Each event: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
- Terminal: last event has "finishReason": "STOP"
- Usage in final event's usageMetadata
"""

import json
from collections.abc import AsyncIterator

import httpx

from nexus.logging import get_logger
from nexus.services.llm.adapter import LLMAdapter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.types import LLMChunk, LLMRequest, LLMResponse, LLMUsage, Turn

logger = get_logger(__name__)

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiAdapter(LLMAdapter):
    """Google Gemini API adapter.

    Handles conversion between Turn objects and Gemini content format,
    including role mapping (assistant → model) and system instruction extraction.
    """

    async def generate(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> LLMResponse:
        """Non-streaming content generation."""
        url = f"{GEMINI_BASE_URL}/{req.model_name}:generateContent"
        headers = self._build_headers(api_key)
        body = self._build_request_body(req)

        response = await self._client.post(
            url,
            headers=headers,
            json=body,
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        )
        response.raise_for_status()

        data = response.json()
        return self._parse_response(data)

    async def generate_stream(
        self,
        req: LLMRequest,
        *,
        api_key: str,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]:
        """Streaming content generation using Server-Sent Events."""
        url = f"{GEMINI_BASE_URL}/{req.model_name}:streamGenerateContent?alt=sse"
        headers = self._build_headers(api_key)
        body = self._build_request_body(req)

        async with self._client.stream(
            "POST",
            url,
            headers=headers,
            json=body,
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        ) as response:
            response.raise_for_status()

            received_stop = False
            usage: LLMUsage | None = None

            async for line in response.aiter_lines():
                if not line:
                    continue

                # Gemini SSE format: "data: {...}"
                if not line.startswith("data: "):
                    continue

                data_str = line[6:]
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # Extract text from candidates[0].content.parts[].text
                candidates = data.get("candidates", [])
                if candidates:
                    candidate = candidates[0]
                    content = candidate.get("content", {})
                    parts = content.get("parts", [])

                    delta_text = ""
                    for part in parts:
                        if "text" in part:
                            delta_text += part["text"]

                    # Check for finish reason
                    finish_reason = candidate.get("finishReason")

                    # Extract usage from final event
                    usage_metadata = data.get("usageMetadata")
                    if usage_metadata:
                        usage = LLMUsage(
                            prompt_tokens=usage_metadata.get("promptTokenCount"),
                            completion_tokens=usage_metadata.get("candidatesTokenCount"),
                            total_tokens=usage_metadata.get("totalTokenCount"),
                        )

                    if finish_reason == "STOP":
                        received_stop = True
                        # Yield any remaining text as non-terminal
                        if delta_text:
                            yield LLMChunk(delta_text=delta_text, done=False)
                        # Then yield terminal chunk
                        yield LLMChunk(
                            delta_text="",
                            done=True,
                            usage=usage,
                            provider_request_id=None,  # Gemini doesn't provide request ID
                        )
                        break
                    elif delta_text:
                        yield LLMChunk(delta_text=delta_text, done=False)

            if not received_stop:
                raise LLMError(
                    LLMErrorClass.PROVIDER_DOWN,
                    "Gemini stream ended without STOP finish reason",
                    provider="gemini",
                )

    def _build_headers(self, api_key: str) -> dict[str, str]:
        """Build request headers.

        Note: API key goes in header, NEVER in query param.
        """
        return {
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        }

    def _build_request_body(self, req: LLMRequest) -> dict:
        """Build request body from LLMRequest.

        Extracts system turn to systemInstruction and maps roles.
        """
        # Extract system prompt and non-system messages
        system_prompt = None
        contents = []

        for turn in req.messages:
            if turn.role == "system":
                system_prompt = turn.content
            else:
                contents.append(self._turn_to_content(turn))

        body: dict = {
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": req.max_tokens,
            },
        }

        if system_prompt:
            body["systemInstruction"] = {"parts": [{"text": system_prompt}]}

        if req.temperature is not None:
            body["generationConfig"]["temperature"] = req.temperature

        return body

    def _turn_to_content(self, turn: Turn) -> dict:
        """Convert Turn to Gemini content format.

        Note: Gemini uses "model" instead of "assistant" for the role.
        """
        role = "model" if turn.role == "assistant" else turn.role
        return {
            "role": role,
            "parts": [{"text": turn.content}],
        }

    def _parse_response(self, data: dict) -> LLMResponse:
        """Parse non-streaming response."""
        # Extract text from candidates[0].content.parts[].text
        candidates = data.get("candidates", [])
        if not candidates:
            raise LLMError(
                LLMErrorClass.PROVIDER_DOWN,
                "Gemini response missing candidates",
                provider="gemini",
            )

        content = candidates[0].get("content", {})
        parts = content.get("parts", [])
        text_parts = [part.get("text", "") for part in parts if "text" in part]
        text = "".join(text_parts)

        # Extract usage
        usage = None
        usage_metadata = data.get("usageMetadata")
        if usage_metadata:
            usage = LLMUsage(
                prompt_tokens=usage_metadata.get("promptTokenCount"),
                completion_tokens=usage_metadata.get("candidatesTokenCount"),
                total_tokens=usage_metadata.get("totalTokenCount"),
            )

        # Gemini doesn't return a request ID
        return LLMResponse(
            text=text,
            usage=usage,
            provider_request_id=None,
        )
