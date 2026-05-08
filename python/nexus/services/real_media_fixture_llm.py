"""Deterministic LLM boundary for real-media fixture runs."""

from __future__ import annotations

from collections.abc import AsyncIterator

from llm_calling.types import LLMChunk, LLMRequest, LLMResponse, LLMUsage


class RealMediaFixtureLLMRouter:
    def __init__(
        self,
        *,
        enable_openai: bool = True,
        enable_anthropic: bool = True,
        enable_gemini: bool = True,
        enable_deepseek: bool = True,
    ) -> None:
        self._enabled = {
            "openai": enable_openai,
            "anthropic": enable_anthropic,
            "gemini": enable_gemini,
            "deepseek": enable_deepseek,
        }

    def is_provider_available(self, provider: str) -> bool:
        return bool(self._enabled.get(provider, False))

    async def generate(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int,
    ) -> LLMResponse:
        return LLMResponse(
            text=REAL_MEDIA_FIXTURE_RESPONSE,
            usage=_usage_for(req, REAL_MEDIA_FIXTURE_RESPONSE),
            provider_request_id="real-media-fixture",
            status="completed",
        )

    async def generate_stream(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]:
        yield LLMChunk(delta_text=REAL_MEDIA_FIXTURE_RESPONSE, done=False)
        yield LLMChunk(
            delta_text="",
            done=True,
            usage=_usage_for(req, REAL_MEDIA_FIXTURE_RESPONSE),
            provider_request_id="real-media-fixture",
            status="completed",
        )


REAL_MEDIA_FIXTURE_RESPONSE = (
    "The source says SOFIA helped confirm water on the Moon by detecting a "
    "water signature in Clavius Crater."
)


def _usage_for(req: LLMRequest, response: str) -> LLMUsage:
    input_tokens = max(1, sum(len(turn.content) for turn in req.messages) // 4)
    output_tokens = max(1, len(response) // 4)
    return LLMUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        reasoning_tokens=0,
    )
