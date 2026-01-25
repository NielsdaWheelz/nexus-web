"""Fragment block parsing for context window computation.

Parses canonical_text into blocks based on block separators (\n\n).
These blocks are used for deterministic context window computation
without DOM traversal at query time.

Per S3 spec:
- Blocks are contiguous and non-overlapping
- Block offsets are codepoint indices (Python str indexing)
- Delimiter (\n\n) is included at the END of the preceding block's range
- block[n].end == block[n+1].start (contiguous, no gaps)
- Final block ends at len(canonical_text) with no trailing delimiter
- Empty blocks are flagged with is_empty=True to preserve contiguity

Invariants:
- block[0].start == 0
- block[-1].end == len(canonical_text)
- All blocks cover the entire text with no gaps or overlaps
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import FragmentBlock
from nexus.logging import get_logger

logger = get_logger(__name__)

# Block delimiter in canonical text
BLOCK_DELIMITER = "\n\n"


@dataclass
class FragmentBlockSpec:
    """Specification for a fragment block before database insertion."""

    block_idx: int
    start_offset: int
    end_offset: int
    is_empty: bool


def parse_fragment_blocks(canonical_text: str) -> list[FragmentBlockSpec]:
    """Parse canonical_text into block specifications.

    Scans canonical_text and produces contiguous blocks using \\n\\n separators.
    The delimiter belongs to the END of the preceding block's range.

    Args:
        canonical_text: The canonical text to parse.

    Returns:
        List of FragmentBlockSpec objects representing the blocks.
        Returns a single block covering the entire text if no delimiters found.

    Invariants:
        - block[0].start_offset == 0
        - block[-1].end_offset == len(canonical_text)
        - All blocks are contiguous (no gaps)
    """
    if not canonical_text:
        # Empty text gets a single empty block
        return [FragmentBlockSpec(block_idx=0, start_offset=0, end_offset=0, is_empty=True)]

    blocks: list[FragmentBlockSpec] = []
    text_len = len(canonical_text)
    current_start = 0
    block_idx = 0

    while current_start < text_len:
        # Find the next delimiter
        delim_pos = canonical_text.find(BLOCK_DELIMITER, current_start)

        if delim_pos == -1:
            # No more delimiters - this is the final block
            end_offset = text_len
            block_text = canonical_text[current_start:end_offset]
            is_empty = block_text.strip() == ""

            blocks.append(
                FragmentBlockSpec(
                    block_idx=block_idx,
                    start_offset=current_start,
                    end_offset=end_offset,
                    is_empty=is_empty,
                )
            )
            break
        else:
            # Include the delimiter in this block's range
            end_offset = delim_pos + len(BLOCK_DELIMITER)
            block_text = canonical_text[current_start:delim_pos]  # Text before delimiter
            is_empty = block_text.strip() == ""

            blocks.append(
                FragmentBlockSpec(
                    block_idx=block_idx,
                    start_offset=current_start,
                    end_offset=end_offset,
                    is_empty=is_empty,
                )
            )

            current_start = end_offset
            block_idx += 1

    # Validation: ensure invariants hold
    if blocks:
        assert blocks[0].start_offset == 0, "First block must start at 0"
        assert blocks[-1].end_offset == text_len, "Last block must end at text length"

        # Check contiguity
        for i in range(1, len(blocks)):
            assert blocks[i].start_offset == blocks[i - 1].end_offset, (
                f"Blocks must be contiguous: block {i - 1} ends at {blocks[i - 1].end_offset}, "
                f"block {i} starts at {blocks[i].start_offset}"
            )

    logger.debug(
        "parsed_fragment_blocks",
        text_len=text_len,
        block_count=len(blocks),
    )

    return blocks


def insert_fragment_blocks(
    db: Session,
    fragment_id: UUID,
    blocks: list[FragmentBlockSpec],
) -> list[FragmentBlock]:
    """Insert fragment block rows into the database.

    Args:
        db: Database session.
        fragment_id: The UUID of the fragment these blocks belong to.
        blocks: List of block specifications to insert.

    Returns:
        List of created FragmentBlock ORM objects.
    """
    created_blocks: list[FragmentBlock] = []

    for spec in blocks:
        block = FragmentBlock(
            fragment_id=fragment_id,
            block_idx=spec.block_idx,
            start_offset=spec.start_offset,
            end_offset=spec.end_offset,
            is_empty=spec.is_empty,
        )
        db.add(block)
        created_blocks.append(block)

    logger.debug(
        "inserted_fragment_blocks",
        fragment_id=str(fragment_id),
        block_count=len(created_blocks),
    )

    return created_blocks


def get_fragment_blocks(db: Session, fragment_id: UUID) -> list[FragmentBlock]:
    """Retrieve all fragment blocks for a fragment, ordered by block_idx.

    Args:
        db: Database session.
        fragment_id: The UUID of the fragment.

    Returns:
        List of FragmentBlock objects ordered by block_idx.
    """
    from sqlalchemy import select

    stmt = (
        select(FragmentBlock)
        .where(FragmentBlock.fragment_id == fragment_id)
        .order_by(FragmentBlock.block_idx)
    )
    result = db.execute(stmt)
    return list(result.scalars().all())
