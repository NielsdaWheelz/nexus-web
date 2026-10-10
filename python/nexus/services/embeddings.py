"""The embedding identity every index row and query is stamped with, and the one provider call.

The identity is a triple: ``EMBEDDING_PROVIDER``, ``embedding_model()`` and
``EMBEDDING_DIMENSIONS``. A row is comparable with a query only when all three match;
search, atlas, suggestions and the oracle filter on it, and the index stamps it on every
``content_embeddings`` row and on every ``ready`` state.
"""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor

from nexus.config import TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS, get_settings
from nexus.errors import ApiError, ApiErrorCode

EMBEDDING_PROVIDER = "openai"
# The pgvector column is vector(256); config refuses any other configured width.
EMBEDDING_DIMENSIONS = TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS


def embedding_model() -> str:
    """``openai_<normalized model name>_<dimensions>_v1``."""
    name = str(get_settings().transcript_embedding_model_openai or "text-embedding-3-small")
    normalized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return f"openai_{normalized}_{EMBEDDING_DIMENSIONS}_v1"


def pgvector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in vector) + "]"


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """One provider request for at most 64 stripped inputs, from synchronous code.

    Every returned vector is complete, finite and ``EMBEDDING_DIMENSIONS`` wide, else
    ``ApiError(E_APP_SEARCH_FAILED)``. ``NonGenerationCallFailed`` (transient-exhausted or
    oversize input) and ``CredentialMissing`` propagate unwrapped: search is the sole
    catcher of the former, for its lexical fallback.
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

    async def embed() -> list[list[float]]:
        async with httpx.AsyncClient(trust_env=False) as client:
            runtime = ProviderRuntime(Credentials(openai=credential.key), http_client=client)
            response = await runtime.embed(call, credential=credential)
        vectors = [[float(value) for value in vector] for vector in response.embeddings]
        if len(vectors) != len(inputs) or any(
            len(vector) != EMBEDDING_DIMENSIONS or not all(map(math.isfinite, vector))
            for vector in vectors
        ):
            raise ApiError(
                ApiErrorCode.E_APP_SEARCH_FAILED, "Embedding provider returned an invalid response."
            )
        return vectors

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(embed())
    # Called from a thread that already owns a loop: run the call on a thread of its own.
    with ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(lambda: asyncio.run(embed())).result()
