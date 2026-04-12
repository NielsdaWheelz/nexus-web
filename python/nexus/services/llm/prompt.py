"""Provider-agnostic prompt rendering for LLM requests.

Prompt structure:
- System turn always first: identity + situation + context + instructions
- History turns (user/assistant only, skip any old system turns)
- Current user message last

The system prompt adapts to what context the user attached:
- Highlights: "The user has highlighted a passage..."
- Annotations: "The user has annotated a passage..."
- Media: "The user is asking about a saved document."
- Mixed: generic framing
- No context: no situation line

Validation:
- Total prompt size must not exceed max_chars (100,000 default)
"""

from nexus.services.llm.types import Turn

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
    context_types: set[str] | None = None,
) -> list[Turn]:
    """Build provider-agnostic turn list for LLM request.

    Args:
        user_content: Current user message text.
        history: Previous turns (may include prior system if multi-turn).
        context_blocks: Pre-rendered context XML strings.
        context_types: Set of context types attached ("highlight", "annotation", "media").

    Returns:
        List of Turn objects ready for adapter consumption.
        System turn always first.
    """
    context_types = context_types or set()

    # -- System prompt: identity + situation + context + instructions --
    parts = [
        "You are a reading assistant. Users save articles, books, podcasts, and PDFs, "
        "highlight passages, and annotate them.",
    ]

    # Situation: tell the model what the user is doing
    if "highlight" in context_types and "annotation" in context_types:
        parts.append(
            "The user is asking about highlighted and annotated passages from their saved content."
        )
    elif "annotation" in context_types:
        parts.append(
            "The user has annotated a passage with their own notes and is asking about it."
        )
    elif "highlight" in context_types:
        parts.append("The user has highlighted a passage and is asking about it.")
    elif "media" in context_types:
        parts.append("The user is asking about a saved document.")

    if context_blocks:
        parts.append("<context>\n" + "\n\n".join(context_blocks) + "\n</context>")

    parts.append(
        "Answer using the provided context. Quote the source text directly when citing. "
        "If the context does not contain enough information to answer, say so."
    )

    turns: list[Turn] = []
    turns.append(Turn(role="system", content="\n\n".join(parts)))

    # History (user/assistant only, skip any old system turns)
    for turn in history:
        if turn.role in ("user", "assistant"):
            turns.append(turn)

    # Current user message
    turns.append(Turn(role="user", content=user_content))

    return turns


def validate_prompt_size(turns: list[Turn], max_chars: int = MAX_PROMPT_CHARS) -> None:
    """Validate that total prompt size is within limits.

    Raises:
        PromptTooLargeError: If total chars exceed limit.
    """
    total = sum(len(t.content) for t in turns)
    if total > max_chars:
        raise PromptTooLargeError(total, max_chars)


def estimate_token_count(text: str) -> int:
    """Rough estimate of token count (~4 chars per token).

    NOT used for billing — just for quick pre-validation.
    """
    return len(text) // 4 + 1
