"""Token budget helpers for chat context assembly."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from math import ceil
from typing import Literal

from nexus.errors import ApiErrorCode

BudgetLane = Literal[
    "system",
    "scope",
    "artifact_context",
    "state_snapshot",
    "attached_context",
    "retrieved_evidence",
    "web_evidence",
    "memory",
    "pointer_refs",
    "recent_history",
    "current_user",
]

DropReason = Literal["budget_exceeded"]
PromptRole = Literal["system", "user", "assistant"]

LANE_ORDER: tuple[BudgetLane, ...] = (
    "system",
    "scope",
    "artifact_context",
    "state_snapshot",
    "attached_context",
    "retrieved_evidence",
    "web_evidence",
    "memory",
    "pointer_refs",
    "recent_history",
    "current_user",
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
class PromptBlock:
    id: str
    role: PromptRole
    lane: BudgetLane
    text: str
    estimated_tokens: int
    source_refs: tuple[Mapping[str, object], ...]
    source_version: str
    stable_hash: str
    cache_policy: Mapping[str, object] | None = None
    privacy_scope: str = "conversation"
    required_provider_capability: str | None = None

    def manifest_entry(self, *, ordinal: int, included: bool) -> dict[str, object]:
        entry: dict[str, object] = {
            "id": self.id,
            "role": self.role,
            "lane": self.lane,
            "ordinal": ordinal,
            "included": included,
            "estimated_tokens": self.estimated_tokens,
            "stable_hash": self.stable_hash,
            "source_refs": [dict(ref) for ref in self.source_refs],
            "source_version": self.source_version,
            "cache_policy": dict(self.cache_policy) if self.cache_policy is not None else None,
            "privacy_scope": self.privacy_scope,
        }
        if self.required_provider_capability is not None:
            entry["required_provider_capability"] = self.required_provider_capability
        return entry


@dataclass(frozen=True)
class IncludedBudgetItem:
    key: str
    lane: BudgetLane
    blocks: tuple[PromptBlock, ...]
    estimated_tokens: int
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class DroppedBudgetItem:
    key: str
    lane: BudgetLane
    blocks: tuple[PromptBlock, ...]
    reason: DropReason
    estimated_tokens: int
    metadata: Mapping[str, object]

    def to_json(self) -> dict[str, object]:
        return {
            "key": self.key,
            "lane": self.lane,
            "reason": self.reason,
            "estimated_tokens": self.estimated_tokens,
            "blocks": [
                block.manifest_entry(ordinal=index, included=False)
                for index, block in enumerate(self.blocks)
            ],
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


@dataclass(frozen=True)
class BudgetItem:
    key: str
    lane: BudgetLane
    blocks: tuple[PromptBlock, ...]
    mandatory: bool
    priority: int = 0
    metadata: Mapping[str, object] = field(default_factory=dict)


def estimate_tokens(text: str) -> int:
    """Conservatively estimate tokens for provider-neutral prompt assembly."""

    if not text:
        return 0
    non_ascii = sum(1 for char in text if ord(char) > 127)
    char_estimate = ceil(len(text) / 3)
    word_estimate = len(text.split()) * 2
    return max(1, char_estimate, word_estimate, non_ascii)


def make_prompt_block(
    *,
    block_id: str,
    role: PromptRole,
    lane: BudgetLane,
    text: str,
    source_refs: Sequence[Mapping[str, object]] = (),
    source_version: str = "v1",
    cache_policy: Mapping[str, object] | None = None,
    privacy_scope: str = "conversation",
    required_provider_capability: str | None = None,
) -> PromptBlock:
    """Create one structured prompt block with its stable hash."""

    refs = tuple(dict(ref) for ref in source_refs)
    estimated_tokens = estimate_tokens(text)
    stable_hash = _stable_hash(
        {
            "id": block_id,
            "role": role,
            "lane": lane,
            "text": text,
            "source_refs": refs,
            "source_version": source_version,
            "cache_policy": cache_policy,
            "privacy_scope": privacy_scope,
            "required_provider_capability": required_provider_capability,
        }
    )
    return PromptBlock(
        id=block_id,
        role=role,
        lane=lane,
        text=text,
        estimated_tokens=estimated_tokens,
        source_refs=refs,
        source_version=source_version,
        stable_hash=stable_hash,
        cache_policy=cache_policy,
        privacy_scope=privacy_scope,
        required_provider_capability=required_provider_capability,
    )


def estimate_block_tokens(blocks: Sequence[PromptBlock]) -> int:
    """Estimate provider input tokens for structured prompt blocks."""

    return sum(block.estimated_tokens for block in blocks)


def _stable_hash(value: Mapping[str, object]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
    """Allocate prompt input tokens by lane while keeping mandatory blocks first."""

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

    ordered_items: list[BudgetItem] = []
    for mandatory in (True, False):
        for lane in LANE_ORDER:
            lane_items = [item for item in items_by_lane[lane] if item.mandatory is mandatory]
            ordered_items.extend(sorted(lane_items, key=lambda item: item.priority, reverse=True))

    for item in ordered_items:
        lane = item.lane
        if not item.blocks:
            continue
        item_tokens = estimate_block_tokens(item.blocks)
        if item_tokens <= remaining:
            included.append(
                IncludedBudgetItem(
                    key=item.key,
                    lane=item.lane,
                    blocks=item.blocks,
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
                blocks=item.blocks,
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
