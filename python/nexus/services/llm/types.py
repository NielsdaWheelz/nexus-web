"""Shared type definitions for the LLM adapter layer.

Per PR-04 spec section 2:
- Turn: Provider-agnostic conversation turn
- LLMRequest: Request to LLM adapter
- LLMUsage: Token usage from provider response
- LLMResponse: Complete response from non-streaming call
- LLMChunk: Single chunk from streaming response

Streaming invariants:
- Chunks with done=False MUST have usage=None
- Exactly ONE terminal chunk with done=True
- Terminal chunk MAY have usage and provider_request_id (if provider returns them)
- If provider stream ends without terminal marker: raise E_LLM_PROVIDER_DOWN
"""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Turn:
    """Provider-agnostic conversation turn.

    Attributes:
        role: One of "system", "user", or "assistant"
        content: The text content of the turn
    """

    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class LLMUsage:
    """Token usage from provider response.

    All fields are optional as not all providers return all metrics,
    and streaming responses may not include usage data.

    Attributes:
        prompt_tokens: Number of tokens in the prompt
        completion_tokens: Number of tokens in the completion
        total_tokens: Total tokens (usually prompt + completion)
    """

    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None


@dataclass(frozen=True)
class LLMRequest:
    """Request to LLM adapter.

    Attributes:
        model_name: The model identifier (e.g., "gpt-4", "claude-3-opus-20240229")
        messages: List of Turn objects (system turn first if present)
        max_tokens: Maximum tokens in the completion
        temperature: Sampling temperature (0.0 to 2.0), None uses provider default
    """

    model_name: str
    messages: list[Turn]
    max_tokens: int
    temperature: float | None = None


@dataclass(frozen=True)
class LLMResponse:
    """Complete response from non-streaming call.

    Attributes:
        text: The generated text content
        usage: Token usage information (may be None if provider doesn't return it)
        provider_request_id: Provider's request ID for debugging (may be None)
    """

    text: str
    usage: LLMUsage | None
    provider_request_id: str | None


@dataclass(frozen=True)
class LLMChunk:
    """Single chunk from streaming response.

    Streaming invariants:
    - done=False: delta_text contains new text, usage MUST be None
    - done=True: This is the terminal chunk. delta_text may be empty.
                 usage and provider_request_id may be populated if provider returns them.

    Attributes:
        delta_text: New text content in this chunk (may be empty)
        done: Whether this is the final chunk
        usage: Token usage (only on terminal chunk, if provider returns it)
        provider_request_id: Provider's request ID (only on terminal chunk)
    """

    delta_text: str
    done: bool
    usage: LLMUsage | None = None
    provider_request_id: str | None = None

    def __post_init__(self):
        """Validate streaming invariants."""
        if not self.done and self.usage is not None:
            raise ValueError("Non-terminal chunks (done=False) must have usage=None")
