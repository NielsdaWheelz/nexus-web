"""The embedding identity every index row and query is stamped with, and the one provider call.

The identity is a triple: ``EMBEDDING_PROVIDER``, ``embedding_model()`` and
``EMBEDDING_DIMENSIONS``. A row is comparable with a query only when all three match;
search, atlas, suggestions and the oracle filter on it, and the index stamps it on every
``content_embeddings`` row and on every ``ready`` state. Configured APIs prepare
local SDK imports during lifespan startup; provider calls remain request-owned.
"""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module

from provider_runtime.retry import DEFAULT_RETRY
from provider_runtime.types import RetryPolicy

from nexus.config import TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS, get_settings

EMBEDDING_PROVIDER = "openai"
# The pgvector column is vector(256); config refuses any other configured width.
EMBEDDING_DIMENSIONS = TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS


def prepare_embeddings() -> None:
    """Load configured embedding SDK code before API readiness; no network or clients.

    The SDK facade leaves its resource/type graph lazy; load the public embedding
    resource before readiness so first use does not consume request deadlines. Resolve
    the runtime's public class here too. Unconfigured APIs retain lazy imports.
    """
    if get_settings().openai_api_key is None:
        return
    import_module("openai.resources.embeddings")
    # The public facade resolves ProviderRuntime lazily, without loading generation SDKs.
    _ = import_module("provider_runtime").ProviderRuntime


def embedding_model() -> str:
    """``openai_<normalized model name>_<dimensions>_v1``."""
    name = str(get_settings().transcript_embedding_model_openai or "text-embedding-3-small")
    normalized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return f"openai_{normalized}_{EMBEDDING_DIMENSIONS}_v1"


def pgvector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in vector) + "]"


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Synchronous adapter retaining the provider's default background retry policy."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(embed_texts_async(texts, retry=DEFAULT_RETRY))
    # Existing synchronous consumers may themselves be called on an event-loop thread.
    with ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(
            lambda: asyncio.run(embed_texts_async(texts, retry=DEFAULT_RETRY))
        ).result()


async def embed_texts_async(texts: Sequence[str], *, retry: RetryPolicy) -> list[list[float]]:
    """Native cancellable provider request; the caller owns the retry policy.

    Every vector is complete, finite and ``EMBEDDING_DIMENSIONS`` wide. Credential and
    expected provider failures propagate; malformed responses remain defects.
    """
    import httpx
    from provider_runtime import (
        Credentials,
        EmbeddingCall,
        Present,
        ProviderCredential,
        ProviderRuntime,
    )
    from provider_runtime.errors import CredentialMissing

    from nexus.provider_http import provider_ssl_context

    inputs = tuple(str(text or "").strip() for text in texts)
    if not inputs:
        return []
    settings = get_settings()
    if settings.openai_api_key is None:
        raise CredentialMissing(message="no openai credential configured")
    credential = ProviderCredential(provider="openai", key=settings.openai_api_key)
    call = EmbeddingCall(
        model=settings.transcript_embedding_model_openai,
        inputs=inputs,
        dimensions=Present(EMBEDDING_DIMENSIONS),
    )

    async with httpx.AsyncClient(
        trust_env=False, verify=provider_ssl_context(settings.provider_ca_pem)
    ) as client:
        runtime = ProviderRuntime(
            Credentials(openai=credential.key),
            http_client=client,
            retry=retry,
            endpoint_overrides=settings.provider_endpoint_overrides,
        )
        response = await runtime.embed(call, credential=credential)
    vectors = [[float(value) for value in vector] for vector in response.embeddings]
    if len(vectors) != len(inputs) or any(
        len(vector) != EMBEDDING_DIMENSIONS or not all(map(math.isfinite, vector))
        for vector in vectors
    ):
        # justify-defect: the provider response violates the embedding adapter's shape contract.
        raise RuntimeError("Embedding provider returned an invalid response")
    return vectors
