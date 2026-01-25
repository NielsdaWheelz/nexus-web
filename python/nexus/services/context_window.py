"""Context window computation for quote-to-chat.

Computes surrounding context for highlighted text to include in LLM prompts.
Uses fragment_block rows when available for precise block-based windows,
falls back to character-based windowing when blocks are missing.

Per S3 spec:
- Context window ALWAYS fully contains the selection [start_offset, end_offset)
- When blocks exist: use containing block + adjacent non-empty blocks
- When blocks missing: use ±600 chars from highlight boundaries
- Total context capped at 2,500 characters
- Cap is enforced by shrinking edges, never cutting into selection
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, FragmentBlock
from nexus.logging import get_logger

logger = get_logger(__name__)

# Maximum context window size in characters
MAX_CONTEXT_CHARS = 2500

# Fallback window size when no blocks exist (chars before/after selection)
FALLBACK_CONTEXT_CHARS = 600


@dataclass
class ContextWindow:
    """Result of context window computation."""

    text: str
    source: Literal["blocks", "fallback"]
    window_start: int
    window_end: int


def get_context_window(
    db: Session,
    fragment_id: UUID,
    start_offset: int,
    end_offset: int,
) -> ContextWindow:
    """Compute context window for a highlighted region.

    The returned window ALWAYS fully contains [start_offset, end_offset).

    Args:
        db: Database session.
        fragment_id: The fragment containing the highlight.
        start_offset: Start of highlighted region (codepoint offset, inclusive).
        end_offset: End of highlighted region (codepoint offset, exclusive).

    Returns:
        ContextWindow with the surrounding text and metadata.

    Raises:
        ValueError: If the fragment does not exist.
    """
    # Load fragment to get canonical_text
    fragment = db.get(Fragment, fragment_id)
    if fragment is None:
        raise ValueError(f"Fragment {fragment_id} not found")

    canonical_text = fragment.canonical_text

    # Try to use blocks if they exist
    blocks = _get_blocks_for_fragment(db, fragment_id)

    if blocks:
        return _compute_block_based_window(canonical_text, blocks, start_offset, end_offset)
    else:
        return _compute_fallback_window(canonical_text, start_offset, end_offset)


def _get_blocks_for_fragment(db: Session, fragment_id: UUID) -> list[FragmentBlock]:
    """Load fragment blocks ordered by block_idx."""
    stmt = (
        select(FragmentBlock)
        .where(FragmentBlock.fragment_id == fragment_id)
        .order_by(FragmentBlock.block_idx)
    )
    result = db.execute(stmt)
    return list(result.scalars().all())


def _compute_block_based_window(
    canonical_text: str,
    blocks: list[FragmentBlock],
    start_offset: int,
    end_offset: int,
) -> ContextWindow:
    """Compute context window using block boundaries.

    Selection strategy:
    1. Find the block(s) containing the selection
    2. Include previous and next non-empty blocks
    3. Ensure selection is fully contained
    4. Apply character cap by shrinking edges (never cut into selection)
    """
    text_len = len(canonical_text)

    # Find blocks that overlap with the selection
    # A block overlaps if: block.start < end_offset AND block.end > start_offset
    containing_indices: list[int] = []
    for i, block in enumerate(blocks):
        if block.start_offset < end_offset and block.end_offset > start_offset:
            containing_indices.append(i)

    if not containing_indices:
        # Selection doesn't overlap any block - use fallback
        logger.warning(
            "selection_outside_blocks",
            fragment_blocks=len(blocks),
            start_offset=start_offset,
            end_offset=end_offset,
        )
        return _compute_fallback_window(canonical_text, start_offset, end_offset)

    # Get range of block indices to include
    first_containing = min(containing_indices)
    last_containing = max(containing_indices)

    # Find previous non-empty block
    prev_idx = None
    for i in range(first_containing - 1, -1, -1):
        if not blocks[i].is_empty:
            prev_idx = i
            break

    # Find next non-empty block
    next_idx = None
    for i in range(last_containing + 1, len(blocks)):
        if not blocks[i].is_empty:
            next_idx = i
            break

    # Determine window boundaries
    if prev_idx is not None:
        window_start = blocks[prev_idx].start_offset
    else:
        window_start = blocks[first_containing].start_offset

    if next_idx is not None:
        window_end = blocks[next_idx].end_offset
    else:
        window_end = blocks[last_containing].end_offset

    # Ensure window contains selection (clamp)
    window_start = min(window_start, start_offset)
    window_end = max(window_end, end_offset)

    # Clamp to text bounds
    window_start = max(0, window_start)
    window_end = min(text_len, window_end)

    # Apply character cap by shrinking edges (never cut into selection)
    window_start, window_end = _apply_char_cap(
        window_start, window_end, start_offset, end_offset, MAX_CONTEXT_CHARS
    )

    window_text = canonical_text[window_start:window_end]

    logger.debug(
        "computed_block_context_window",
        window_start=window_start,
        window_end=window_end,
        window_len=len(window_text),
        blocks_used=last_containing
        - first_containing
        + 1
        + (1 if prev_idx else 0)
        + (1 if next_idx else 0),
    )

    return ContextWindow(
        text=window_text,
        source="blocks",
        window_start=window_start,
        window_end=window_end,
    )


def _compute_fallback_window(
    canonical_text: str,
    start_offset: int,
    end_offset: int,
) -> ContextWindow:
    """Compute context window using character-based expansion.

    Used when fragment_block data is not available.
    """
    text_len = len(canonical_text)

    # Compute initial window: ±FALLBACK_CONTEXT_CHARS from selection
    window_start = max(0, start_offset - FALLBACK_CONTEXT_CHARS)
    window_end = min(text_len, end_offset + FALLBACK_CONTEXT_CHARS)

    # Ensure window contains selection (clamp)
    window_start = min(window_start, start_offset)
    window_end = max(window_end, end_offset)

    # Apply character cap
    window_start, window_end = _apply_char_cap(
        window_start, window_end, start_offset, end_offset, MAX_CONTEXT_CHARS
    )

    window_text = canonical_text[window_start:window_end]

    logger.debug(
        "computed_fallback_context_window",
        window_start=window_start,
        window_end=window_end,
        window_len=len(window_text),
    )

    return ContextWindow(
        text=window_text,
        source="fallback",
        window_start=window_start,
        window_end=window_end,
    )


def _apply_char_cap(
    window_start: int,
    window_end: int,
    selection_start: int,
    selection_end: int,
    max_chars: int,
) -> tuple[int, int]:
    """Apply character cap by shrinking window edges.

    Shrinks the window to fit within max_chars while never cutting into
    the selection [selection_start, selection_end).

    Strategy:
    1. If window fits, return as-is
    2. Shrink from start (up to selection_start)
    3. Shrink from end (down to selection_end)
    4. If still too large, selection itself is > max_chars - return selection bounds
    """
    window_len = window_end - window_start
    if window_len <= max_chars:
        return window_start, window_end

    # Calculate how much we need to trim
    excess = window_len - max_chars

    # Available trim from each side (without cutting into selection)
    trim_from_start_available = selection_start - window_start
    trim_from_end_available = window_end - selection_end

    # Trim proportionally from both sides
    total_available = trim_from_start_available + trim_from_end_available

    if total_available == 0:
        # Selection itself is larger than max_chars - can't trim
        return window_start, window_end

    if excess >= total_available:
        # Need to trim all available space
        return selection_start, selection_end

    # Trim proportionally
    if trim_from_start_available > 0:
        trim_start = min(trim_from_start_available, excess // 2 + excess % 2)
    else:
        trim_start = 0

    trim_end = min(trim_from_end_available, excess - trim_start)

    # Adjust if we couldn't trim enough from one side
    if trim_start + trim_end < excess:
        remaining = excess - trim_start - trim_end
        if trim_from_start_available > trim_start:
            trim_start += min(remaining, trim_from_start_available - trim_start)

    return window_start + trim_start, window_end - trim_end
