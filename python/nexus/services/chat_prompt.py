"""Provider-neutral structured prompt plans for durable chat runs, and their
translation into the runtime's ``GenerateIntent``."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from provider_runtime import (
    Absent,
    AssistantMessage,
    BlockStability,
    CanonicalTool,
    Dynamic,
    GenerateIntent,
    GlobalScope,
    PromptMessage,
    ProviderTarget,
    ReasoningLevel,
    Stable,
    SystemMessage,
    TextOutput,
    UserMessage,
)
from provider_runtime import PromptBlock as RuntimePromptBlock

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
        "A <subject> block, when present, is the primary resource the user is asking "
        'about; treat pronouns like "this" and "it" as referring to it unless the '
        "user clearly means something else. Other referenced resources appear in a "
        "<resources> block; a highlight there carries a <quote> with the passage and "
        "its surrounding context. Each citable resource and each citable tool result "
        "is numbered with an n attribute. "
        "When you use information from a numbered resource or tool result, cite it as [N] "
        "using its exact n. Never invent an [N]: only use values that appear as n "
        "attributes in this turn. Cite distinct sources separately and adjacently when a "
        "claim draws on more than one (e.g. [2][4]); do not concatenate numbers. "
        "Cite only resource or tool-result facts, not world knowledge. "
        "Any <reader_selection> block is the exact passage the user is currently looking "
        "at and asking about for this turn; it narrows the current question but does "
        "not replace the durable <subject>. "
        "A <historical_reader_selection> block applies only to the immediately following "
        "historical user message in the conversation, not to the current turn. "
        "You have three tools for the user's content. "
        "app_search(query=..., scopes=[...]) finds relevant passages across referenced "
        "search-scope resources; omit scopes to search this conversation's context refs. "
        'inspect_resource("media:...") returns a document map — an ordered list of '
        "sections, each with a label, a short preview, and a read_uri. "
        "read_resource(uri) returns exact text for a resource or a read_uri and labels it "
        "with a kind (quote, section, page_range, full, or too_large); a too_large result "
        "means the document is too big to read whole, so call inspect_resource first and "
        "read the sections you need. "
        "To use a whole document, search it or inspect its map, then read the relevant "
        "parts."
    ) + _render_write_tools_block()


def _render_write_tools_block() -> str:
    """The amanuensis 'hands' instructions, only when write tools are enabled."""
    from nexus.config import get_settings

    if not get_settings().assistant_write_tools_enabled:
        return ""
    return (
        " You can also act on the user's library when they explicitly ask you to file, "
        "annotate, connect, or queue — never on your own initiative. "
        "add_to_library(resource_uri, library_id|library_name) files a media or podcast "
        "into a library the user administers. "
        "jot_note(markdown, page_uri?) appends a note the user dictates to today's daily "
        "note, or to a given page. "
        "create_highlight(media_uri, exact, prefix?, suffix?, note?) dog-ears an exact "
        "passage; if exact is not unique, add prefix/suffix or quote more surrounding "
        "text — an ambiguous quote is refused, so never guess. "
        "mint_edge(source_uri, target_uri, kind?, rationale) connects two of the user's "
        "resources with your one-line rationale. "
        "queue_add(media_uri) adds a media item to the read/listen-next queue. "
        "Each write happens immediately and is shown to the user with an Undo; there is "
        "no undo or delete tool, so do not attempt to remove anything. Use these tools "
        "only when the user's words ask for the action."
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


def build_generate_intent_from_plan(
    *,
    plan: PromptPlan,
    target: ProviderTarget,
    max_output_tokens: int,
    reasoning: ReasoningLevel,
    tools: tuple[CanonicalTool, ...],
) -> GenerateIntent:
    """Derive the runtime ``GenerateIntent`` from the prompt plan exactly once.

    C1 stability table (adjudicated): the invariant system prompt block is
    ``Stable(GlobalScope())`` (its ``privacy_scope="global"``); every other
    block — subject, reader_selection, branch_anchor, resources, history,
    current user — is ``Dynamic()``.
    """
    messages: list[PromptMessage] = []
    for turn in plan.turns:
        blocks = tuple(_runtime_block(block) for block in turn.blocks)
        if turn.role == "system":
            messages.append(SystemMessage(blocks=blocks))
        elif turn.role == "user":
            messages.append(UserMessage(blocks=blocks))
        else:
            # Prior assistant turns from history carry no live tool_calls or
            # continuation — those exist only for the current turn's live loop.
            messages.append(
                AssistantMessage(
                    text="\n".join(block.text for block in turn.blocks),
                    tool_calls=(),
                    continuation=Absent(),
                )
            )
    return GenerateIntent(
        target=target,
        messages=tuple(messages),
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        tools=tools,
        tool_choice="auto" if tools else "none",
        output=TextOutput(),
    )


def _runtime_block(block: PromptBlock) -> RuntimePromptBlock:
    stability: BlockStability = (
        Stable(GlobalScope()) if block.privacy_scope == "global" else Dynamic()
    )
    return RuntimePromptBlock(text=block.text, stability=stability)


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
