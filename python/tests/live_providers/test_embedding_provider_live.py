"""Live embedding provider acceptance gate."""

from __future__ import annotations

import os

import pytest

from nexus.config import get_settings
from nexus.services.semantic_chunks import (
    build_text_embeddings,
    current_transcript_embedding_model,
    transcript_embedding_dimensions,
)
from tests.real_media.conftest import write_trace

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
    pytest.mark.live_provider,
]


def test_live_embedding_provider_returns_configured_real_vectors(tmp_path):
    settings = get_settings()
    if settings.nexus_env.value == "test":
        pytest.fail("live provider gate must run with NEXUS_ENV=local, staging, or prod")
    if not settings.enable_openai:
        pytest.fail("ENABLE_OPENAI must be true for the live embedding provider gate")
    if not os.environ.get("OPENAI_API_KEY"):
        pytest.fail("OPENAI_API_KEY must be set for the live embedding provider gate")

    model_name, vectors = build_text_embeddings(
        ["NASA real-media live embedding provider acceptance gate."]
    )

    assert model_name == current_transcript_embedding_model()
    assert model_name.startswith("openai_")
    assert len(vectors) == 1
    assert len(vectors[0]) == transcript_embedding_dimensions()
    assert any(value != 0 for value in vectors[0])
    write_trace(
        tmp_path,
        "live-embedding-provider-trace.json",
        {
            "provider": "openai",
            "model": model_name,
            "dimensions": len(vectors[0]),
            "vector_count": len(vectors),
        },
    )
