"""Tests for semantic chunk embedding provider boundaries."""

from pathlib import Path

import httpx
import pytest
import respx
from provider_runtime import (
    CredentialRejected,
    NonGenerationCallFailed,
    ProtocolDefect,
    ProviderRateLimit,
    RuntimeDefect,
    TransientExhausted,
)

from nexus.config import clear_settings_cache
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.semantic_chunks import (
    build_text_embeddings,
    current_transcript_embedding_provider,
)

pytestmark = pytest.mark.unit

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"


@pytest.fixture(autouse=True)
def _clear_settings_after_test():
    yield
    clear_settings_cache()


def _configure_openai_embeddings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_key: str | None = "sk-test-openai",
) -> None:
    monkeypatch.setenv("NEXUS_ENV", "local")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
    if api_key is None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    else:
        monkeypatch.setenv("OPENAI_API_KEY", api_key)
    clear_settings_cache()


def _configure_real_media_fixture_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXUS_ENV", "local")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
    monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "1")
    monkeypatch.setenv("REAL_MEDIA_FIXTURE_DIR", str(Path(__file__).parent))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    clear_settings_cache()


async def _no_retry_sleep(_seconds: float) -> None:
    return None


@respx.mock
def test_real_media_fixture_embeddings_are_deterministic_without_openai(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_real_media_fixture_embeddings(monkeypatch)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(401)

    model_name, vectors = build_text_embeddings(["NASA evidence", "NASA evidence"])

    assert current_transcript_embedding_provider() == "fixture"
    assert model_name == "fixture_hash_v1_256"
    assert len(vectors) == 2
    assert vectors[0] == vectors[1]
    assert len(vectors[0]) == 256
    assert any(value != 0 for value in vectors[0])
    assert route.called is False


@respx.mock
def test_fixture_query_embedding_matches_semantic_chunk_projection(
    monkeypatch: pytest.MonkeyPatch,
):
    """The single-text query embedding (the shared path Oracle/search consume) matches
    the batch-indexed embedding for fixtures, with no provider HTTP call."""
    _configure_real_media_fixture_embeddings(monkeypatch)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(401)

    from nexus.services.semantic_chunks import build_text_embedding

    model_name, indexed_vectors = build_text_embeddings(["B-52 H2O AI"])
    returned_model, query_vector = build_text_embedding("B-52 H2O AI")

    assert returned_model == model_name
    assert query_vector == indexed_vectors[0]
    assert route.called is False


# provider_runtime.openai.classify_error (§9) raises a defect immediately (no
# retry) for any status it does not explicitly classify as transient or as
# credential rejection; 401/403 raise CredentialRejected specifically. Neither
# is an ApiError any more (no ApiErrorCode.E_LLM_* left) — these are runtime
# defects, since a platform-configured provider misbehaving in a
# non-transient way is an operator fact, not a product-facing failure.
@pytest.mark.parametrize(
    ("status_code", "expected_exception", "expected_code"),
    [
        (400, RuntimeDefect, "unclassified_provider_error"),
        (401, CredentialRejected, "credential_rejected"),
        (403, CredentialRejected, "credential_rejected"),
        (408, RuntimeDefect, "unclassified_provider_error"),
        (404, RuntimeDefect, "unclassified_provider_error"),
        (409, RuntimeDefect, "unclassified_provider_error"),
        (422, RuntimeDefect, "unclassified_provider_error"),
    ],
)
@respx.mock
def test_openai_embedding_non_transient_http_errors_raise_defects_without_retry(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    expected_exception: type[Exception],
    expected_code: str,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("provider_runtime.runtime.asyncio.sleep", _no_retry_sleep)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        status_code,
        json={"error": {"message": "provider secret body"}},
    )

    with pytest.raises(expected_exception) as exc_info:
        build_text_embeddings(["NASA evidence"])

    # Unlike the deleted ApiError contract, a RuntimeDefect's message is
    # operator/log-facing (never returned to a product caller), so it is
    # allowed to carry a sanitized provider-body snippet for diagnosis;
    # provider_runtime.errors.sanitize_provider_text is what redacts actual
    # secrets (API keys, bearer tokens) — covered by provider_runtime's own
    # test suite, not this one.
    assert exc_info.value.code == expected_code
    assert route.call_count == 1


@pytest.mark.parametrize("status_code", [429, 500])
@respx.mock
def test_openai_embedding_transient_http_errors_retry_to_exhaustion(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("provider_runtime.runtime.asyncio.sleep", _no_retry_sleep)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        status_code,
        json={"error": {"message": "provider secret body"}},
    )

    with pytest.raises(NonGenerationCallFailed) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert isinstance(exc_info.value.failure, TransientExhausted)
    # EXTERNAL_LLM_RETRY.max_attempts == 3.
    assert route.call_count == 3


@respx.mock
def test_openai_embedding_retries_transient_provider_errors(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("provider_runtime.runtime.asyncio.sleep", _no_retry_sleep)
    route = respx.post(OPENAI_EMBEDDINGS_URL).mock(
        side_effect=[
            httpx.Response(500, json={"error": {"message": "edge error"}}),
            httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1] * 256}]}),
        ]
    )

    model_name, vectors = build_text_embeddings(["NASA evidence"])

    assert model_name == "openai_text_embedding_3_small_256_v1"
    assert len(vectors) == 1
    assert route.call_count == 2


@pytest.mark.unit
@respx.mock
def test_openai_embedding_429_insufficient_quota_raises_quota_exhausted_defect_without_retry(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("provider_runtime.runtime.asyncio.sleep", _no_retry_sleep)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        429,
        json={
            "error": {
                "type": "insufficient_quota",
                "message": "You exceeded your current quota.",
            }
        },
    )

    with pytest.raises(RuntimeDefect) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == "quota_exhausted", (
        f"Expected quota_exhausted defect for an insufficient_quota 429, got {exc_info.value.code}"
    )
    assert route.call_count == 1, (
        f"Expected exactly 1 call (quota exhaustion is not retryable), got {route.call_count}"
    )


@pytest.mark.unit
@respx.mock
def test_openai_embedding_429_transient_error_type_retries_as_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("provider_runtime.runtime.asyncio.sleep", _no_retry_sleep)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        429,
        json={
            "error": {
                "type": "requests",
                "message": "Rate limit reached for requests.",
            }
        },
    )

    with pytest.raises(NonGenerationCallFailed) as exc_info:
        build_text_embeddings(["NASA evidence"])

    failure = exc_info.value.failure
    assert isinstance(failure, TransientExhausted), (
        f"Expected TransientExhausted for a non-quota 429 error type, got {type(failure)}"
    )
    assert isinstance(failure.cause, ProviderRateLimit)
    assert route.call_count == 3, (
        f"Expected 3 calls (EXTERNAL_LLM_RETRY.max_attempts, a transient 429 retries to "
        f"exhaustion), got {route.call_count}"
    )


@respx.mock
def test_openai_embedding_missing_key_raises_credential_missing_defect_without_http(
    monkeypatch: pytest.MonkeyPatch,
):
    # ENABLE_OPENAI is dead config post-cutover (no model-catalog gate exists any
    # more), so the only remaining no-HTTP-call configuration error is a missing
    # platform key, surfaced by llm_credentials.embedding_credential as a
    # RuntimeDefect (an operator/deployment fact, never a product-facing
    # ApiError — see nexus/services/llm_credentials.py).
    _configure_openai_embeddings(monkeypatch, api_key=None)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": []})

    with pytest.raises(RuntimeDefect) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == "credential_missing"
    assert route.called is False


@respx.mock
def test_openai_embedding_malformed_success_raises_search_failed(
    monkeypatch: pytest.MonkeyPatch,
):
    """A well-formed provider envelope with a wrong-dimension vector is nexus's own
    invariant (not provider_runtime's) — provider_runtime only validates
    index/count/finiteness, not vector length against nexus's configured
    dimensionality — so it still surfaces as the app-facing ApiError."""
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(
        200,
        json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]},
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_APP_SEARCH_FAILED
    assert exc_info.value.message == "Embedding provider returned an invalid response."


@pytest.mark.parametrize("bad_value_literal", ["NaN", "Infinity", "-Infinity"])
@respx.mock
def test_openai_embedding_non_finite_values_raise_protocol_defect(
    monkeypatch: pytest.MonkeyPatch,
    bad_value_literal: str,
):
    """provider_runtime's embeddings port validates finiteness itself now (it is
    the sole parser of the provider envelope), raising ProtocolDefect before
    nexus's own post-hoc vector validation ever runs."""
    _configure_openai_embeddings(monkeypatch)
    embedding = ["0.1"] * 256
    embedding[7] = bad_value_literal
    respx.post(OPENAI_EMBEDDINGS_URL).respond(
        200,
        content=f'{{"data":[{{"index":0,"embedding":[{",".join(embedding)}]}}]}}',
        headers={"Content-Type": "application/json"},
    )

    with pytest.raises(ProtocolDefect) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == "invalid_embedding_response"


@respx.mock
def test_openai_embedding_wrong_vector_count_raises_protocol_defect(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": []})

    with pytest.raises(ProtocolDefect) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == "invalid_embedding_response"


@pytest.mark.parametrize(
    "data",
    [
        [{"embedding": [0.1] * 256}],
        [
            {"index": 0, "embedding": [0.1] * 256},
            {"index": 0, "embedding": [0.2] * 256},
        ],
        [{"index": 2, "embedding": [0.1] * 256}],
    ],
)
@respx.mock
def test_openai_embedding_invalid_indexes_raise_protocol_defect(
    monkeypatch: pytest.MonkeyPatch,
    data: list[dict[str, object]],
):
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": data})

    with pytest.raises(ProtocolDefect) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == "invalid_embedding_response"
