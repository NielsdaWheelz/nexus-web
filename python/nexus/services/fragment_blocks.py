"""Fragment blocks: the contiguous cover of canonical text used for context windows."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import FragmentBlock

BLOCK_DELIMITER = "\n\n"


@dataclass
class FragmentBlockSpec:
    block_idx: int
    start_offset: int
    end_offset: int


def parse_fragment_blocks(canonical_text: str) -> list[FragmentBlockSpec]:
    """Split canonical text on `\\n\\n`, the delimiter belonging to the block it ends.

    Blocks are contiguous codepoint ranges covering the whole text: block[0]
    starts at 0, block[-1] ends at len(canonical_text).
    """
    if not canonical_text:
        return [FragmentBlockSpec(block_idx=0, start_offset=0, end_offset=0)]

    blocks: list[FragmentBlockSpec] = []
    start = 0
    while start < len(canonical_text):
        delimiter = canonical_text.find(BLOCK_DELIMITER, start)
        end = len(canonical_text) if delimiter == -1 else delimiter + len(BLOCK_DELIMITER)
        blocks.append(FragmentBlockSpec(block_idx=len(blocks), start_offset=start, end_offset=end))
        start = end
    return blocks


def insert_fragment_blocks(
    db: Session,
    fragment_id: UUID,
    blocks: list[FragmentBlockSpec],
) -> None:
    for spec in blocks:
        db.add(
            FragmentBlock(
                fragment_id=fragment_id,
                block_idx=spec.block_idx,
                start_offset=spec.start_offset,
                end_offset=spec.end_offset,
            )
        )
