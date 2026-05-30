"""Provider-neutral structured prompt plans for durable chat runs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, cast

from llm_calling.types import LLMRequest, ReasoningEffort, Turn

from nexus.services.prompt_budget import (
    ContextBudgetError,
    PromptBlock,
    estimate_block_tokens,
)

PROMPT_PLAN_VERSION = "prompt-plan-v1"
SYSTEM_PROMPT_VERSION = "system-v3"
MAX_PROMPT_CHARS = 100_000


class PromptTooLargeError(Exception):
    """Raised when rendered prompt text exceeds the provider-neutral limit."""

    def __init__(self, actual_size: int, max_size: int):
        self.actual_size = actual_size
        self.max_size = max_size
        super().__init__(f"Prompt size {actual_size} exceeds max {max_size}")


@dataclass(frozen=True)
class PromptTurn:
    role: Literal["system", "user", "assistant"]
    blocks: tuple[PromptBlock, ...]


@dataclass(frozen=True)
class PromptPlan:
    version: str
    turns: tuple[PromptTurn, ...]
    stable_prefix_hash: str
    cacheable_input_tokens_estimate: int
    provider_request_hash: str

    def blocks(self) -> tuple[PromptBlock, ...]:
        return tuple(block for turn in self.turns for block in turn.blocks)

    def text_char_count(self) -> int:
        return sum(len(block.text) for block in self.blocks())

    def manifest(self) -> dict[str, object]:
        return {
            "version": self.version,
            "stable_prefix_hash": self.stable_prefix_hash,
            "cacheable_input_tokens_estimate": self.cacheable_input_tokens_estimate,
            "provider_request_hash": self.provider_request_hash,
            "blocks": [
                block.manifest_entry(ordinal=index, included=True)
                for index, block in enumerate(self.blocks())
            ],
        }


def render_system_prompt_block() -> str:
    """Render invariant assistant instructions without per-turn evidence."""

    return (
        "You are a reading assistant for the user's saved articles, books, podcasts, "
        "and PDFs. Pinned sources and tool results are numbered with an n attribute. "
        "When you use information from a pinned source or tool result, cite it as [N] "
        "using its exact n. Never invent an [N]: only use values that appear as n "
        "attributes in this turn. Cite distinct sources separately and adjacently when "
        "a claim draws on more than one (e.g. [2][4]); do not concatenate numbers. "
        "Cite only pinned-source or tool-result facts, not world knowledge. "
        "Any <reader_selection> block is the exact passage the user is currently looking "
        'at and asking about; treat pronouns like "this", "it", or "the quote" as '
        "referring to that selection unless the user clearly means something else. "
        "When you need more text from the pinned media beyond what's already shown, "
        "call app_search with a bare query — it defaults to the pinned scope."
    )


def build_prompt_plan(
    *,
    stable_blocks: Sequence[PromptBlock],
    dynamic_system_blocks: Sequence[PromptBlock],
    history_blocks: Sequence[PromptBlock],
    current_user_block: PromptBlock,
    cache_identity: Mapping[str, object],
    model_name: str,
    max_tokens: int,
    reasoning_effort: str,
) -> PromptPlan:
    """Build the ordered prompt plan and its non-text hashes."""

    stable = tuple(stable_blocks)
    dynamic = tuple(dynamic_system_blocks)
    history = tuple(history_blocks)
    system_blocks = stable + dynamic
    turns: list[PromptTurn] = []
    if system_blocks:
        turns.append(PromptTurn(role="system", blocks=system_blocks))
    turns.extend(PromptTurn(role=block.role, blocks=(block,)) for block in history)
    turns.append(PromptTurn(role="user", blocks=(current_user_block,)))

    stable_prefix_hash = _hash_json(
        {
            "version": PROMPT_PLAN_VERSION,
            "cache_identity": dict(cache_identity),
            "block_hashes": [block.stable_hash for block in stable],
        }
    )
    provider_request_hash = _hash_json(
        {
            "version": PROMPT_PLAN_VERSION,
            "stable_prefix_hash": stable_prefix_hash,
            "model_name": model_name,
            "max_tokens": max_tokens,
            "reasoning_effort": reasoning_effort,
            "turns": [
                {
                    "role": turn.role,
                    "block_hashes": [block.stable_hash for block in turn.blocks],
                }
                for turn in turns
            ],
        }
    )
    return PromptPlan(
        version=PROMPT_PLAN_VERSION,
        turns=tuple(turns),
        stable_prefix_hash=stable_prefix_hash,
        cacheable_input_tokens_estimate=estimate_block_tokens(stable),
        provider_request_hash=provider_request_hash,
    )


def build_llm_request_from_plan(
    *,
    plan: PromptPlan,
    provider: str,
    model_name: str,
    max_tokens: int,
    reasoning_effort: str,
) -> LLMRequest:
    """Derive the provider request from the prompt plan exactly once."""

    messages: list[Turn] = []
    for turn in plan.turns:
        for block in turn.blocks:
            cache_ttl = "none"
            if block.cache_policy is not None:
                ttl_seconds = block.cache_policy.get("ttl_seconds")
                if ttl_seconds == 300:
                    cache_ttl = "5m"
                elif ttl_seconds == 3600:
                    cache_ttl = "1h"
            messages.append(
                Turn(
                    role=turn.role,
                    content=block.text,
                    cache_ttl=cache_ttl,
                )
            )

    return LLMRequest(
        model_name=model_name,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.7,
        reasoning_effort=cast(ReasoningEffort, reasoning_effort),
        prompt_cache_key=plan.stable_prefix_hash if provider == "openai" else None,
    )


def validate_prompt_plan_budget(plan: PromptPlan, input_budget_tokens: int) -> int:
    """Validate final structured prompt blocks against the computed input budget."""

    estimated_tokens = estimate_block_tokens(plan.blocks()) + len(plan.turns) * 4
    if estimated_tokens > input_budget_tokens:
        raise ContextBudgetError(
            "Assembled prompt exceeds the model input budget",
            requested_tokens=estimated_tokens,
            remaining_tokens=input_budget_tokens,
        )
    return estimated_tokens


def validate_prompt_size(plan: PromptPlan, max_chars: int = MAX_PROMPT_CHARS) -> None:
    total = plan.text_char_count()
    if total > max_chars:
        raise PromptTooLargeError(total, max_chars)


def _hash_json(value: Mapping[str, object]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
