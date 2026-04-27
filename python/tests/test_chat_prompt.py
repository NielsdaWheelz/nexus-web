"""Tests for Nexus-owned chat prompt rendering."""

import pytest
from llm_calling.types import Turn

from nexus.services.chat_prompt import PromptTooLargeError, render_prompt, validate_prompt_size

pytestmark = pytest.mark.unit


class TestPromptRendering:
    """Tests for prompt rendering."""

    def test_prompt_render_no_context(self):
        """Render prompt without context blocks - identity + instructions only."""
        turns = render_prompt(
            user_content="What is 2+2?",
            history=[],
            context_blocks=[],
        )

        assert len(turns) == 2
        assert turns[0].role == "system"
        assert "reading assistant" in turns[0].content
        assert "Answer using the provided context" in turns[0].content
        assert "<context>" not in turns[0].content
        assert turns[1].role == "user"
        assert turns[1].content == "What is 2+2?"

    def test_prompt_render_with_context(self):
        """Render prompt with context blocks wraps them in <context> tags."""
        turns = render_prompt(
            user_content="What does this mean?",
            history=[],
            context_blocks=["<highlight><quote>block 1</quote></highlight>"],
            context_types={"highlight"},
        )

        assert len(turns) == 2
        assert turns[0].role == "system"
        assert "<context>" in turns[0].content
        assert "</context>" in turns[0].content
        assert "block 1" in turns[0].content
        assert "highlighted a passage" in turns[0].content

    def test_prompt_render_with_history(self):
        """Render prompt with conversation history."""
        history = [
            Turn(role="user", content="Previous question"),
            Turn(role="assistant", content="Previous answer"),
        ]

        turns = render_prompt(
            user_content="Follow-up question",
            history=history,
            context_blocks=[],
        )

        assert len(turns) == 4
        assert turns[0].role == "system"
        assert turns[1].role == "user"
        assert turns[1].content == "Previous question"
        assert turns[2].role == "assistant"
        assert turns[2].content == "Previous answer"
        assert turns[3].role == "user"
        assert turns[3].content == "Follow-up question"

    def test_prompt_render_skips_old_system_turns(self):
        """Old system turns in history should be skipped."""
        history = [
            Turn(role="system", content="Old system prompt"),
            Turn(role="user", content="Previous question"),
        ]

        turns = render_prompt(
            user_content="New question",
            history=history,
            context_blocks=[],
        )

        assert len(turns) == 3
        assert turns[0].role == "system"
        assert "reading assistant" in turns[0].content
        assert turns[1].role == "user"
        assert turns[1].content == "Previous question"

    def test_prompt_render_situation_varies_by_context_type(self):
        """Situation line adapts to attached context types."""
        turns = render_prompt(
            user_content="?",
            history=[],
            context_blocks=["x"],
            context_types={"highlight"},
        )
        assert "highlighted a passage" in turns[0].content

        turns = render_prompt(
            user_content="?",
            history=[],
            context_blocks=["x"],
            context_types={"annotation"},
        )
        assert "annotated a passage" in turns[0].content

        turns = render_prompt(
            user_content="?",
            history=[],
            context_blocks=["x"],
            context_types={"media"},
        )
        assert "saved document" in turns[0].content

        turns = render_prompt(
            user_content="?",
            history=[],
            context_blocks=["x"],
            context_types={"highlight", "annotation"},
        )
        assert "highlighted and annotated passages" in turns[0].content


class TestPromptValidation:
    """Tests for prompt size validation."""

    def test_prompt_size_validation_passes(self):
        """Validation should pass for small prompts."""
        turns = [Turn(role="user", content="Short message")]
        validate_prompt_size(turns)

    def test_prompt_size_validation_fails(self):
        """Validation should fail for oversized prompts."""
        turns = [Turn(role="user", content="x" * 150_000)]

        with pytest.raises(PromptTooLargeError) as exc_info:
            validate_prompt_size(turns)

        assert exc_info.value.actual_size == 150_000
        assert exc_info.value.max_size == 100_000

    def test_prompt_size_validation_custom_max(self):
        """Validation should respect custom max_chars."""
        turns = [Turn(role="user", content="x" * 100)]

        validate_prompt_size(turns, max_chars=1000)

        with pytest.raises(PromptTooLargeError):
            validate_prompt_size(turns, max_chars=50)
