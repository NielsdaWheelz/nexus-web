"""Provider-agnostic prompt rendering for LLM requests.

Per PR-04 spec section 7:
- prompt.py is provider-agnostic. It produces a list of Turn objects.
- Each adapter handles conversion to provider-specific format.

System Prompt (v1, fixed):
    You are a careful assistant.
    Answer only using the provided context when possible.
    Quote directly when citing.
    If information is missing or uncertain, say so.

Prompt structure:
- System turn always first (if present)
- History turns (user/assistant only, skip any old system turns)
- Current user message last

Validation:
- Total prompt size must not exceed max_chars (100,000 default)
"""

from nexus.services.llm.types import Turn

# Default system prompt per S3 spec section 4.4
DEFAULT_SYSTEM_PROMPT = """You are a careful assistant.
Answer only using the provided context when possible.
Quote directly when citing.
If information is missing or uncertain, say so."""

# Maximum total prompt size in characters (100,000 per spec)
MAX_PROMPT_CHARS = 100_000


class PromptTooLargeError(Exception):
    """Raised when rendered prompt exceeds size limit."""

    def __init__(self, actual_size: int, max_size: int):
        self.actual_size = actual_size
        self.max_size = max_size
        super().__init__(f"Prompt size {actual_size} exceeds max {max_size}")


def render_prompt(
    user_content: str,
    history: list[Turn],
    context_blocks: list[str],
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
) -> list[Turn]:
    """Build provider-agnostic turn list for LLM request.

    Args:
        user_content: Current user message text.
        history: Previous turns (may include prior system if multi-turn).
        context_blocks: Pre-rendered context strings (from context_window helper).
        system_prompt: System instructions (uses default v1 if not specified).

    Returns:
        List of Turn objects ready for adapter consumption.
        System turn always first (if present).

    Example output:
        [
            Turn(role="system", content="You are a careful assistant...\\n\\n---\\nContext:\\n..."),
            Turn(role="user", content="What is X?"),
            Turn(role="assistant", content="X is..."),
            Turn(role="user", content="<current user message>"),
        ]
    """
    turns: list[Turn] = []

    # Build system prompt with context
    full_system = system_prompt
    if context_blocks:
        context_section = "\n\n---\nContext:\n" + "\n\n".join(context_blocks)
        full_system = system_prompt + context_section

    turns.append(Turn(role="system", content=full_system))

    # Add history (user/assistant only, skip any old system turns)
    for turn in history:
        if turn.role in ("user", "assistant"):
            turns.append(turn)

    # Add current user message
    turns.append(Turn(role="user", content=user_content))

    return turns


def validate_prompt_size(turns: list[Turn], max_chars: int = MAX_PROMPT_CHARS) -> None:
    """Validate that total prompt size is within limits.

    Args:
        turns: List of Turn objects to validate.
        max_chars: Maximum allowed total characters.

    Raises:
        PromptTooLargeError: If total chars exceed limit.
    """
    total = sum(len(t.content) for t in turns)
    if total > max_chars:
        raise PromptTooLargeError(total, max_chars)


def estimate_token_count(text: str) -> int:
    """Rough estimate of token count for a text string.

    Uses a simple heuristic of ~4 chars per token.
    This is a conservative estimate; actual counts vary by model.

    This is NOT used for billing - just for quick pre-validation.
    Actual token counts come from provider responses.

    Args:
        text: The text to estimate tokens for.

    Returns:
        Estimated token count.
    """
    return len(text) // 4 + 1
