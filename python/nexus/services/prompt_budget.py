"""Token budget helpers for chat context assembly."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from math import ceil
from typing import Literal

from llm_calling.types import Turn

from nexus.errors import ApiErrorCode

BudgetLane = Literal[
    "system",
    "scope",
    "current_user",
    "attached_context",
    "retrieved_evidence",
    "state_snapshot",
    "memory",
    "recent_history",
    "pointer_refs",
]

DropReason = Literal["budget_exceeded"]

LANE_ORDER: tuple[BudgetLane, ...] = (
    "system",
    "scope",
    "current_user",
    "attached_context",
    "retrieved_evidence",
    "state_snapshot",
    "memory",
    "recent_history",
    "pointer_refs",
)

REASONING_TOKEN_RESERVE = {
    "none": 0,
    "default": 2048,
    "low": 1024,
    "medium": 4096,
    "high": 8192,
    "max": 16384,
}


class ContextBudgetError(ValueError):
    """Raised when mandatory assembled context cannot fit the model input budget."""

    api_error_code = ApiErrorCode.E_LLM_CONTEXT_TOO_LARGE

    def __init__(
        self,
        message: str,
        *,
        lane: BudgetLane | None = None,
        item_key: str | None = None,
        requested_tokens: int | None = None,
        remaining_tokens: int | None = None,
    ) -> None:
        super().__init__(message)
        self.lane = lane
        self.item_key = item_key
        self.requested_tokens = requested_tokens
        self.remaining_tokens = remaining_tokens


@dataclass(frozen=True)
class PromptBudget:
    max_context_tokens: int
    reserved_output_tokens: int
    reserved_reasoning_tokens: int
    input_budget_tokens: int


@dataclass(frozen=True)
class BudgetItem:
    key: str
    lane: BudgetLane
    text: str
    mandatory: bool
    priority: int = 0
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class IncludedBudgetItem:
    key: str
    lane: BudgetLane
    text: str
    estimated_tokens: int
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class DroppedBudgetItem:
    key: str
    lane: BudgetLane
    reason: DropReason
    estimated_tokens: int
    metadata: Mapping[str, object]

    def to_json(self) -> dict[str, object]:
        return {
            "key": self.key,
            "lane": self.lane,
            "reason": self.reason,
            "estimated_tokens": self.estimated_tokens,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class BudgetSelection:
    budget: PromptBudget
    included: tuple[IncludedBudgetItem, ...]
    dropped: tuple[DroppedBudgetItem, ...]
    estimated_input_tokens: int
    breakdown: Mapping[str, object]

    def included_keys(self) -> set[str]:
        return {item.key for item in self.included}


def estimate_tokens(text: str) -> int:
    """Conservatively estimate tokens for provider-neutral prompt assembly."""

    if not text:
        return 0
    non_ascii = sum(1 for char in text if ord(char) > 127)
    char_estimate = ceil(len(text) / 3)
    word_estimate = len(text.split()) * 2
    return max(1, char_estimate, word_estimate, non_ascii)


def estimate_turn_tokens(turns: Sequence[Turn]) -> int:
    """Estimate provider input tokens for a list of chat turns."""

    return sum(estimate_tokens(turn.content) + 4 for turn in turns)


def estimate_reasoning_reserve(provider: str, reasoning: str) -> int:
    """Reserve hidden reasoning budget for reasoning-capable providers."""

    if provider != "openai":
        return 0
    return REASONING_TOKEN_RESERVE.get(reasoning, 0)


def build_prompt_budget(
    *,
    max_context_tokens: int,
    max_output_tokens: int,
    provider: str,
    reasoning: str,
) -> PromptBudget:
    """Compute the model input budget after output and reasoning reserves."""

    reserved_output_tokens = max(0, max_output_tokens)
    reserved_reasoning_tokens = max(0, estimate_reasoning_reserve(provider, reasoning))
    input_budget_tokens = max_context_tokens - reserved_output_tokens - reserved_reasoning_tokens
    if input_budget_tokens <= 0:
        raise ContextBudgetError(
            "Model context window is exhausted by output and reasoning reserves",
            requested_tokens=reserved_output_tokens + reserved_reasoning_tokens,
            remaining_tokens=max_context_tokens,
        )
    return PromptBudget(
        max_context_tokens=max_context_tokens,
        reserved_output_tokens=reserved_output_tokens,
        reserved_reasoning_tokens=reserved_reasoning_tokens,
        input_budget_tokens=input_budget_tokens,
    )


def allocate_budget(items: Sequence[BudgetItem], budget: PromptBudget) -> BudgetSelection:
    """Allocate prompt input tokens by lane, preserving caller order inside each lane."""

    items_by_lane: dict[BudgetLane, list[BudgetItem]] = defaultdict(list)
    for item in items:
        items_by_lane[item.lane].append(item)

    included: list[IncludedBudgetItem] = []
    dropped: list[DroppedBudgetItem] = []
    remaining = budget.input_budget_tokens
    lane_breakdown: dict[str, dict[str, int]] = {
        lane: {
            "included_tokens": 0,
            "dropped_tokens": 0,
            "included_count": 0,
            "dropped_count": 0,
        }
        for lane in LANE_ORDER
    }

    for lane in LANE_ORDER:
        lane_items = sorted(items_by_lane[lane], key=lambda item: item.priority, reverse=True)
        for item in lane_items:
            item_tokens = estimate_tokens(item.text)
            if item_tokens <= remaining:
                included.append(
                    IncludedBudgetItem(
                        key=item.key,
                        lane=item.lane,
                        text=item.text,
                        estimated_tokens=item_tokens,
                        metadata=item.metadata,
                    )
                )
                remaining -= item_tokens
                lane_breakdown[lane]["included_tokens"] += item_tokens
                lane_breakdown[lane]["included_count"] += 1
                continue

            if item.mandatory:
                raise ContextBudgetError(
                    "Mandatory prompt context cannot fit the model input budget",
                    lane=item.lane,
                    item_key=item.key,
                    requested_tokens=item_tokens,
                    remaining_tokens=remaining,
                )

            dropped.append(
                DroppedBudgetItem(
                    key=item.key,
                    lane=item.lane,
                    reason="budget_exceeded",
                    estimated_tokens=item_tokens,
                    metadata=item.metadata,
                )
            )
            lane_breakdown[lane]["dropped_tokens"] += item_tokens
            lane_breakdown[lane]["dropped_count"] += 1

    estimated_input_tokens = budget.input_budget_tokens - remaining
    return BudgetSelection(
        budget=budget,
        included=tuple(included),
        dropped=tuple(dropped),
        estimated_input_tokens=estimated_input_tokens,
        breakdown={
            "lanes": lane_breakdown,
            "remaining_tokens": remaining,
            "input_budget_tokens": budget.input_budget_tokens,
            "reserved_output_tokens": budget.reserved_output_tokens,
            "reserved_reasoning_tokens": budget.reserved_reasoning_tokens,
        },
    )


def validate_turn_budget(turns: Sequence[Turn], budget: PromptBudget) -> int:
    """Validate final provider turns against the computed input budget."""

    estimated_tokens = estimate_turn_tokens(turns)
    if estimated_tokens > budget.input_budget_tokens:
        raise ContextBudgetError(
            "Assembled prompt exceeds the model input budget",
            requested_tokens=estimated_tokens,
            remaining_tokens=budget.input_budget_tokens,
        )
    return estimated_tokens
