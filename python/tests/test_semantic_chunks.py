"""Tests for semantic chunk embedding provider boundaries."""

import httpx
import pytest
import respx

from nexus.config import clear_settings_cache
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.semantic_chunks import build_text_embeddings

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
    enable_openai: bool = True,
) -> None:
    monkeypatch.setenv("NEXUS_ENV", "local")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
    if api_key is None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    else:
        monkeypatch.setenv("OPENAI_API_KEY", api_key)
    monkeypatch.setenv("ENABLE_OPENAI", "true" if enable_openai else "false")
    clear_settings_cache()


@pytest.mark.parametrize(
    ("status_code", "expected_code"),
    [
        (400, ApiErrorCode.E_LLM_BAD_REQUEST),
        (401, ApiErrorCode.E_LLM_INVALID_KEY),
        (403, ApiErrorCode.E_LLM_INVALID_KEY),
        (408, ApiErrorCode.E_LLM_TIMEOUT),
        (404, ApiErrorCode.E_MODEL_NOT_AVAILABLE),
        (409, ApiErrorCode.E_LLM_BAD_REQUEST),
        (422, ApiErrorCode.E_LLM_BAD_REQUEST),
        (429, ApiErrorCode.E_LLM_RATE_LIMIT),
        (500, ApiErrorCode.E_LLM_PROVIDER_DOWN),
    ],
)
@respx.mock
def test_openai_embedding_http_errors_raise_stable_codes(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    expected_code: ApiErrorCode,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("nexus.services.semantic_chunks.time.sleep", lambda _: None)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        status_code,
        json={"error": {"message": "provider secret body"}},
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == expected_code
    assert exc_info.value.message == "Embedding provider request failed."
    assert "provider secret body" not in exc_info.value.message
    assert route.call_count == (5 if status_code in {408, 429, 500} else 1)


@respx.mock
def test_openai_embedding_retries_transient_provider_errors(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("nexus.services.semantic_chunks.time.sleep", lambda _: None)
    route = respx.post(OPENAI_EMBEDDINGS_URL).mock(
        side_effect=[
            httpx.Response(520, json={"error": {"message": "edge error"}}),
            httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1] * 256}]}),
        ]
    )

    model_name, vectors = build_text_embeddings(["NASA evidence"])

    assert model_name == "openai_text_embedding_3_small_256_v1"
    assert len(vectors) == 1
    assert route.call_count == 2


@pytest.mark.unit
@respx.mock
def test_openai_embedding_429_insufficient_quota_raises_quota_exceeded_without_retry(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    monkeypatch.setattr("nexus.services.semantic_chunks.time.sleep", lambda _: None)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        429,
        json={
            "error": {
                "type": "insufficient_quota",
                "message": "You exceeded your current quota.",
            }
        },
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_QUOTA_EXCEEDED, (
        f"Expected E_LLM_QUOTA_EXCEEDED for an insufficient_quota 429, got {exc_info.value.code}"
    )
    assert exc_info.value.message == "Embedding provider request failed.", (
        f"Expected the stable provider-failure message, got {exc_info.value.message!r}"
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
    monkeypatch.setattr("nexus.services.semantic_chunks.time.sleep", lambda _: None)
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
        429,
        json={
            "error": {
                "type": "requests",
                "message": "Rate limit reached for requests.",
            }
        },
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_RATE_LIMIT, (
        f"Expected E_LLM_RATE_LIMIT for a non-quota 429 error type, got {exc_info.value.code}"
    )
    assert exc_info.value.message == "Embedding provider request failed.", (
        f"Expected the stable provider-failure message, got {exc_info.value.message!r}"
    )
    assert route.call_count == 5, (
        f"Expected 5 calls (a transient 429 retries to exhaustion), got {route.call_count}"
    )


@pytest.mark.parametrize(
    ("api_key", "enable_openai", "expected_code"),
    [
        (None, True, ApiErrorCode.E_LLM_NO_KEY),
        ("sk-test-openai", False, ApiErrorCode.E_MODEL_NOT_AVAILABLE),
    ],
)
@respx.mock
def test_openai_embedding_configuration_errors_raise_stable_codes_without_http(
    monkeypatch: pytest.MonkeyPatch,
    api_key: str | None,
    enable_openai: bool,
    expected_code: ApiErrorCode,
):
    _configure_openai_embeddings(
        monkeypatch,
        api_key=api_key,
        enable_openai=enable_openai,
    )
    route = respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": []})

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == expected_code
    assert route.called is False


@respx.mock
def test_openai_embedding_malformed_success_raises_provider_down(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(
        200,
        json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]},
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_PROVIDER_DOWN
    assert exc_info.value.message == "Embedding provider returned an invalid response."


@pytest.mark.parametrize("bad_value_literal", ["NaN", "Infinity", "-Infinity"])
@respx.mock
def test_openai_embedding_non_finite_values_raise_provider_down(
    monkeypatch: pytest.MonkeyPatch,
    bad_value_literal: str,
):
    _configure_openai_embeddings(monkeypatch)
    embedding = ["0.1"] * 256
    embedding[7] = bad_value_literal
    respx.post(OPENAI_EMBEDDINGS_URL).respond(
        200,
        content=f'{{"data":[{{"index":0,"embedding":[{",".join(embedding)}]}}]}}',
        headers={"Content-Type": "application/json"},
    )

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_PROVIDER_DOWN
    assert exc_info.value.message == "Embedding provider returned an invalid response."


@respx.mock
def test_openai_embedding_wrong_vector_count_raises_provider_down(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": []})

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_PROVIDER_DOWN
    assert exc_info.value.message == "Embedding provider returned an invalid response."


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
def test_openai_embedding_invalid_indexes_raise_provider_down(
    monkeypatch: pytest.MonkeyPatch,
    data: list[dict[str, object]],
):
    _configure_openai_embeddings(monkeypatch)
    respx.post(OPENAI_EMBEDDINGS_URL).respond(200, json={"data": data})

    with pytest.raises(ApiError) as exc_info:
        build_text_embeddings(["NASA evidence"])

    assert exc_info.value.code == ApiErrorCode.E_LLM_PROVIDER_DOWN
    assert exc_info.value.message == "Embedding provider returned an invalid response."
