"""Tests for fragment block parsing.

Behavior under test:
- Blocks are contiguous and cover entire canonical_text
- Delimiter (\n\n) is included at the END of the preceding block
"""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import FragmentBlock
from nexus.services.fragment_blocks import (
    insert_fragment_blocks,
    parse_fragment_blocks,
)

pytestmark = pytest.mark.integration


def _fragment_blocks(db: Session, fragment_id) -> list[FragmentBlock]:
    return list(
        db.scalars(
            select(FragmentBlock)
            .where(FragmentBlock.fragment_id == fragment_id)
            .order_by(FragmentBlock.block_idx)
        ).all()
    )


class TestParseFragmentBlocks:
    """Tests for parse_fragment_blocks function."""

    def test_empty_text(self):
        """Empty text produces single empty block."""
        blocks = parse_fragment_blocks("")

        assert len(blocks) == 1
        assert blocks[0].block_idx == 0
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == 0
        assert blocks[0].is_empty is True

    def test_no_delimiter(self):
        """Text without delimiter produces single block."""
        text = "Hello, this is a single block of text."
        blocks = parse_fragment_blocks(text)

        assert len(blocks) == 1
        assert blocks[0].block_idx == 0
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == len(text)
        assert blocks[0].is_empty is False

    def test_single_delimiter(self):
        """Text with one delimiter produces two blocks."""
        text = "First block.\n\nSecond block."
        blocks = parse_fragment_blocks(text)

        assert len(blocks) == 2

        # First block includes the delimiter
        assert blocks[0].block_idx == 0
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == 14  # "First block.\n\n"
        assert blocks[0].is_empty is False

        # Second block is the remainder
        assert blocks[1].block_idx == 1
        assert blocks[1].start_offset == 14
        assert blocks[1].end_offset == 27  # "Second block."
        assert blocks[1].is_empty is False

    def test_multiple_delimiters(self):
        """Multiple delimiters create multiple blocks."""
        text = "One.\n\nTwo.\n\nThree."
        blocks = parse_fragment_blocks(text)

        assert len(blocks) == 3

        # Verify contiguity
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == blocks[1].start_offset
        assert blocks[1].end_offset == blocks[2].start_offset
        assert blocks[2].end_offset == len(text)

    def test_delimiter_at_start(self):
        """Delimiter at start creates empty first block."""
        text = "\n\nAfter delimiter."
        blocks = parse_fragment_blocks(text)

        assert len(blocks) == 2
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == 2  # Just the delimiter
        assert blocks[0].is_empty is True

        assert blocks[1].start_offset == 2
        assert blocks[1].end_offset == len(text)
        assert blocks[1].is_empty is False

    def test_delimiter_at_end(self):
        """Delimiter at end is included in last meaningful block."""
        text = "Some text.\n\n"
        blocks = parse_fragment_blocks(text)

        # Should be one block that includes the trailing delimiter
        assert len(blocks) == 1
        assert blocks[0].start_offset == 0
        assert blocks[0].end_offset == len(text)

    def test_consecutive_delimiters(self):
        """Consecutive delimiters create empty blocks."""
        text = "Start.\n\n\n\nEnd."
        blocks = parse_fragment_blocks(text)

        # "Start.\n\n" + "\n\n" + "End."
        assert len(blocks) == 3
        assert blocks[1].is_empty is True  # The middle "\n\n" block

    def test_contiguity_invariant(self):
        """All blocks are contiguous with no gaps."""
        text = "Block one.\n\nBlock two.\n\nBlock three.\n\nBlock four."
        blocks = parse_fragment_blocks(text)

        # First block starts at 0
        assert blocks[0].start_offset == 0

        # Each block starts where the previous ends
        for i in range(1, len(blocks)):
            assert blocks[i].start_offset == blocks[i - 1].end_offset

        # Last block ends at text length
        assert blocks[-1].end_offset == len(text)

    def test_coverage_invariant(self):
        """Blocks cover entire text without overlap."""
        text = "A paragraph.\n\nAnother paragraph.\n\nFinal paragraph."
        blocks = parse_fragment_blocks(text)

        # Sum of all block lengths should equal text length
        total_coverage = sum(b.end_offset - b.start_offset for b in blocks)
        assert total_coverage == len(text)


class TestInsertFragmentBlocks:
    """Tests for insert_fragment_blocks function."""

    def test_insert_blocks(self, db_session: Session):
        """Blocks are correctly inserted into database."""
        # Create user, media, fragment
        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'web_article', 'Test', 'ready_for_reading', :user_id)
            """),
            {"id": media_id, "user_id": user_id},
        )
        db_session.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                VALUES (:id, :media_id, 0, 'Block one.\n\nBlock two.', '<p>Test</p>')
            """),
            {"id": fragment_id, "media_id": media_id},
        )
        db_session.flush()

        # Parse and insert blocks
        canonical_text = "Block one.\n\nBlock two."
        specs = parse_fragment_blocks(canonical_text)
        created = insert_fragment_blocks(db_session, fragment_id, specs)

        assert len(created) == 2
        db_session.flush()

        # Verify in database
        blocks = _fragment_blocks(db_session, fragment_id)
        assert len(blocks) == 2
        assert blocks[0].block_idx == 0
        assert blocks[1].block_idx == 1
