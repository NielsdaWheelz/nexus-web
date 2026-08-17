from __future__ import annotations

import ast
import asyncio
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from provider_runtime import (
    CanonicalTool,
    Failed,
    GenerateIntent,
    PromptBlock,
    ProviderTarget,
    TerminalEvent,
    TextOutput,
    UserMessage,
)
from provider_runtime.errors import InvalidRequest
from provider_runtime.types import ImageBlock, StrictJsonOutput

from nexus.config import Environment, Settings
from nexus.services.llm_credentials import provider_credentials
from nexus.services.llm_execution import (
    GenerationRequest,
    ProviderRetryMode,
    build_execution_runtime,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import profile

_NEXUS_ROOT = Path(__file__).parents[2] / "nexus"

# These are the exhaustive runtime-composition sites. Dossier, chat, and media
# contain BilledOnce generation; every other task delegates retries to v2.
_TASK_RUNTIME_RETRY_MODES = {
    ("tasks/artifacts.py", "dossier_build"): ProviderRetryMode.SingleAttempt,
    ("tasks/chat_run.py", "chat_run"): ProviderRetryMode.SingleAttempt,
    ("tasks/dawn_write.py", "dawn_write_sweep"): ProviderRetryMode.Default,
    ("tasks/media_unit_build.py", "media_unit_build"): ProviderRetryMode.SingleAttempt,
    ("tasks/oracle_reading.py", "oracle_reading"): ProviderRetryMode.Default,
    ("tasks/synapse_scan.py", "synapse_scan"): ProviderRetryMode.Default,
}


class _TaskRuntimeVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.specs: set[tuple[str, str]] = set()

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name) and node.func.id == "LlmTaskSpec":
            label = next(
                (
                    keyword.value.value
                    for keyword in node.keywords
                    if keyword.arg == "label" and isinstance(keyword.value, ast.Constant)
                ),
                None,
            )
            if isinstance(label, str):
                mode = next(
                    (
                        ast.unparse(keyword.value)
                        for keyword in node.keywords
                        if keyword.arg == "retry_mode"
                    ),
                    "ProviderRetryMode.Default",
                )
                self.specs.add((label, mode))
        self.generic_visit(node)


def _settings() -> Settings:
    return Settings.model_construct(
        openai_api_key="openai-test",
        anthropic_api_key="anthropic-test",
        gemini_api_key="gemini-test",
        moonshot_api_key="moonshot-test",
        deepseek_api_key="deepseek-test",
    )


def _intent() -> GenerateIntent:
    return GenerateIntent(
        target=ProviderTarget(provider="openai", model="gpt-5.6-luna"),
        messages=(UserMessage(blocks=(PromptBlock(text="Hello"),)),),
        max_output_tokens=16,
        reasoning="low",
        tools=(),
        tool_choice="auto",
        output=TextOutput(),
    )


def _generation_request(intent: GenerateIntent) -> GenerationRequest:
    product_profile = profile("fast")
    assert product_profile is not None
    return GenerationRequest(
        generation_id=uuid4(),
        owner=LlmCallOwner(kind="chat_run", id=uuid4(), user_id=uuid4()),
        operation="chat",
        profile=product_profile,
        reasoning="low",
        intent=intent,
    )


def test_provider_credentials_expose_only_the_five_product_keys() -> None:
    credentials = provider_credentials(_settings())

    assert credentials.openai == "openai-test"
    assert credentials.anthropic == "anthropic-test"
    assert credentials.gemini == "gemini-test"
    assert credentials.moonshot == "moonshot-test"
    assert credentials.deepseek == "deepseek-test"
    assert credentials.openrouter is None
    assert credentials.xai is None


def test_production_settings_require_the_deepseek_product_credential() -> None:
    settings = Settings.model_construct(
        nexus_env=Environment.PROD,
        database_url="postgresql://nexus.invalid/nexus",
        supabase_jwks_url="https://auth.example.invalid/.well-known/jwks.json",
        supabase_issuer="https://auth.example.invalid",
        supabase_audiences="authenticated",
        nexus_internal_secret="test-internal-secret",
        r2_s3_api_origin="https://test.r2.cloudflarestorage.com",
        r2_access_key_id="test-access-key",
        r2_secret_access_key="test-secret-key",
        r2_bucket="test-bucket",
        podcasts_enabled=False,
        billing_enabled=False,
        youtube_data_api_key="test-youtube-key",
        openai_api_key="openai-test",
        anthropic_api_key="anthropic-test",
        gemini_api_key="gemini-test",
        moonshot_api_key="moonshot-test",
        deepseek_api_key=None,
        nexus_fable_retention_accepted_at="2026-08-11T00:00:00+00:00",
    )

    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
        settings.validate_required_settings()


def test_single_attempt_runtime_dispatches_generate_and_stream_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_BASE_URL", "http://127.0.0.1:1/legacy-gateway")
    requests: list[str] = []

    async def unavailable(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(
            503,
            request=request,
            json={"error": {"message": "temporarily unavailable", "type": "server_error"}},
        )

    async def run() -> tuple[Failed, Failed]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(unavailable)) as client:
            runtime = build_execution_runtime(
                _settings(),
                client,
                retry_mode=ProviderRetryMode.SingleAttempt,
            )
            generated = await runtime.generate(_intent())
            stream_terminal = None
            async for event in runtime.stream(_intent()):
                if isinstance(event.event, TerminalEvent):
                    stream_terminal = event.event.outcome
            assert isinstance(generated, Failed)
            assert isinstance(stream_terminal, Failed)
            return generated, stream_terminal

    generated, streamed = asyncio.run(run())

    assert len(requests) == 2, requests
    assert len(generated.meta.attempt_trace) == 1
    assert len(streamed.meta.attempt_trace) == 1
    assert all(url.startswith("https://api.openai.com/") for url in requests)


def test_generation_request_rejects_reasoning_not_offered_by_the_product_profile() -> None:
    product_profile = profile("fast")
    assert product_profile is not None
    intent = replace(_intent(), reasoning="minimal")

    with pytest.raises(InvalidRequest, match="not offered"):
        GenerationRequest(
            generation_id=uuid4(),
            owner=LlmCallOwner(kind="chat_run", id=uuid4(), user_id=uuid4()),
            operation="chat",
            profile=product_profile,
            reasoning="minimal",
            intent=intent,
        )


def test_every_llm_task_composes_the_expected_provider_retry_mode() -> None:
    actual: dict[tuple[str, str], ProviderRetryMode] = {}
    tasks_root = _NEXUS_ROOT / "tasks"
    for path in tasks_root.glob("*.py"):
        visitor = _TaskRuntimeVisitor()
        visitor.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        relative = path.relative_to(_NEXUS_ROOT).as_posix()
        for label, mode in visitor.specs:
            actual[(relative, label)] = ProviderRetryMode(mode.removeprefix("ProviderRetryMode."))

    assert set(actual) == set(_TASK_RUNTIME_RETRY_MODES)
    assert actual == _TASK_RUNTIME_RETRY_MODES


def test_api_idea_resolver_dependency_is_single_attempt() -> None:
    source = (_NEXUS_ROOT / "api/deps.py").read_text(encoding="utf-8")
    tree = ast.parse(source, filename="nexus/api/deps.py")
    functions = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
    }
    dependency = functions["get_single_attempt_execution_runtime"]
    calls = [
        node
        for node in ast.walk(dependency)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "build_execution_runtime"
    ]
    assert len(calls) == 1
    retry_mode = next(keyword.value for keyword in calls[0].keywords if keyword.arg == "retry_mode")
    assert ast.unparse(retry_mode) == "ProviderRetryMode.SingleAttempt"


@pytest.mark.parametrize(
    ("case", "intent"),
    (
        (
            "target mismatch",
            replace(
                _intent(),
                target=ProviderTarget(provider="deepseek", model="deepseek-v4-pro"),
            ),
        ),
        ("reasoning mismatch", replace(_intent(), reasoning="high")),
        (
            "image input",
            replace(
                _intent(),
                messages=(
                    UserMessage(blocks=(ImageBlock(media_type="image/png", data=b"image"),)),
                ),
            ),
        ),
        ("provider options", replace(_intent(), provider_options={"custom": True})),
        (
            "tools plus strict output",
            replace(
                _intent(),
                tools=(
                    CanonicalTool(
                        name="lookup",
                        description="Lookup a value.",
                        parameters={"type": "object", "properties": {}},
                    ),
                ),
                output=StrictJsonOutput(
                    name="answer",
                    schema={"type": "object", "properties": {}},
                ),
            ),
        ),
        ("nonpositive output", replace(_intent(), max_output_tokens=0)),
        ("output above registry cap", replace(_intent(), max_output_tokens=128_001)),
        (
            "input above context bound",
            replace(
                _intent(),
                messages=(UserMessage(blocks=(PromptBlock(text="x" * 1_050_001),)),),
            ),
        ),
    ),
)
def test_generation_request_rejects_unsupported_product_capabilities_before_execution(
    case: str,
    intent: GenerateIntent,
) -> None:
    with pytest.raises(InvalidRequest) as raised:
        _generation_request(intent)
    assert raised.value.message, case
