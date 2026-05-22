"""Transport-agnostic quote-context error vocabulary.

Shared by sync and streaming quote-to-chat paths so context-rendering failures
can propagate with consistent external error codes.
"""

from nexus.errors import ApiErrorCode

_DEFAULT_MESSAGES: dict[ApiErrorCode, str] = {
    ApiErrorCode.E_MEDIA_NOT_READY: (
        "PDF quote context is not ready yet. Try again after PDF text processing completes."
    ),
    ApiErrorCode.E_INTERNAL: "Unable to render quote context due to an internal error.",
}


class QuoteContextBlockingError(Exception):
    """A quote-context failure that must block request execution."""

    def __init__(self, error_code: ApiErrorCode, message: str | None = None):
        self.error_code = error_code
        self.message = message or _DEFAULT_MESSAGES.get(error_code, "Quote context unavailable.")
        super().__init__(self.message)
