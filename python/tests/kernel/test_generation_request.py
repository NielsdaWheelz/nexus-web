"""Unit tests for product generation-request validation."""

from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

import pytest
from provider_runtime import (
    CanonicalTool,
    GenerateIntent,
    PromptBlock,
    ProviderTarget,
    TextOutput,
    UserMessage,
)
from provider_runtime.errors import InvalidRequest
from provider_runtime.types import ImageBlock, StrictJsonOutput

from nexus.services.llm_execution import GenerationRequest
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import profile


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
