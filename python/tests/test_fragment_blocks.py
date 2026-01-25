"""Tests for fragment block parsing and context window computation.

Tests the parsing of canonical_text into blocks and the context window
algorithm that uses those blocks for LLM prompts.

Per S3 spec:
- Blocks are contiguous and cover entire canonical_text
- Delimiter (\n\n) is included at the END of the preceding block
- Context window always contains the selection
- Max context is 2,500 chars, with cap enforced by shrinking edges
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.context_window import (
    MAX_CONTEXT_CHARS,
    get_context_window,
)
from nexus.services.fragment_blocks import (
    get_fragment_blocks,
    insert_fragment_blocks,
    parse_fragment_blocks,
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
        blocks = get_fragment_blocks(db_session, fragment_id)
        assert len(blocks) == 2
        assert blocks[0].block_idx == 0
        assert blocks[1].block_idx == 1


class TestContextWindow:
    """Tests for get_context_window function."""

    def _create_fragment_with_blocks(self, db_session: Session, canonical_text: str) -> uuid4:
        """Helper to create a fragment with blocks for testing."""
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
                VALUES (:id, :media_id, 0, :text, '<p>Test</p>')
            """),
            {"id": fragment_id, "media_id": media_id, "text": canonical_text},
        )
        db_session.flush()

        # Parse and insert blocks
        specs = parse_fragment_blocks(canonical_text)
        insert_fragment_blocks(db_session, fragment_id, specs)
        db_session.flush()

        return fragment_id

    def _create_fragment_without_blocks(self, db_session: Session, canonical_text: str) -> uuid4:
        """Helper to create a fragment WITHOUT blocks (fallback testing)."""
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
                VALUES (:id, :media_id, 0, :text, '<p>Test</p>')
            """),
            {"id": fragment_id, "media_id": media_id, "text": canonical_text},
        )
        db_session.flush()

        return fragment_id

    def test_block_based_window(self, db_session: Session):
        """Context window uses blocks when available."""
        text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
        fragment_id = self._create_fragment_with_blocks(db_session, text)

        # Select text in second paragraph
        # "First paragraph.\n\n" = 18 chars, "Second paragraph.\n\n" starts at 18
        start = 18  # Start of "Second"
        end = 18 + 6  # End of "Second"

        result = get_context_window(db_session, fragment_id, start, end)

        assert result.source == "blocks"
        # Should include surrounding blocks
        assert "First" in result.text
        assert "Second" in result.text
        assert "Third" in result.text

    def test_fallback_window(self, db_session: Session):
        """Context window uses fallback when blocks missing."""
        text = "A" * 1000 + "SELECTION" + "B" * 1000
        fragment_id = self._create_fragment_without_blocks(db_session, text)

        start = 1000
        end = 1009  # "SELECTION"

        result = get_context_window(db_session, fragment_id, start, end)

        assert result.source == "fallback"
        assert "SELECTION" in result.text

    def test_window_contains_selection(self, db_session: Session):
        """Window ALWAYS fully contains the selection."""
        text = "X" * 500 + "SELECTION" + "Y" * 500
        fragment_id = self._create_fragment_without_blocks(db_session, text)

        start = 500
        end = 509

        result = get_context_window(db_session, fragment_id, start, end)

        # The selection must be contained in the window
        assert result.window_start <= start
        assert result.window_end >= end
        assert "SELECTION" in result.text

    def test_window_respects_cap(self, db_session: Session):
        """Window respects MAX_CONTEXT_CHARS cap."""
        # Create text much larger than max context
        text = "X" * 5000 + "SELECTION" + "Y" * 5000
        fragment_id = self._create_fragment_without_blocks(db_session, text)

        start = 5000
        end = 5009

        result = get_context_window(db_session, fragment_id, start, end)

        # Window should be capped
        window_len = result.window_end - result.window_start
        assert window_len <= MAX_CONTEXT_CHARS

        # But selection must still be contained
        assert "SELECTION" in result.text

    def test_nonexistent_fragment_raises(self, db_session: Session):
        """Getting context for nonexistent fragment raises ValueError."""
        nonexistent_id = uuid4()

        with pytest.raises(ValueError) as exc_info:
            get_context_window(db_session, nonexistent_id, 0, 10)

        assert "not found" in str(exc_info.value)

    def test_selection_larger_than_cap(self, db_session: Session):
        """When selection itself is larger than cap, return selection bounds."""
        # Selection larger than max context
        selection = "X" * (MAX_CONTEXT_CHARS + 500)
        text = "PREFIX" + selection + "SUFFIX"
        fragment_id = self._create_fragment_without_blocks(db_session, text)

        start = 6  # After "PREFIX"
        end = 6 + len(selection)

        result = get_context_window(db_session, fragment_id, start, end)

        # Window should at least contain the selection
        assert result.window_start <= start
        assert result.window_end >= end


class TestContextWindowBlockSelection:
    """Tests for block selection in context window computation."""

    def _create_fragment_with_blocks(self, db_session: Session, canonical_text: str) -> uuid4:
        """Helper to create a fragment with blocks for testing."""
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
                VALUES (:id, :media_id, 0, :text, '<p>Test</p>')
            """),
            {"id": fragment_id, "media_id": media_id, "text": canonical_text},
        )
        db_session.flush()

        specs = parse_fragment_blocks(canonical_text)
        insert_fragment_blocks(db_session, fragment_id, specs)
        db_session.flush()

        return fragment_id

    def test_includes_adjacent_blocks(self, db_session: Session):
        """Context includes previous and next non-empty blocks."""
        # 5 blocks: A, B, C, D, E
        text = "BlockA\n\nBlockB\n\nBlockC\n\nBlockD\n\nBlockE"
        fragment_id = self._create_fragment_with_blocks(db_session, text)

        # Select in BlockC (block index 2)
        # "BlockA\n\n" = 8, "BlockB\n\n" = 8, "BlockC" starts at 16
        start = 16
        end = 22  # "BlockC"

        result = get_context_window(db_session, fragment_id, start, end)

        # Should include BlockB (prev), BlockC (containing), BlockD (next)
        assert "BlockB" in result.text
        assert "BlockC" in result.text
        assert "BlockD" in result.text

    def test_skips_empty_blocks(self, db_session: Session):
        """Adjacent block selection skips empty blocks."""
        # Create text with empty block between B and C
        text = "BlockA\n\nBlockB\n\n\n\nBlockC"
        fragment_id = self._create_fragment_with_blocks(db_session, text)

        # Verify we have blocks with an empty one
        blocks = get_fragment_blocks(db_session, fragment_id)
        assert len(blocks) == 4
        assert blocks[2].is_empty is True  # The "\n\n" after BlockB

        # Select in BlockC
        # "BlockA\n\n" = 8, "BlockB\n\n" = 8, "\n\n" = 2, "BlockC" starts at 18
        start = 18
        end = 24  # "BlockC"

        result = get_context_window(db_session, fragment_id, start, end)

        # Should include BlockA or BlockB (skipping empty), and BlockC
        assert "BlockC" in result.text
        # BlockB is the non-empty prev
        assert "BlockB" in result.text
