"""Tests for Nexus-owned structured chat prompt plans and their translation
into the runtime's ``GenerateIntent`` (C1 stability table)."""

import pytest
from provider_runtime import (
    Dynamic,
    GlobalScope,
    ProviderTarget,
    Stable,
    SystemMessage,
    UserMessage,
)

from nexus.services.chat_prompt import (
    PromptTooLargeError,
    build_generate_intent_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
    validate_prompt_size,
)
from nexus.services.prompt_budget import make_prompt_block

pytestmark = pytest.mark.unit

_TARGET = ProviderTarget(provider="openai", model="gpt-5.6-terra")


def test_system_prompt_names_resources_and_strict_tools():
    prompt = render_system_prompt_block()

    assert "<subject>" in prompt
    assert "<resources>" in prompt
    assert "<reader_selection>" in prompt
    assert "n attribute" in prompt
    assert 'inspect_resource("media:...")' in prompt
    assert "read_resource(uri)" in prompt
    assert "app_search(query=..., scopes=[...])" in prompt
    assert "pinned" not in prompt.lower()


def test_prompt_plan_keeps_stable_prefix_before_dynamic_blocks():
    system = make_prompt_block(
        block_id="system",
        role="system",
        lane="system",
        text=render_system_prompt_block(),
        cache_policy={"type": "ephemeral", "ttl_seconds": 300},
        privacy_scope="global",
    )
    scope = make_prompt_block(
        block_id="scope",
        role="system",
        lane="scope",
        text='<conversation_scope type="media" />',
        cache_policy={"type": "ephemeral", "ttl_seconds": 300},
        privacy_scope="global",
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
    )

    assert [block.id for block in plan.turns[0].blocks] == ["system", "scope", "retrieval"]
    assert plan.cacheable_input_tokens_estimate == system.estimated_tokens + scope.estimated_tokens


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
    )

    manifest = plan.manifest()

    assert "private user text" not in str(manifest)
    assert "stable_prefix_hash" not in manifest
    assert "provider_request_hash" not in manifest


def test_generate_intent_is_derived_from_structured_turns():
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
    )

    intent = build_generate_intent_from_plan(
        plan=plan,
        target=_TARGET,
        max_output_tokens=100,
        reasoning="none",
        tools=(),
    )

    assert intent.target == _TARGET
    assert intent.tool_choice == "none"
    last_message = intent.messages[-1]
    assert isinstance(last_message, UserMessage)
    assert last_message.blocks[0].text == "Follow up"


def test_generate_intent_marks_global_privacy_scope_blocks_stable():
    system = make_prompt_block(
        block_id="system",
        role="system",
        lane="system",
        text=render_system_prompt_block(),
        cache_policy={"type": "ephemeral", "ttl_seconds": 300},
        privacy_scope="global",
    )
    subject = make_prompt_block(
        block_id="subject",
        role="system",
        lane="attached_context",
        text="<subject>...</subject>",
    )
    current = make_prompt_block(
        block_id="current",
        role="user",
        lane="current_user",
        text="Follow up",
    )
    plan = build_prompt_plan(
        stable_blocks=[system],
        dynamic_system_blocks=[subject],
        history_blocks=[],
        current_user_block=current,
    )

    intent = build_generate_intent_from_plan(
        plan=plan,
        target=_TARGET,
        max_output_tokens=100,
        reasoning="medium",
        tools=(),
    )

    system_message = intent.messages[0]
    assert isinstance(system_message, SystemMessage)
    system_block, subject_block = system_message.blocks
    assert system_block.stability == Stable(GlobalScope())
    assert subject_block.stability == Dynamic()


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
    )

    with pytest.raises(PromptTooLargeError) as exc_info:
        validate_prompt_size(plan)

    assert exc_info.value.actual_size == 150_000
