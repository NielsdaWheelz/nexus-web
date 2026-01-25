"""LLM error classification and normalization.

Per PR-04 spec section 5:
- Classifies provider-specific errors into normalized error classes
- Called by router after catching adapter exceptions
- Supports OpenAI, Anthropic, and Gemini error patterns

Error classes:
- E_LLM_INVALID_KEY: Authentication failure (401/403)
- E_LLM_RATE_LIMIT: Rate limit exceeded (429)
- E_LLM_CONTEXT_TOO_LARGE: Context length exceeded
- E_LLM_TIMEOUT: Request timed out
- E_LLM_PROVIDER_DOWN: Provider unavailable (5xx, network error)
- E_MODEL_NOT_AVAILABLE: Model not found or disabled
"""

from enum import Enum

from nexus.logging import get_logger

logger = get_logger(__name__)


class LLMErrorClass(str, Enum):
    """Normalized LLM error classifications.

    These map to error codes in the API responses.
    """

    INVALID_KEY = "E_LLM_INVALID_KEY"
    RATE_LIMIT = "E_LLM_RATE_LIMIT"
    CONTEXT_TOO_LARGE = "E_LLM_CONTEXT_TOO_LARGE"
    TIMEOUT = "E_LLM_TIMEOUT"
    PROVIDER_DOWN = "E_LLM_PROVIDER_DOWN"
    MODEL_NOT_AVAILABLE = "E_MODEL_NOT_AVAILABLE"


class LLMError(Exception):
    """Exception for LLM-related errors.

    Attributes:
        error_class: The normalized error classification
        message: Human-readable error message
        provider: The provider that returned the error (if known)
    """

    def __init__(
        self,
        error_class: LLMErrorClass,
        message: str,
        provider: str | None = None,
    ):
        self.error_class = error_class
        self.message = message
        self.provider = provider
        super().__init__(message)


def classify_provider_error(
    provider: str,
    status_code: int | None,
    json_body: dict | None,
    exception: Exception | None,
) -> LLMErrorClass:
    """Classify provider error into normalized error class.

    Called by router after catching adapter exceptions.

    Args:
        provider: One of "openai", "anthropic", "gemini"
        status_code: HTTP status code (if available)
        json_body: Parsed JSON error response (if available)
        exception: The exception that was raised (if any)

    Returns:
        The appropriate LLMErrorClass for this error.
    """
    # Handle timeout exceptions first (no status code)
    if exception is not None:
        exception_type = type(exception).__name__
        if "Timeout" in exception_type or "timeout" in str(exception).lower():
            return LLMErrorClass.TIMEOUT
        if "Network" in exception_type or "Connection" in exception_type:
            return LLMErrorClass.PROVIDER_DOWN

    # No status code means we can't classify further
    if status_code is None:
        return LLMErrorClass.PROVIDER_DOWN

    # Route to provider-specific classification
    if provider == "openai":
        return _classify_openai_error(status_code, json_body)
    elif provider == "anthropic":
        return _classify_anthropic_error(status_code, json_body)
    elif provider == "gemini":
        return _classify_gemini_error(status_code, json_body)
    else:
        logger.warning("unknown_provider_for_error_classification", provider=provider)
        return LLMErrorClass.PROVIDER_DOWN


def _classify_openai_error(status_code: int, json_body: dict | None) -> LLMErrorClass:
    """Classify OpenAI-specific errors.

    Per PR-04 spec:
    - 401 or 403 → INVALID_KEY
    - 429 → RATE_LIMIT
    - 400 + error.code == "context_length_exceeded" → CONTEXT_TOO_LARGE
    - 400 + "maximum context length" in message → CONTEXT_TOO_LARGE
    - 5xx → PROVIDER_DOWN
    - 404 + model not found → MODEL_NOT_AVAILABLE
    """
    if status_code in (401, 403):
        return LLMErrorClass.INVALID_KEY

    if status_code == 429:
        return LLMErrorClass.RATE_LIMIT

    if status_code == 404:
        return LLMErrorClass.MODEL_NOT_AVAILABLE

    if status_code >= 500:
        return LLMErrorClass.PROVIDER_DOWN

    if status_code == 400 and json_body:
        error = json_body.get("error", {})
        error_code = error.get("code", "")
        error_message = error.get("message", "").lower()

        if error_code == "context_length_exceeded":
            return LLMErrorClass.CONTEXT_TOO_LARGE
        if "maximum context length" in error_message:
            return LLMErrorClass.CONTEXT_TOO_LARGE
        if "model" in error_message and "not found" in error_message:
            return LLMErrorClass.MODEL_NOT_AVAILABLE

    return LLMErrorClass.PROVIDER_DOWN


def _classify_anthropic_error(status_code: int, json_body: dict | None) -> LLMErrorClass:
    """Classify Anthropic-specific errors.

    Per PR-04 spec:
    - 401 or 403 → INVALID_KEY
    - 429 → RATE_LIMIT
    - 400 + error.type == "invalid_request_error" + "too long" in message → CONTEXT_TOO_LARGE
    - 5xx → PROVIDER_DOWN
    - 404 → MODEL_NOT_AVAILABLE
    """
    if status_code in (401, 403):
        return LLMErrorClass.INVALID_KEY

    if status_code == 429:
        return LLMErrorClass.RATE_LIMIT

    if status_code == 404:
        return LLMErrorClass.MODEL_NOT_AVAILABLE

    if status_code >= 500:
        return LLMErrorClass.PROVIDER_DOWN

    if status_code == 400 and json_body:
        error = json_body.get("error", {})
        error_type = error.get("type", "")
        error_message = error.get("message", "").lower()

        if error_type == "invalid_request_error" and "too long" in error_message:
            return LLMErrorClass.CONTEXT_TOO_LARGE

    return LLMErrorClass.PROVIDER_DOWN


def _classify_gemini_error(status_code: int, json_body: dict | None) -> LLMErrorClass:
    """Classify Gemini-specific errors.

    Per PR-04 spec:
    - 401 or 403 or "API_KEY_INVALID" in body → INVALID_KEY
    - 429 or "RESOURCE_EXHAUSTED" → RATE_LIMIT
    - "exceeds the maximum" in message → CONTEXT_TOO_LARGE
    - 5xx → PROVIDER_DOWN
    - 404 or "model not found" → MODEL_NOT_AVAILABLE
    """
    # Check body for specific error codes first
    body_str = str(json_body).lower() if json_body else ""

    if "api_key_invalid" in body_str:
        return LLMErrorClass.INVALID_KEY

    if status_code in (401, 403):
        return LLMErrorClass.INVALID_KEY

    if status_code == 429 or "resource_exhausted" in body_str:
        return LLMErrorClass.RATE_LIMIT

    if "exceeds the maximum" in body_str:
        return LLMErrorClass.CONTEXT_TOO_LARGE

    if status_code == 404 or "model not found" in body_str:
        return LLMErrorClass.MODEL_NOT_AVAILABLE

    if status_code >= 500:
        return LLMErrorClass.PROVIDER_DOWN

    return LLMErrorClass.PROVIDER_DOWN
