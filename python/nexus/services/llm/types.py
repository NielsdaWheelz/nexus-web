"""LLM adapter type definitions.

Data types for LLM requests, responses, and errors.
These types provide a unified interface across all providers.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class LLMErrorClass(str, Enum):
    """Normalized error classes across all providers.

    These map to user-friendly error messages in assistant content.
    """

    TIMEOUT = "E_LLM_TIMEOUT"
    RATE_LIMIT = "E_LLM_RATE_LIMIT"
    INVALID_KEY = "E_LLM_INVALID_KEY"
    PROVIDER_DOWN = "E_LLM_PROVIDER_DOWN"
    CONTEXT_TOO_LARGE = "E_LLM_CONTEXT_TOO_LARGE"
    UNKNOWN = "E_LLM_UNKNOWN"


# User-friendly error messages for assistant content
ERROR_CLASS_TO_MESSAGE: dict[LLMErrorClass, str] = {
    LLMErrorClass.TIMEOUT: "The model timed out while responding. Please try again.",
    LLMErrorClass.RATE_LIMIT: "The model is temporarily rate-limited. Please try again shortly.",
    LLMErrorClass.INVALID_KEY: "The configured API key is invalid or has been revoked.",
    LLMErrorClass.PROVIDER_DOWN: "The model provider is currently unavailable. Please try again later.",
    LLMErrorClass.CONTEXT_TOO_LARGE: "The context was too large for the model. Please try with less context.",
    LLMErrorClass.UNKNOWN: "An unexpected error occurred. Please try again.",
}


@dataclass
class LLMError(Exception):
    """Exception for LLM provider errors."""

    error_class: LLMErrorClass
    message: str
    provider_message: str | None = None  # Original provider error message

    def __str__(self) -> str:
        return f"{self.error_class.value}: {self.message}"

    @property
    def user_message(self) -> str:
        """Get user-friendly message for assistant content."""
        return ERROR_CLASS_TO_MESSAGE.get(
            self.error_class, ERROR_CLASS_TO_MESSAGE[LLMErrorClass.UNKNOWN]
        )


@dataclass
class ChatMessage:
    """A single message in a chat conversation."""

    role: Literal["system", "user", "assistant"]
    content: str


@dataclass
class LLMRequest:
    """Request to an LLM provider."""

    messages: list[ChatMessage]
    model: str
    max_tokens: int = 4096
    temperature: float = 0.7

    # Internal tracking
    provider: str = ""  # Set by adapter


@dataclass
class LLMUsage:
    """Token usage information from LLM response."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


@dataclass
class LLMResponse:
    """Response from an LLM provider."""

    content: str
    usage: LLMUsage = field(default_factory=LLMUsage)
    model: str = ""  # Model name returned by provider
    finish_reason: str | None = None  # "stop", "length", etc.


@dataclass
class LLMChunk:
    """A chunk in a streaming LLM response."""

    delta: str  # Incremental text content
    finish_reason: str | None = None  # Only set on final chunk


@dataclass
class ResolvedKey:
    """Result of API key resolution."""

    api_key: str
    mode: Literal["platform", "byok"]
    provider: str
    user_key_id: str | None = None  # Set if BYOK
