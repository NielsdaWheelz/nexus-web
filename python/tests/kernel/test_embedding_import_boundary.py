"""The search embedding port must fit without generation-only provider SDKs."""

import subprocess
import sys
import textwrap


def test_embedding_uses_openai_without_loading_generation_engines() -> None:
    # A fresh interpreter observes the actual first-use import boundary.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                """
                import asyncio
                import json
                import sys

                import httpx
                from provider_runtime import Credentials, EmbeddingCall, ProviderRuntime
                from provider_runtime.types import Present, ProviderCredential

                requests = []

                def respond(request):
                    assert str(request.url) == "https://api.openai.com/v1/embeddings"
                    assert request.headers["authorization"] == "Bearer embedding-test-key"
                    body = json.loads(request.content)
                    assert body["input"] == ["pillow book"]
                    assert body["model"] == "text-embedding-3-small"
                    assert body["dimensions"] == 2
                    requests.append(request)
                    return httpx.Response(200, json={
                        "object": "list",
                        "data": [{"object": "embedding", "index": 0, "embedding": [0.5, -1.0]}],
                        "model": "text-embedding-3-small",
                        "usage": {"prompt_tokens": 2, "total_tokens": 2},
                    })

                async def main():
                    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                        runtime = ProviderRuntime(Credentials(), http_client=client)
                        response = await runtime.embed(
                            EmbeddingCall(
                                model="text-embedding-3-small",
                                inputs=("pillow book",),
                                dimensions=Present(2),
                            ),
                            credential=ProviderCredential(provider="openai", key="embedding-test-key"),
                        )
                        assert response.embeddings == ((0.5, -1.0),)
                        assert len(requests) == 1
                    assert "openai" in sys.modules
                    assert "anthropic" not in sys.modules
                    assert "google.genai" not in sys.modules
                    assert not any(
                        name.startswith("provider_runtime.engines.")
                        and not name.rsplit(".", 1)[1].startswith("_")
                        for name in sys.modules
                    )

                asyncio.run(main())
                """
            ),
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
