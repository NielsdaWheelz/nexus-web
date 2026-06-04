import pytest
from llm_calling.types import LLMRequest, ToolResult, ToolSpec, Turn

from nexus.services.real_media_fixture_llm import (
    APP_SEARCH_TOOL_NAME,
    REAL_MEDIA_FIXTURE_RESPONSE,
    REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION,
    RealMediaFixtureLLMRouter,
)

pytestmark = [pytest.mark.unit, pytest.mark.asyncio]


def _request(*turns: Turn) -> LLMRequest:
    return LLMRequest(
        model_name="gpt-5.4-mini",
        messages=list(turns),
        max_tokens=1024,
        tools=(
            ToolSpec(
                name=APP_SEARCH_TOOL_NAME,
                description="Search saved content.",
                parameters={"type": "object"},
            ),
        ),
    )


async def _chunks(req: LLMRequest):
    router = RealMediaFixtureLLMRouter()
    return [
        chunk
        async for chunk in router.generate_stream(
            "openai",
            req,
            "real-media-fixture",
            timeout_s=45,
        )
    ]


async def test_real_media_fixture_llm_uses_app_search_before_answering() -> None:
    chunks = await _chunks(
        _request(
            Turn(
                role="user",
                content="What does this source say about SOFIA? Use the attached evidence.",
            ),
        )
    )

    assert chunks[0].tool_call is not None
    assert chunks[0].tool_call.name == APP_SEARCH_TOOL_NAME
    assert chunks[0].tool_call.arguments == {"query": "SOFIA"}
    assert chunks[1].done is True


async def test_real_media_fixture_llm_cites_tool_result() -> None:
    chunks = await _chunks(
        _request(
            Turn(role="user", content="What does this source say about SOFIA?"),
            Turn(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"results":[{"n":1}]}',
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
    assert chunks[1].done is True


async def test_real_media_fixture_llm_does_not_cite_empty_tool_result() -> None:
    chunks = await _chunks(
        _request(
            Turn(role="user", content="What does this source say about SOFIA?"),
            Turn(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"results":[],"total_candidates":0,"status":"empty"}',
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE
    assert chunks[1].done is True


async def test_real_media_fixture_llm_does_not_cite_tool_error() -> None:
    chunks = await _chunks(
        _request(
            Turn(role="user", content="What does this source say about SOFIA?"),
            Turn(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"error":"search failed"}',
                        is_error=True,
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE
    assert chunks[1].done is True
