"""Tests for LLM adapter layer.

Per PR-04 spec section 11:
- 8 tests × 3 providers = 24 adapter tests minimum
- Additional tests for router, prompt rendering, turn conversion

Test coverage per provider:
- test_{provider}_nonstream_success: Happy path non-streaming
- test_{provider}_stream_success: Happy path streaming
- test_{provider}_stream_chunks_before_done: Verify usage=None on non-terminal chunks
- test_{provider}_invalid_key_401: 401 → E_LLM_INVALID_KEY
- test_{provider}_rate_limit_429: 429 → E_LLM_RATE_LIMIT
- test_{provider}_context_too_large: Context error → E_LLM_CONTEXT_TOO_LARGE
- test_{provider}_provider_down_500: 5xx → E_LLM_PROVIDER_DOWN
- test_{provider}_timeout: Timeout → E_LLM_TIMEOUT

Explicitly Forbidden:
- Live provider calls
- Real API keys anywhere in test code
- Flaky tests depending on network

Note: These tests are pure unit tests that do NOT require database access.
They use respx to mock HTTP requests and test the LLM adapter layer in isolation.
"""

import json
from pathlib import Path

import httpx
import pytest
import respx

from nexus.services.llm import (
    DEFAULT_SYSTEM_PROMPT,
    LLMChunk,
    LLMError,
    LLMErrorClass,
    LLMRequest,
    LLMRouter,
    LLMUsage,
    PromptTooLargeError,
    Turn,
    render_prompt,
    validate_prompt_size,
)
from nexus.services.llm.anthropic_adapter import AnthropicAdapter
from nexus.services.llm.errors import classify_provider_error
from nexus.services.llm.gemini_adapter import GeminiAdapter
from nexus.services.llm.openai_adapter import OpenAIAdapter

# Path to test fixtures
FIXTURES_DIR = Path(__file__).parent / "fixtures" / "llm"


def load_fixture(provider: str, filename: str) -> dict | str:
    """Load a test fixture file."""
    path = FIXTURES_DIR / provider / filename
    content = path.read_text()
    if filename.endswith(".json"):
        return json.loads(content)
    return content


def load_stream_fixture(provider: str) -> list[str]:
    """Load stream fixture and split into lines."""
    content = load_fixture(provider, "success_stream_chunks.txt")
    assert isinstance(content, str)
    return [line for line in content.split("\n") if line]


# =============================================================================
# Test Fixtures
# =============================================================================


@pytest.fixture
def httpx_client():
    """Create an httpx AsyncClient for testing."""
    return httpx.AsyncClient()


@pytest.fixture
def llm_request():
    """Create a basic LLM request for testing."""
    return LLMRequest(
        model_name="test-model",
        messages=[
            Turn(role="system", content="You are helpful."),
            Turn(role="user", content="Hello!"),
        ],
        max_tokens=100,
        temperature=0.7,
    )


# =============================================================================
# OpenAI Adapter Tests
# =============================================================================


class TestOpenAIAdapter:
    """Tests for OpenAI adapter."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_nonstream_success(self, httpx_client, llm_request):
        """Happy path non-streaming generation."""
        fixture = load_fixture("openai", "success_nonstream.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(
            200, json=fixture, headers={"x-request-id": "req-test-123"}
        )

        adapter = OpenAIAdapter(httpx_client)
        response = await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert response.text == "Hello! How can I help you today?"
        assert response.usage is not None
        assert response.usage.prompt_tokens == 10
        assert response.usage.completion_tokens == 8
        assert response.usage.total_tokens == 18
        assert response.provider_request_id == "req-test-123"

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_stream_success(self, httpx_client, llm_request):
        """Happy path streaming generation."""
        stream_content = load_fixture("openai", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post("https://api.openai.com/v1/chat/completions").respond(
            200,
            content=stream_content,
            headers={"x-request-id": "req-test-123", "content-type": "text/event-stream"},
        )

        adapter = OpenAIAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(llm_request, api_key="sk-test", timeout_s=30):
            chunks.append(chunk)

        # Should have multiple non-terminal chunks plus one terminal
        assert len(chunks) > 1
        assert chunks[-1].done is True
        assert chunks[-1].provider_request_id == "req-test-123"

        # All non-terminal chunks should have done=False
        for chunk in chunks[:-1]:
            assert chunk.done is False

        # Accumulate text
        full_text = "".join(c.delta_text for c in chunks)
        assert "Hello" in full_text

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_stream_chunks_before_done(self, httpx_client, llm_request):
        """Verify usage=None on non-terminal chunks."""
        stream_content = load_fixture("openai", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post("https://api.openai.com/v1/chat/completions").respond(
            200, content=stream_content
        )

        adapter = OpenAIAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(llm_request, api_key="sk-test", timeout_s=30):
            chunks.append(chunk)

        # All non-terminal chunks must have usage=None per streaming invariants
        for chunk in chunks[:-1]:
            assert chunk.usage is None, "Non-terminal chunks must have usage=None"

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_invalid_key_401(self, httpx_client, llm_request):
        """401 response should raise HTTPStatusError."""
        fixture = load_fixture("openai", "error_401.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(401, json=fixture)

        adapter = OpenAIAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-invalid", timeout_s=30)

        assert exc_info.value.response.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_rate_limit_429(self, httpx_client, llm_request):
        """429 response should raise HTTPStatusError."""
        fixture = load_fixture("openai", "error_429.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(429, json=fixture)

        adapter = OpenAIAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 429

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_context_too_large(self, httpx_client, llm_request):
        """Context too large error."""
        fixture = load_fixture("openai", "error_context_too_large.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(400, json=fixture)

        adapter = OpenAIAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 400

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_provider_down_500(self, httpx_client, llm_request):
        """500 response should raise HTTPStatusError."""
        fixture = load_fixture("openai", "error_500.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(500, json=fixture)

        adapter = OpenAIAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 500

    @pytest.mark.asyncio
    @respx.mock
    async def test_openai_timeout(self, httpx_client, llm_request):
        """Timeout should raise TimeoutException."""
        respx.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=httpx.ReadTimeout("Read timed out")
        )

        adapter = OpenAIAdapter(httpx_client)
        with pytest.raises(httpx.TimeoutException):
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=1)


# =============================================================================
# Anthropic Adapter Tests
# =============================================================================


class TestAnthropicAdapter:
    """Tests for Anthropic adapter."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_nonstream_success(self, httpx_client, llm_request):
        """Happy path non-streaming generation."""
        fixture = load_fixture("anthropic", "success_nonstream.json")
        respx.post("https://api.anthropic.com/v1/messages").respond(200, json=fixture)

        adapter = AnthropicAdapter(httpx_client)
        response = await adapter.generate(llm_request, api_key="sk-ant-test", timeout_s=30)

        assert response.text == "Hello! How can I help you today?"
        assert response.usage is not None
        assert response.usage.prompt_tokens == 10
        assert response.usage.completion_tokens == 8
        assert response.usage.total_tokens == 18
        assert response.provider_request_id == "msg_test123"

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_stream_success(self, httpx_client, llm_request):
        """Happy path streaming generation."""
        stream_content = load_fixture("anthropic", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post("https://api.anthropic.com/v1/messages").respond(200, content=stream_content)

        adapter = AnthropicAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(
            llm_request, api_key="sk-ant-test", timeout_s=30
        ):
            chunks.append(chunk)

        assert len(chunks) > 1
        assert chunks[-1].done is True
        assert chunks[-1].provider_request_id == "msg_test123"

        full_text = "".join(c.delta_text for c in chunks)
        assert "Hello" in full_text

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_stream_chunks_before_done(self, httpx_client, llm_request):
        """Verify usage=None on non-terminal chunks."""
        stream_content = load_fixture("anthropic", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post("https://api.anthropic.com/v1/messages").respond(200, content=stream_content)

        adapter = AnthropicAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(
            llm_request, api_key="sk-ant-test", timeout_s=30
        ):
            chunks.append(chunk)

        for chunk in chunks[:-1]:
            assert chunk.usage is None, "Non-terminal chunks must have usage=None"

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_invalid_key_401(self, httpx_client, llm_request):
        """401 response should raise HTTPStatusError."""
        fixture = load_fixture("anthropic", "error_401.json")
        respx.post("https://api.anthropic.com/v1/messages").respond(401, json=fixture)

        adapter = AnthropicAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-invalid", timeout_s=30)

        assert exc_info.value.response.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_rate_limit_429(self, httpx_client, llm_request):
        """429 response should raise HTTPStatusError."""
        fixture = load_fixture("anthropic", "error_429.json")
        respx.post("https://api.anthropic.com/v1/messages").respond(429, json=fixture)

        adapter = AnthropicAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 429

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_context_too_large(self, httpx_client, llm_request):
        """Context too large error."""
        fixture = load_fixture("anthropic", "error_context_too_large.json")
        respx.post("https://api.anthropic.com/v1/messages").respond(400, json=fixture)

        adapter = AnthropicAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 400

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_provider_down_500(self, httpx_client, llm_request):
        """500 response should raise HTTPStatusError."""
        fixture = load_fixture("anthropic", "error_500.json")
        respx.post("https://api.anthropic.com/v1/messages").respond(500, json=fixture)

        adapter = AnthropicAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=30)

        assert exc_info.value.response.status_code == 500

    @pytest.mark.asyncio
    @respx.mock
    async def test_anthropic_timeout(self, httpx_client, llm_request):
        """Timeout should raise TimeoutException."""
        respx.post("https://api.anthropic.com/v1/messages").mock(
            side_effect=httpx.ReadTimeout("Read timed out")
        )

        adapter = AnthropicAdapter(httpx_client)
        with pytest.raises(httpx.TimeoutException):
            await adapter.generate(llm_request, api_key="sk-test", timeout_s=1)


# =============================================================================
# Gemini Adapter Tests
# =============================================================================


class TestGeminiAdapter:
    """Tests for Gemini adapter."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_nonstream_success(self, httpx_client, llm_request):
        """Happy path non-streaming generation."""
        fixture = load_fixture("gemini", "success_nonstream.json")
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).respond(200, json=fixture)

        adapter = GeminiAdapter(httpx_client)
        response = await adapter.generate(llm_request, api_key="gemini-test-key", timeout_s=30)

        assert response.text == "Hello! How can I help you today?"
        assert response.usage is not None
        assert response.usage.prompt_tokens == 10
        assert response.usage.completion_tokens == 8
        assert response.usage.total_tokens == 18
        assert response.provider_request_id is None  # Gemini doesn't return request ID

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_stream_success(self, httpx_client, llm_request):
        """Happy path streaming generation."""
        stream_content = load_fixture("gemini", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent"
        ).respond(200, content=stream_content)

        adapter = GeminiAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(
            llm_request, api_key="gemini-test-key", timeout_s=30
        ):
            chunks.append(chunk)

        assert len(chunks) > 1
        assert chunks[-1].done is True

        full_text = "".join(c.delta_text for c in chunks)
        assert "Hello" in full_text

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_stream_chunks_before_done(self, httpx_client, llm_request):
        """Verify usage=None on non-terminal chunks."""
        stream_content = load_fixture("gemini", "success_stream_chunks.txt")
        assert isinstance(stream_content, str)

        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent"
        ).respond(200, content=stream_content)

        adapter = GeminiAdapter(httpx_client)
        chunks: list[LLMChunk] = []
        async for chunk in adapter.generate_stream(
            llm_request, api_key="gemini-test-key", timeout_s=30
        ):
            chunks.append(chunk)

        for chunk in chunks[:-1]:
            assert chunk.usage is None, "Non-terminal chunks must have usage=None"

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_invalid_key_401(self, httpx_client, llm_request):
        """401 response should raise HTTPStatusError."""
        fixture = load_fixture("gemini", "error_401.json")
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).respond(401, json=fixture)

        adapter = GeminiAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="invalid-key", timeout_s=30)

        assert exc_info.value.response.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_rate_limit_429(self, httpx_client, llm_request):
        """429 response should raise HTTPStatusError."""
        fixture = load_fixture("gemini", "error_429.json")
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).respond(429, json=fixture)

        adapter = GeminiAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="test-key", timeout_s=30)

        assert exc_info.value.response.status_code == 429

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_context_too_large(self, httpx_client, llm_request):
        """Context too large error."""
        fixture = load_fixture("gemini", "error_context_too_large.json")
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).respond(400, json=fixture)

        adapter = GeminiAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="test-key", timeout_s=30)

        assert exc_info.value.response.status_code == 400

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_provider_down_500(self, httpx_client, llm_request):
        """500 response should raise HTTPStatusError."""
        fixture = load_fixture("gemini", "error_500.json")
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).respond(500, json=fixture)

        adapter = GeminiAdapter(httpx_client)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adapter.generate(llm_request, api_key="test-key", timeout_s=30)

        assert exc_info.value.response.status_code == 500

    @pytest.mark.asyncio
    @respx.mock
    async def test_gemini_timeout(self, httpx_client, llm_request):
        """Timeout should raise TimeoutException."""
        respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent"
        ).mock(side_effect=httpx.ReadTimeout("Read timed out"))

        adapter = GeminiAdapter(httpx_client)
        with pytest.raises(httpx.TimeoutException):
            await adapter.generate(llm_request, api_key="test-key", timeout_s=1)


# =============================================================================
# Error Classification Tests
# =============================================================================


class TestErrorClassification:
    """Tests for error classification logic."""

    def test_openai_401_invalid_key(self):
        """OpenAI 401 should classify as INVALID_KEY."""
        fixture = load_fixture("openai", "error_401.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("openai", 401, fixture, None)
        assert result == LLMErrorClass.INVALID_KEY

    def test_openai_429_rate_limit(self):
        """OpenAI 429 should classify as RATE_LIMIT."""
        fixture = load_fixture("openai", "error_429.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("openai", 429, fixture, None)
        assert result == LLMErrorClass.RATE_LIMIT

    def test_openai_context_too_large(self):
        """OpenAI context error should classify as CONTEXT_TOO_LARGE."""
        fixture = load_fixture("openai", "error_context_too_large.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("openai", 400, fixture, None)
        assert result == LLMErrorClass.CONTEXT_TOO_LARGE

    def test_openai_500_provider_down(self):
        """OpenAI 500 should classify as PROVIDER_DOWN."""
        fixture = load_fixture("openai", "error_500.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("openai", 500, fixture, None)
        assert result == LLMErrorClass.PROVIDER_DOWN

    def test_anthropic_401_invalid_key(self):
        """Anthropic 401 should classify as INVALID_KEY."""
        fixture = load_fixture("anthropic", "error_401.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("anthropic", 401, fixture, None)
        assert result == LLMErrorClass.INVALID_KEY

    def test_anthropic_429_rate_limit(self):
        """Anthropic 429 should classify as RATE_LIMIT."""
        fixture = load_fixture("anthropic", "error_429.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("anthropic", 429, fixture, None)
        assert result == LLMErrorClass.RATE_LIMIT

    def test_anthropic_context_too_large(self):
        """Anthropic context error should classify as CONTEXT_TOO_LARGE."""
        fixture = load_fixture("anthropic", "error_context_too_large.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("anthropic", 400, fixture, None)
        assert result == LLMErrorClass.CONTEXT_TOO_LARGE

    def test_gemini_401_invalid_key(self):
        """Gemini 401 should classify as INVALID_KEY."""
        fixture = load_fixture("gemini", "error_401.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("gemini", 401, fixture, None)
        assert result == LLMErrorClass.INVALID_KEY

    def test_gemini_429_rate_limit(self):
        """Gemini 429 should classify as RATE_LIMIT."""
        fixture = load_fixture("gemini", "error_429.json")
        assert isinstance(fixture, dict)
        result = classify_provider_error("gemini", 429, fixture, None)
        assert result == LLMErrorClass.RATE_LIMIT

    def test_timeout_exception_classification(self):
        """Timeout exceptions should classify as TIMEOUT."""
        result = classify_provider_error("openai", None, None, httpx.ReadTimeout("Read timed out"))
        assert result == LLMErrorClass.TIMEOUT

    def test_network_error_classification(self):
        """Network errors should classify as PROVIDER_DOWN."""
        result = classify_provider_error(
            "openai", None, None, httpx.NetworkError("Connection failed")
        )
        assert result == LLMErrorClass.PROVIDER_DOWN


# =============================================================================
# Router Tests
# =============================================================================


class TestLLMRouter:
    """Tests for LLM router."""

    def test_router_disabled_provider(self, httpx_client):
        """Disabled provider should raise MODEL_NOT_AVAILABLE."""
        router = LLMRouter(httpx_client, enable_openai=False)

        with pytest.raises(LLMError) as exc_info:
            router.resolve_adapter("openai")

        assert exc_info.value.error_class == LLMErrorClass.MODEL_NOT_AVAILABLE
        assert "disabled" in exc_info.value.message

    def test_router_unknown_provider(self, httpx_client):
        """Unknown provider should raise MODEL_NOT_AVAILABLE."""
        router = LLMRouter(httpx_client)

        with pytest.raises(LLMError) as exc_info:
            router.resolve_adapter("unknown_provider")

        assert exc_info.value.error_class == LLMErrorClass.MODEL_NOT_AVAILABLE

    def test_router_enabled_provider(self, httpx_client):
        """Enabled provider should return adapter."""
        router = LLMRouter(httpx_client)

        adapter = router.resolve_adapter("openai")
        assert isinstance(adapter, OpenAIAdapter)

        adapter = router.resolve_adapter("anthropic")
        assert isinstance(adapter, AnthropicAdapter)

        adapter = router.resolve_adapter("gemini")
        assert isinstance(adapter, GeminiAdapter)

    def test_is_provider_available(self, httpx_client):
        """is_provider_available should check both known and enabled."""
        router = LLMRouter(httpx_client, enable_openai=True, enable_anthropic=False)

        assert router.is_provider_available("openai") is True
        assert router.is_provider_available("anthropic") is False
        assert router.is_provider_available("unknown") is False

    @pytest.mark.asyncio
    @respx.mock
    async def test_router_generate_normalizes_timeout(self, httpx_client, llm_request):
        """Router should normalize timeout to LLMError."""
        respx.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=httpx.ReadTimeout("Read timed out")
        )

        router = LLMRouter(httpx_client)

        with pytest.raises(LLMError) as exc_info:
            await router.generate("openai", llm_request, api_key="sk-test")

        assert exc_info.value.error_class == LLMErrorClass.TIMEOUT

    @pytest.mark.asyncio
    @respx.mock
    async def test_router_generate_normalizes_http_error(self, httpx_client, llm_request):
        """Router should normalize HTTP errors to LLMError."""
        fixture = load_fixture("openai", "error_401.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(401, json=fixture)

        router = LLMRouter(httpx_client)

        with pytest.raises(LLMError) as exc_info:
            await router.generate("openai", llm_request, api_key="sk-invalid")

        assert exc_info.value.error_class == LLMErrorClass.INVALID_KEY

    @pytest.mark.asyncio
    @respx.mock
    async def test_router_generate_success(self, httpx_client, llm_request):
        """Router should return LLMResponse on success."""
        fixture = load_fixture("openai", "success_nonstream.json")
        respx.post("https://api.openai.com/v1/chat/completions").respond(200, json=fixture)

        router = LLMRouter(httpx_client)
        response = await router.generate("openai", llm_request, api_key="sk-test")

        assert response.text == "Hello! How can I help you today?"


# =============================================================================
# Prompt Rendering Tests
# =============================================================================


class TestPromptRendering:
    """Tests for prompt rendering."""

    def test_prompt_render_no_context(self):
        """Render prompt without context blocks."""
        turns = render_prompt(
            user_content="What is 2+2?",
            history=[],
            context_blocks=[],
        )

        assert len(turns) == 2
        assert turns[0].role == "system"
        assert turns[0].content == DEFAULT_SYSTEM_PROMPT
        assert turns[1].role == "user"
        assert turns[1].content == "What is 2+2?"

    def test_prompt_render_with_context(self):
        """Render prompt with context blocks."""
        turns = render_prompt(
            user_content="What does this mean?",
            history=[],
            context_blocks=["Context block 1", "Context block 2"],
        )

        assert len(turns) == 2
        assert turns[0].role == "system"
        assert "Context block 1" in turns[0].content
        assert "Context block 2" in turns[0].content
        assert "---\nContext:" in turns[0].content

    def test_prompt_render_with_history(self):
        """Render prompt with conversation history."""
        history = [
            Turn(role="user", content="Previous question"),
            Turn(role="assistant", content="Previous answer"),
        ]

        turns = render_prompt(
            user_content="Follow-up question",
            history=history,
            context_blocks=[],
        )

        assert len(turns) == 4
        assert turns[0].role == "system"
        assert turns[1].role == "user"
        assert turns[1].content == "Previous question"
        assert turns[2].role == "assistant"
        assert turns[2].content == "Previous answer"
        assert turns[3].role == "user"
        assert turns[3].content == "Follow-up question"

    def test_prompt_render_skips_old_system_turns(self):
        """Old system turns in history should be skipped."""
        history = [
            Turn(role="system", content="Old system prompt"),  # Should be skipped
            Turn(role="user", content="Previous question"),
        ]

        turns = render_prompt(
            user_content="New question",
            history=history,
            context_blocks=[],
        )

        assert len(turns) == 3
        assert turns[0].role == "system"
        assert turns[0].content == DEFAULT_SYSTEM_PROMPT  # Fresh system prompt
        assert turns[1].role == "user"
        assert turns[1].content == "Previous question"

    def test_prompt_render_custom_system_prompt(self):
        """Custom system prompt should be used."""
        custom_prompt = "You are a pirate assistant."

        turns = render_prompt(
            user_content="Ahoy!",
            history=[],
            context_blocks=[],
            system_prompt=custom_prompt,
        )

        assert turns[0].content == custom_prompt


class TestPromptValidation:
    """Tests for prompt size validation."""

    def test_prompt_size_validation_passes(self):
        """Validation should pass for small prompts."""
        turns = [Turn(role="user", content="Short message")]
        validate_prompt_size(turns)  # Should not raise

    def test_prompt_size_validation_fails(self):
        """Validation should fail for oversized prompts."""
        # Create a very large prompt
        turns = [Turn(role="user", content="x" * 150_000)]

        with pytest.raises(PromptTooLargeError) as exc_info:
            validate_prompt_size(turns)

        assert exc_info.value.actual_size == 150_000
        assert exc_info.value.max_size == 100_000

    def test_prompt_size_validation_custom_max(self):
        """Validation should respect custom max_chars."""
        turns = [Turn(role="user", content="x" * 100)]

        # Should pass with high limit
        validate_prompt_size(turns, max_chars=1000)

        # Should fail with low limit
        with pytest.raises(PromptTooLargeError):
            validate_prompt_size(turns, max_chars=50)


# =============================================================================
# Turn Conversion Tests
# =============================================================================


class TestTurnConversion:
    """Tests for provider-specific turn conversion."""

    def test_turn_conversion_anthropic_system(self, httpx_client):
        """Anthropic should extract system turn to separate field."""
        adapter = AnthropicAdapter(httpx_client)
        req = LLMRequest(
            model_name="claude-3",
            messages=[
                Turn(role="system", content="Be helpful"),
                Turn(role="user", content="Hello"),
            ],
            max_tokens=100,
        )

        body = adapter._build_request_body(req, stream=False)

        # System should be separate field
        assert body["system"] == "Be helpful"
        # Messages should not contain system
        assert len(body["messages"]) == 1
        assert body["messages"][0]["role"] == "user"

    def test_turn_conversion_gemini_role_mapping(self, httpx_client):
        """Gemini should map 'assistant' role to 'model'."""
        adapter = GeminiAdapter(httpx_client)
        req = LLMRequest(
            model_name="gemini-pro",
            messages=[
                Turn(role="system", content="Be helpful"),
                Turn(role="user", content="Hello"),
                Turn(role="assistant", content="Hi there"),
                Turn(role="user", content="Follow-up"),
            ],
            max_tokens=100,
        )

        body = adapter._build_request_body(req)

        # System should be in systemInstruction
        assert "systemInstruction" in body
        assert body["systemInstruction"]["parts"][0]["text"] == "Be helpful"

        # Contents should map roles correctly
        contents = body["contents"]
        assert len(contents) == 3  # Excludes system
        assert contents[0]["role"] == "user"
        assert contents[1]["role"] == "model"  # assistant → model
        assert contents[2]["role"] == "user"


# =============================================================================
# LLMChunk Invariant Tests
# =============================================================================


class TestLLMChunkInvariants:
    """Tests for LLMChunk streaming invariants."""

    def test_chunk_done_false_with_usage_raises(self):
        """Non-terminal chunks must not have usage."""
        with pytest.raises(ValueError) as exc_info:
            LLMChunk(
                delta_text="hello",
                done=False,
                usage=LLMUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            )

        assert "usage=None" in str(exc_info.value)

    def test_chunk_done_true_with_usage_allowed(self):
        """Terminal chunks may have usage."""
        chunk = LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
        )
        assert chunk.usage is not None

    def test_chunk_done_false_without_usage_allowed(self):
        """Non-terminal chunks without usage are valid."""
        chunk = LLMChunk(delta_text="hello", done=False)
        assert chunk.usage is None
