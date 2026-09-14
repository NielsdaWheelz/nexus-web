"""Actual selected adapter execution with only the external HTTP response controlled."""

import httpx
from provider_runtime import Credentials, ProviderRuntime
from provider_runtime.types import Succeeded, TextContent


def respond(request: httpx.Request) -> httpx.Response:
    assert request.url == "https://api.openai.com/v1/responses"
    return httpx.Response(
        200,
        json={
            "id": "resp_123",
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "model": "gpt-5.6-sol",
            "output": [
                {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {"type": "output_text", "text": "hello", "annotations": []}
                    ],
                }
            ],
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
        },
    )


async def first_request() -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        runtime = ProviderRuntime(Credentials(openai="test"), http_client=client)
        outcome = await runtime.chat(
            "openai:gpt-5.6-sol", user="hi", max_output_tokens=64
        )
        assert isinstance(outcome, Succeeded), outcome
        assert outcome.response.content == TextContent(text="hello", tool_calls=()), (
            outcome
        )
