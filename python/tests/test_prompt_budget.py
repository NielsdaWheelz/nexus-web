"""Tests for chat prompt token budgeting."""

import pytest

from nexus.services.prompt_budget import (
    BudgetItem,
    ContextBudgetError,
    allocate_budget,
    build_prompt_budget,
    estimate_tokens,
    make_prompt_block,
)

pytestmark = pytest.mark.unit


def test_estimate_tokens_is_conservative_for_words_and_chars():
    assert estimate_tokens("one two three four") >= 8
    assert estimate_tokens("x" * 90) >= 30
    assert estimate_tokens("") == 0


def test_build_prompt_budget_reserves_output_and_reasoning_tokens():
    budget = build_prompt_budget(
        max_context_tokens=10000,
        max_output_tokens=1000,
        provider="openai",
        reasoning="medium",
    )

    assert budget.reserved_output_tokens == 1000
    assert budget.reserved_reasoning_tokens == 4096
    assert budget.input_budget_tokens == 4904


def test_allocate_budget_drops_optional_items_by_lane_budget():
    budget = build_prompt_budget(
        max_context_tokens=240,
        max_output_tokens=40,
        provider="openai",
        reasoning="none",
    )
    selection = allocate_budget(
        [
            BudgetItem(
                key="system",
                lane="system",
                blocks=(
                    make_prompt_block(
                        block_id="system",
                        role="system",
                        lane="system",
                        text="system",
                    ),
                ),
                mandatory=True,
            ),
            BudgetItem(
                key="current",
                lane="current_user",
                blocks=(
                    make_prompt_block(
                        block_id="current",
                        role="user",
                        lane="current_user",
                        text="question",
                    ),
                ),
                mandatory=True,
            ),
            BudgetItem(
                key="history:new",
                lane="recent_history",
                blocks=(
                    make_prompt_block(
                        block_id="history:new",
                        role="user",
                        lane="recent_history",
                        text="new " * 30,
                    ),
                ),
                mandatory=False,
                priority=2,
            ),
            BudgetItem(
                key="history:old",
                lane="recent_history",
                blocks=(
                    make_prompt_block(
                        block_id="history:old",
                        role="user",
                        lane="recent_history",
                        text="old " * 200,
                    ),
                ),
                mandatory=False,
                priority=1,
            ),
        ],
        budget,
    )

    assert selection.included_keys() == {"system", "current", "history:new"}
    assert [item.key for item in selection.dropped] == ["history:old"]
    assert selection.dropped[0].reason == "budget_exceeded"


def test_allocate_budget_raises_when_mandatory_item_cannot_fit():
    budget = build_prompt_budget(
        max_context_tokens=120,
        max_output_tokens=40,
        provider="openai",
        reasoning="none",
    )

    with pytest.raises(ContextBudgetError) as exc_info:
        allocate_budget(
            [
                BudgetItem(
                    key="attached",
                    lane="attached_context",
                    blocks=(
                        make_prompt_block(
                            block_id="attached",
                            role="system",
                            lane="attached_context",
                            text="mandatory " * 200,
                        ),
                    ),
                    mandatory=True,
                )
            ],
            budget,
        )

    assert exc_info.value.lane == "attached_context"
    assert exc_info.value.item_key == "attached"


def test_prompt_block_manifest_excludes_text():
    block = make_prompt_block(
        block_id="retrieved:1",
        role="system",
        lane="retrieved_evidence",
        text="quoted evidence",
        source_refs=[{"type": "message_retrieval", "id": "retrieval-1"}],
    )

    manifest = block.manifest_entry(ordinal=0, included=True)

    assert manifest["stable_hash"] == block.stable_hash
    assert "quoted evidence" not in str(manifest)
