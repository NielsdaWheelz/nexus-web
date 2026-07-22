"""Unit tests for chat_runs._max_output_tokens_for_reasoning.

Surviving nexus-side logic from the old OpenAI reasoning-contract suite: the
rest of that suite exercised the deleted model_id/key_mode request contract,
the deleted `Model` catalog table, and the deleted router-based
`execute_chat_run` signature — all superseded by tests/test_chat_runs.py
(request validation, citation persistence) and tests/test_llm_execution.py
(provider-call outcomes) against the new provider_runtime-backed contract.
This one pure function survived the cutover unchanged in spirit (just retyped
onto ChatModelContract), so it keeps a dedicated test.
"""

import dataclasses

import pytest
from provider_runtime import CATALOG, ProviderTarget

from nexus.services.chat_runs import (
    DEFAULT_OUTPUT_TOKENS,
    REASONING_OUTPUT_TOKENS,
    _max_output_tokens_for_reasoning,
)

pytestmark = pytest.mark.unit


def _contract(*, output_limit: int | None = None, reasoning_reserve_tokens: int):
    contract = CATALOG.chat_contract(ProviderTarget(provider="openai", model="gpt-5.6-sol"))
    contract = dataclasses.replace(
        contract,
        pricing=dataclasses.replace(
            contract.pricing, reasoning_reserve_tokens=reasoning_reserve_tokens
        ),
    )
    if output_limit is not None:
        contract = dataclasses.replace(contract, output_limit=output_limit)
    return contract


def test_reasoning_off_uses_default_output_budget():
    contract = _contract(reasoning_reserve_tokens=500)

    assert _max_output_tokens_for_reasoning(contract, "none") == DEFAULT_OUTPUT_TOKENS


def test_reasoning_on_uses_reasoning_output_budget_when_model_reserves_reasoning_tokens():
    contract = _contract(reasoning_reserve_tokens=500)

    assert _max_output_tokens_for_reasoning(contract, "default") == REASONING_OUTPUT_TOKENS
    assert _max_output_tokens_for_reasoning(contract, "high") == REASONING_OUTPUT_TOKENS


def test_reasoning_on_falls_back_to_default_budget_when_model_has_no_reasoning_reserve():
    contract = _contract(reasoning_reserve_tokens=0)

    assert _max_output_tokens_for_reasoning(contract, "default") == DEFAULT_OUTPUT_TOKENS


def test_output_budget_is_capped_by_the_catalog_output_limit():
    contract = _contract(reasoning_reserve_tokens=500, output_limit=1)

    assert _max_output_tokens_for_reasoning(contract, "default") == 1
