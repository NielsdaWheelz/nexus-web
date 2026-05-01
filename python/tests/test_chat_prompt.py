"""Tests for Nexus-owned structured chat prompt plans."""

import pytest

from nexus.services.chat_prompt import (
    PromptTooLargeError,
    build_llm_request_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
    validate_prompt_size,
)
from nexus.services.prompt_budget import make_prompt_block

pytestmark = pytest.mark.unit


def test_prompt_plan_keeps_stable_prefix_before_dynamic_blocks():
    system = make_prompt_block(
        block_id="system",
        role="system",
        lane="system",
        text=render_system_prompt_block(),
        cache_policy={"type": "ephemeral", "ttl_seconds": 300},
    )
    scope = make_prompt_block(
        block_id="scope",
        role="system",
        lane="scope",
        text='<conversation_scope type="media" />',
        cache_policy={"type": "ephemeral", "ttl_seconds": 300},
    )
    evidence = make_prompt_block(
        block_id="retrieval",
        role="system",
        lane="retrieved_evidence",
        text="<evidence>dynamic</evidence>",
    )
    current = make_prompt_block(
        block_id="current",
        role="user",
        lane="current_user",
        text="What changed?",
    )

    plan = build_prompt_plan(
        stable_blocks=[system, scope],
        dynamic_system_blocks=[evidence],
        history_blocks=[],
        current_user_block=current,
        cache_identity={"conversation_id": "c1", "provider": "openai"},
        model_name="gpt-test",
        max_tokens=100,
        reasoning_effort="none",
    )

    assert [block.id for block in plan.turns[0].blocks] == ["system", "scope", "retrieval"]
    assert plan.cacheable_input_tokens_estimate == system.estimated_tokens + scope.estimated_tokens
    assert plan.stable_prefix_hash


def test_prompt_plan_manifest_contains_no_raw_text():
    current = make_prompt_block(
        block_id="current",
        role="user",
        lane="current_user",
        text="private user text",
    )
    plan = build_prompt_plan(
        stable_blocks=[],
        dynamic_system_blocks=[],
        history_blocks=[],
        current_user_block=current,
        cache_identity={"conversation_id": "c1"},
        model_name="gpt-test",
        max_tokens=100,
        reasoning_effort="none",
    )

    manifest = plan.manifest()

    assert "private user text" not in str(manifest)
    assert manifest["provider_request_hash"] == plan.provider_request_hash


def test_llm_request_is_derived_from_structured_turns():
    current = make_prompt_block(
        block_id="current",
        role="user",
        lane="current_user",
        text="Follow up",
    )
    plan = build_prompt_plan(
        stable_blocks=[],
        dynamic_system_blocks=[],
        history_blocks=[],
        current_user_block=current,
        cache_identity={"conversation_id": "c1"},
        model_name="gpt-test",
        max_tokens=100,
        reasoning_effort="none",
    )

    request = build_llm_request_from_plan(
        plan=plan,
        provider="openai",
        model_name="gpt-test",
        max_tokens=100,
        reasoning_effort="none",
    )

    assert request.messages[0].content == "Follow up"
    assert request.prompt_cache_key == plan.stable_prefix_hash


def test_prompt_size_validation_fails():
    current = make_prompt_block(
        block_id="current",
        role="user",
        lane="current_user",
        text="x" * 150_000,
    )
    plan = build_prompt_plan(
        stable_blocks=[],
        dynamic_system_blocks=[],
        history_blocks=[],
        current_user_block=current,
        cache_identity={"conversation_id": "c1"},
        model_name="gpt-test",
        max_tokens=100,
        reasoning_effort="none",
    )

    with pytest.raises(PromptTooLargeError) as exc_info:
        validate_prompt_size(plan)

    assert exc_info.value.actual_size == 150_000
