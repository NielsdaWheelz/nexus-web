"""Provider contracts and catalog reads must not initialize execution SDKs."""

import json
import subprocess
import sys


def test_provider_catalog_and_runtime_construction_do_not_load_vendor_sdks() -> None:
    result = subprocess.run(
        (
            sys.executable,
            "-c",
            """
import json
import sys
from provider_runtime import Credentials, ProviderRuntime
from provider_runtime.registry import api_model_catalog

catalog = api_model_catalog()
runtime = ProviderRuntime(Credentials())
print(json.dumps(sorted(
    name for name in sys.modules
    if name in {"openai", "anthropic", "google.genai"}
    or name.startswith("provider_runtime.engines.openai_")
    or name.startswith("provider_runtime.engines.anthropic_")
    or name.startswith("provider_runtime.engines.gemini_")
)))
""",
        ),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    assert json.loads(result.stdout) == [], (
        "catalog/runtime construction initialized execution SDKs: " + result.stdout
    )


def test_first_provider_request_loads_only_its_selected_adapter() -> None:
    result = subprocess.run(
        (
            sys.executable,
            "-c",
            """
import asyncio
import json
import sys
import httpx
from provider_runtime import Credentials, ProviderRuntime
from provider_runtime.types import Succeeded, TextContent

def respond(request):
    assert request.url == "https://api.openai.com/v1/responses"
    assert json.loads(request.content)["model"] == "gpt-5.6-sol"
    return httpx.Response(200, json={
        "id": "resp_123", "object": "response", "created_at": 1,
        "status": "completed", "model": "gpt-5.6-sol",
        "output": [{"id": "msg_1", "type": "message", "role": "assistant",
                    "status": "completed", "content": [
                        {"type": "output_text", "text": "hello", "annotations": []}]}],
        "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
    })

async def main():
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        runtime = ProviderRuntime(Credentials(openai="test"), http_client=client)
        outcome = await runtime.chat("openai:gpt-5.6-sol", user="hi", max_output_tokens=64)
        assert isinstance(outcome, Succeeded), outcome
        assert outcome.response.content == TextContent(text="hello", tool_calls=()), outcome
    print(json.dumps(sorted(
        name for name in sys.modules
        if name in {"openai", "anthropic", "google.genai"}
        or name.startswith("provider_runtime.engines.openai_")
        or name.startswith("provider_runtime.engines.anthropic_")
        or name.startswith("provider_runtime.engines.gemini_")
    )))

asyncio.run(main())
""",
        ),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    assert json.loads(result.stdout) == ["openai", "provider_runtime.engines.openai_responses"]
