"""Deterministic boundary coverage for semantic embedding dispatch."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

import httpx
import pytest
from provider_runtime.errors import NonGenerationCallFailed
from provider_runtime.types import ProviderContextTooLarge, ProviderRateLimit, TransientExhausted

from nexus.config import Settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import semantic_chunks


def _settings() -> Settings:
    return Settings.model_construct(
        openai_api_key="openai-test-key",
        transcript_embedding_model_openai="text-embedding-3-small",
        transcript_embedding_dimensions=3,
    )


def _embed(
    responder: Callable[[httpx.Request], httpx.Response],
) -> list[list[float]]:
    async def run() -> list[list[float]]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
            return await semantic_chunks._embed_with_openai_async(
                ["first", "second"],
                dimensions=3,
                settings=_settings(),
                http_client=client,
            )

    return asyncio.run(run())


def test_embeddings_dispatch_through_provider_runtime_and_preserve_input_order() -> None:
    requests: list[httpx.Request] = []

    def responder(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            request=request,
            json={
                "object": "list",
                "data": [
                    {"object": "embedding", "embedding": [4.0, 5.0, 6.0], "index": 1},
                    {"object": "embedding", "embedding": [1.0, 2.0, 3.0], "index": 0},
                ],
                "model": "text-embedding-3-small",
                "usage": {"prompt_tokens": 2, "total_tokens": 2},
            },
        )

    assert _embed(responder) == [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]

    assert len(requests) == 1
    request = requests[0]
    assert request.url == "https://api.openai.com/v1/embeddings"
    assert json.loads(request.content) == {
        "input": ["first", "second"],
        "model": "text-embedding-3-small",
        "dimensions": 3,
        "encoding_format": "base64",
    }


def test_embeddings_reject_malformed_vector_dimensions() -> None:
    def responder(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={
                "object": "list",
                "data": [
                    {"object": "embedding", "embedding": [1.0, 2.0], "index": 0},
                    {"object": "embedding", "embedding": [3.0, 4.0], "index": 1},
                ],
                "model": "text-embedding-3-small",
                "usage": {"prompt_tokens": 2, "total_tokens": 2},
            },
        )

    with pytest.raises(ApiError) as raised:
        _embed(responder)

    assert raised.value.code == ApiErrorCode.E_APP_SEARCH_FAILED


def test_embeddings_surface_provider_context_overflow() -> None:
    def responder(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            request=request,
            json={
                "error": {
                    "code": "context_length_exceeded",
                    "message": "maximum context length exceeded",
                    "type": "invalid_request_error",
                }
            },
        )

    with pytest.raises(NonGenerationCallFailed) as raised:
        _embed(responder)

    assert isinstance(raised.value.failure, ProviderContextTooLarge)


def test_embeddings_surface_transient_provider_failure() -> None:
    requests: list[httpx.Request] = []

    def responder(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            429,
            request=request,
            headers={"retry-after": "61"},
            json={
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": "retry later",
                    "type": "rate_limit_error",
                }
            },
        )

    with pytest.raises(NonGenerationCallFailed) as raised:
        _embed(responder)

    assert isinstance(raised.value.failure, TransientExhausted)
    assert raised.value.failure.attempts == 1
    assert isinstance(raised.value.failure.cause, ProviderRateLimit)
    assert len(requests) == 1
