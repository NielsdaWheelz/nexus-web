"""Provider-neutral structured prompt plans for durable chat runs."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast

from provider_runtime import PromptCacheTTL
from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelRef,
    ProviderName,
    ReasoningConfig,
    ReasoningEffort,
)

from nexus.services.prompt_budget import (
    ContextBudgetError,
    PromptBlock,
    estimate_block_tokens,
)

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
    turns: tuple[PromptTurn, ...]
    cacheable_input_tokens_estimate: int

    def blocks(self) -> tuple[PromptBlock, ...]:
        return tuple(block for turn in self.turns for block in turn.blocks)

    def text_char_count(self) -> int:
        return sum(len(block.text) for block in self.blocks())

    def manifest(self) -> dict[str, object]:
        return {
            "cacheable_input_tokens_estimate": self.cacheable_input_tokens_estimate,
            "blocks": [
                block.manifest_entry(ordinal=index, included=True)
                for index, block in enumerate(self.blocks())
            ],
        }


def render_system_prompt_block() -> str:
    """Render invariant assistant instructions without per-turn evidence."""

    return (
        "You are a reading assistant for the user's saved articles, books, podcasts, "
        "videos, and PDFs. "
        "Referenced resources appear in a <resources> block; a highlight there carries a "
        "<quote> with the passage and its surrounding context. Each citable resource and "
        "each citable tool result is numbered with an n attribute. "
        "When you use information from a numbered resource or tool result, cite it as [N] "
        "using its exact n. Never invent an [N]: only use values that appear as n "
        "attributes in this turn. Cite distinct sources separately and adjacently when a "
        "claim draws on more than one (e.g. [2][4]); do not concatenate numbers. "
        "Cite only resource or tool-result facts, not world knowledge. "
        "Any <reader_selection> block is the exact passage the user is currently looking "
        'at and asking about; treat pronouns like "this", "it", or "the quote" as '
        "referring to that selection unless the user clearly means something else. "
        "You have three tools for the user's content. "
        "app_search(query=..., scopes=[...]) finds relevant passages across referenced "
        "media and libraries; omit scopes to search this conversation's context refs. "
        'inspect_resource("media:...") returns a document map — an ordered list of '
        "sections, each with a label, a short preview, and a read_uri. "
        "read_resource(uri) returns exact text for a resource or a read_uri and labels it "
        "with a kind (quote, section, page_range, full, or too_large); a too_large result "
        "means the document is too big to read whole, so call inspect_resource first and "
        "read the sections you need. "
        "To use a whole document, search it or inspect its map, then read the relevant "
        "parts."
    )


def build_prompt_plan(
    *,
    stable_blocks: Sequence[PromptBlock],
    dynamic_system_blocks: Sequence[PromptBlock],
    history_blocks: Sequence[PromptBlock],
    current_user_block: PromptBlock,
) -> PromptPlan:
    """Build the ordered prompt plan."""

    stable = tuple(stable_blocks)
    dynamic = tuple(dynamic_system_blocks)
    history = tuple(history_blocks)
    system_blocks = stable + dynamic
    turns: list[PromptTurn] = []
    if system_blocks:
        turns.append(PromptTurn(role="system", blocks=system_blocks))
    turns.extend(PromptTurn(role=block.role, blocks=(block,)) for block in history)
    turns.append(PromptTurn(role="user", blocks=(current_user_block,)))

    return PromptPlan(
        turns=tuple(turns),
        cacheable_input_tokens_estimate=estimate_block_tokens(stable),
    )


def build_llm_request_from_plan(
    *,
    plan: PromptPlan,
    provider: str,
    model_name: str,
    max_tokens: int,
    reasoning_effort: str,
) -> ModelCall:
    """Derive the provider request from the prompt plan exactly once."""

    messages: list[ModelMessage] = []
    for turn in plan.turns:
        for block in turn.blocks:
            cache_ttl = cache_ttl_from_policy(block.cache_policy) or "none"
            messages.append(
                ModelMessage(
                    role=turn.role,
                    content=block.text,
                    cache_ttl=cache_ttl,
                )
            )

    return ModelCall(
        model=ModelRef(provider=cast(ProviderName, provider), model=model_name),
        messages=messages,
        max_output_tokens=max_tokens,
        temperature=0.7,
        reasoning=ReasoningConfig(effort=cast(ReasoningEffort, reasoning_effort)),
    )


def cache_ttl_from_policy(cache_policy: object) -> PromptCacheTTL | None:
    if not isinstance(cache_policy, dict):
        return None
    ttl_seconds = cache_policy.get("ttl_seconds")
    if ttl_seconds == 300:
        return "5m"
    if ttl_seconds == 3600:
        return "1h"
    return None


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
