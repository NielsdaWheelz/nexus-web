"""API error definitions.

All API errors are defined here with their corresponding HTTP status codes.
"""

from enum import Enum
from typing import Any

_ERROR_DETAIL_MAX_CHARS = 1000


class ApiErrorCode(str, Enum):
    """Standardized error codes for the API.

    Format: E_CATEGORY_NAME
    """

    # Authentication errors (401)
    E_UNAUTHENTICATED = "E_UNAUTHENTICATED"

    # Authorization errors (403)
    E_FORBIDDEN = "E_FORBIDDEN"
    E_INTERNAL_ONLY = "E_INTERNAL_ONLY"
    E_DEFAULT_LIBRARY_FORBIDDEN = "E_DEFAULT_LIBRARY_FORBIDDEN"
    E_LIBRARY_FORBIDDEN = "E_LIBRARY_FORBIDDEN"
    E_OWNER_REQUIRED = "E_OWNER_REQUIRED"
    E_OWNER_EXIT_FORBIDDEN = "E_OWNER_EXIT_FORBIDDEN"
    E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN = (
        "E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN"
    )

    # Billing entitlement errors (402)
    E_BILLING_REQUIRED = "E_BILLING_REQUIRED"

    # Billing availability errors (503)
    E_BILLING_DISABLED = "E_BILLING_DISABLED"

    # Not found errors (404)
    E_NOT_FOUND = "E_NOT_FOUND"
    E_LIBRARY_NOT_FOUND = "E_LIBRARY_NOT_FOUND"
    E_MEDIA_NOT_FOUND = "E_MEDIA_NOT_FOUND"
    E_CONVERSATION_NOT_FOUND = "E_CONVERSATION_NOT_FOUND"
    E_MESSAGE_NOT_FOUND = "E_MESSAGE_NOT_FOUND"
    E_USER_NOT_FOUND = "E_USER_NOT_FOUND"
    E_INVITE_NOT_FOUND = "E_INVITE_NOT_FOUND"
    E_DOSSIER_NOT_FOUND = "E_DOSSIER_NOT_FOUND"
    E_DOSSIER_REVISION_NOT_FOUND = "E_DOSSIER_REVISION_NOT_FOUND"

    # Validation errors (400)
    E_INVALID_REQUEST = "E_INVALID_REQUEST"
    E_NAME_INVALID = "E_NAME_INVALID"
    E_INVALID_KIND = "E_INVALID_KIND"
    E_INVALID_CONTENT_TYPE = "E_INVALID_CONTENT_TYPE"
    E_FILE_TOO_LARGE = "E_FILE_TOO_LARGE"
    E_CAPTURE_TOO_LARGE = "E_CAPTURE_TOO_LARGE"
    E_INVALID_FILE_TYPE = "E_INVALID_FILE_TYPE"
    E_STORAGE_MISSING = "E_STORAGE_MISSING"
    E_INVALID_CURSOR = "E_INVALID_CURSOR"
    E_STRIPE_WEBHOOK_INVALID = "E_STRIPE_WEBHOOK_INVALID"
    E_BRANCH_PATH_INVALID = "E_BRANCH_PATH_INVALID"
    E_BRANCH_ANCHOR_INVALID = "E_BRANCH_ANCHOR_INVALID"
    E_DOSSIER_INVALID_SUBJECT = "E_DOSSIER_INVALID_SUBJECT"
    E_DOSSIER_INVALID_INSTRUCTION = "E_DOSSIER_INVALID_INSTRUCTION"

    # Conflict errors (409)
    E_INVITE_ALREADY_EXISTS = "E_INVITE_ALREADY_EXISTS"
    E_INVITE_MEMBER_EXISTS = "E_INVITE_MEMBER_EXISTS"
    E_INVITE_NOT_PENDING = "E_INVITE_NOT_PENDING"
    E_OWNERSHIP_TRANSFER_INVALID = "E_OWNERSHIP_TRANSFER_INVALID"
    E_BRANCH_DELETE_ACTIVE_PATH = "E_BRANCH_DELETE_ACTIVE_PATH"
    E_BRANCH_HAS_ACTIVE_RUN = "E_BRANCH_HAS_ACTIVE_RUN"
    E_NOTE_CONFLICT = "E_NOTE_CONFLICT"
    E_UPLOAD_CONFLICT = "E_UPLOAD_CONFLICT"
    E_READER_STATE_CONFLICT = "E_READER_STATE_CONFLICT"
    E_MEDIA_LAST_REFERENCE = "E_MEDIA_LAST_REFERENCE"
    E_DOSSIER_GENERATION_IN_PROGRESS = "E_DOSSIER_GENERATION_IN_PROGRESS"
    E_DOSSIER_BUILD_NOT_ACTIVE = "E_DOSSIER_BUILD_NOT_ACTIVE"

    # Highlight errors (400/409)
    E_HIGHLIGHT_INVALID_RANGE = "E_HIGHLIGHT_INVALID_RANGE"  # 400
    E_HIGHLIGHT_CONFLICT = "E_HIGHLIGHT_CONFLICT"  # 409
    E_MEDIA_NOT_READY = "E_MEDIA_NOT_READY"  # 409
    E_READER_APPARATUS_STATE_MISSING = "E_READER_APPARATUS_STATE_MISSING"  # 500

    # User API Key errors (400/404)
    E_KEY_PROVIDER_INVALID = "E_KEY_PROVIDER_INVALID"  # 400 - Unknown provider
    E_KEY_INVALID_FORMAT = "E_KEY_INVALID_FORMAT"  # 400 - Key too short or contains whitespace
    E_KEY_NOT_FOUND = "E_KEY_NOT_FOUND"  # 404 - Key doesn't exist or not owned by viewer

    # LLM errors
    E_APP_SEARCH_FAILED = "E_APP_SEARCH_FAILED"  # 500 - Required in-app retrieval failed
    E_MESSAGE_TOO_LONG = "E_MESSAGE_TOO_LONG"  # 400 - Message exceeds 20,000 char limit
    E_CONTEXT_TOO_LARGE = "E_CONTEXT_TOO_LARGE"  # 400 - Context exceeds 25,000 char limit
    E_MODEL_NOT_AVAILABLE = "E_MODEL_NOT_AVAILABLE"  # 400 - Model not available to user
    E_CONVERSATION_BUSY = "E_CONVERSATION_BUSY"  # 409 - Pending assistant already exists
    E_RATE_LIMITED = "E_RATE_LIMITED"  # 429 - Per-user rate limit exceeded
    E_TOKEN_BUDGET_EXCEEDED = "E_TOKEN_BUDGET_EXCEEDED"  # 429 - Platform token budget exceeded
    E_IDEMPOTENCY_KEY_REPLAY_MISMATCH = (
        "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"  # 409 - Key reused with different payload
    )

    # Reader-selection quote-to-chat errors (400/404/409)
    E_READER_SELECTION_NOT_FOUND = "E_READER_SELECTION_NOT_FOUND"  # 404 - highlight/media absent
    E_READER_SELECTION_FORBIDDEN = "E_READER_SELECTION_FORBIDDEN"  # 403 - not viewer-readable
    E_READER_SELECTION_GEOMETRY_ONLY = "E_READER_SELECTION_GEOMETRY_ONLY"  # 400 - blank exact
    E_READER_SELECTION_TOO_LARGE = "E_READER_SELECTION_TOO_LARGE"  # 400 - bounded field over limit
    E_READER_SELECTION_STALE = "E_READER_SELECTION_STALE"  # 409 - revision precondition failed
    E_CONVERSATION_NO_LONGER_EMPTY = "E_CONVERSATION_NO_LONGER_EMPTY"  # 409 - Empty insertion raced

    # Consumption/Lectern errors (409)
    E_MEDIA_DELETING = "E_MEDIA_DELETING"  # 409 - target media has a teardown intent
    E_STALE_LISTENING_REVISION = "E_STALE_LISTENING_REVISION"  # 409 - heartbeat CAS mismatch
    E_LIMIT = "E_LIMIT"  # 409 - Lectern aggregate row limit exceeded

    # Streaming errors
    E_CLIENT_DISCONNECT = "E_CLIENT_DISCONNECT"  # stream aborted by client
    E_ORPHANED_PENDING = "E_ORPHANED_PENDING"  # sweeper cleanup
    E_STREAM_IN_PROGRESS = "E_STREAM_IN_PROGRESS"  # replay while stream running
    E_RATE_LIMITER_UNAVAILABLE = "E_RATE_LIMITER_UNAVAILABLE"  # 503 budget system down
    E_STREAM_TOKEN_EXPIRED = "E_STREAM_TOKEN_EXPIRED"  # 401 token past expiry
    E_STREAM_TOKEN_REPLAYED = "E_STREAM_TOKEN_REPLAYED"  # 401 jti already used
    E_STREAM_TOKEN_INVALID = "E_STREAM_TOKEN_INVALID"  # 401 signature or claims failed
    E_CANCELLED = "E_CANCELLED"  # explicit chat-run cancellation
    E_PODCAST_QUOTA_EXCEEDED = (
        "E_PODCAST_QUOTA_EXCEEDED"  # 429 monthly transcription quota exceeded
    )

    # EPUB errors (400/404/409)
    E_RETRY_INVALID_STATE = "E_RETRY_INVALID_STATE"  # 409
    E_RETRY_NOT_ALLOWED = "E_RETRY_NOT_ALLOWED"  # 409
    E_CHAPTER_NOT_FOUND = "E_CHAPTER_NOT_FOUND"  # 404
    E_ARCHIVE_UNSAFE = "E_ARCHIVE_UNSAFE"  # 400

    # Podcast provider errors
    E_BROWSE_PROVIDER_UNAVAILABLE = "E_BROWSE_PROVIDER_UNAVAILABLE"  # 503 upstream unavailable
    E_PODCAST_PROVIDER_UNAVAILABLE = "E_PODCAST_PROVIDER_UNAVAILABLE"  # 503 upstream unavailable
    E_X_PROVIDER_UNAVAILABLE = "E_X_PROVIDER_UNAVAILABLE"  # 503 upstream unavailable
    E_X_PROVIDER_CREDITS_DEPLETED = "E_X_PROVIDER_CREDITS_DEPLETED"  # 503 operator action
    E_X_PROVIDER_AUTH_REJECTED = "E_X_PROVIDER_AUTH_REJECTED"  # 503 token/access unavailable
    E_X_PROVIDER_RATE_LIMITED = "E_X_PROVIDER_RATE_LIMITED"  # 503 provider throttling
    E_X_PROVIDER_TIMEOUT = "E_X_PROVIDER_TIMEOUT"  # 504 provider timeout
    E_X_POST_UNAVAILABLE = "E_X_POST_UNAVAILABLE"  # 404 unavailable post
    E_TRANSCRIPTION_FAILED = "E_TRANSCRIPTION_FAILED"  # 502 provider returned error
    E_TRANSCRIPTION_TIMEOUT = "E_TRANSCRIPTION_TIMEOUT"  # 504 provider timed out
    E_DIARIZATION_FAILED = "E_DIARIZATION_FAILED"  # 502 diarized attempt failed (diagnostic)
    E_TRANSCRIPT_UNAVAILABLE = "E_TRANSCRIPT_UNAVAILABLE"  # 409 transcript unavailable

    # PDF errors (422)
    E_PDF_PASSWORD_REQUIRED = "E_PDF_PASSWORD_REQUIRED"  # 422

    # Author errors (422)
    E_AUTHOR_ALREADY_LISTED = "E_AUTHOR_ALREADY_LISTED"  # 422 - duplicate canonical contributor
    E_AUTHOR_NOT_SELECTABLE = "E_AUTHOR_NOT_SELECTABLE"  # 422 - unknown or invisible handle

    # Link errors (409/422)
    E_LINK_SELF = "E_LINK_SELF"  # 422 - Link source and target are the same resource
    E_LINK_CAPABILITY = "E_LINK_CAPABILITY"  # 422 - endpoint not admissible for a user Link
    E_LINK_TARGET_AMBIGUOUS = "E_LINK_TARGET_AMBIGUOUS"  # 422 - quote not unique within owner
    E_LINK_TARGET_STALE = "E_LINK_TARGET_STALE"  # 409 - passage candidate row no longer exists

    # Ingestion errors (502/504)
    E_INGEST_FAILED = "E_INGEST_FAILED"  # 502
    E_INGEST_TIMEOUT = "E_INGEST_TIMEOUT"  # 504
    E_METADATA_PARSE_FAILED = "E_METADATA_PARSE_FAILED"  # 502
    E_METADATA_NO_FIELDS = "E_METADATA_NO_FIELDS"  # 502
    E_METADATA_NO_PROVIDER = "E_METADATA_NO_PROVIDER"  # 503

    # Image proxy errors (400/403/413/502/504)
    E_SSRF_BLOCKED = "E_SSRF_BLOCKED"  # 403 - URL violates SSRF rules
    E_IMAGE_FETCH_FAILED = "E_IMAGE_FETCH_FAILED"  # 502 - Upstream fetch failed
    E_IMAGE_TOO_LARGE = "E_IMAGE_TOO_LARGE"  # 413 - Image exceeds size/dimension limits

    # Feed-controlled fetch errors (413/502) — RSS feeds, chapters, transcript sidecars
    E_SOURCE_FETCH_FAILED = "E_SOURCE_FETCH_FAILED"  # 502 - feed-controlled fetch failed
    E_SOURCE_TOO_LARGE = "E_SOURCE_TOO_LARGE"  # 413 - response exceeded streamed size cap

    # Server errors (500/503)
    E_AUTH_UNAVAILABLE = "E_AUTH_UNAVAILABLE"  # 503
    E_INTERNAL = "E_INTERNAL"  # 500
    E_SIGN_UPLOAD_FAILED = "E_SIGN_UPLOAD_FAILED"  # 500
    E_SIGN_DOWNLOAD_FAILED = "E_SIGN_DOWNLOAD_FAILED"  # 500
    E_STORAGE_ERROR = "E_STORAGE_ERROR"  # 500
    E_SANITIZATION_FAILED = "E_SANITIZATION_FAILED"  # 500
    E_BILLING_NOT_CONFIGURED = "E_BILLING_NOT_CONFIGURED"  # 500


# Error code to HTTP status mapping
ERROR_CODE_TO_STATUS: dict[ApiErrorCode, int] = {
    # Authentication errors
    ApiErrorCode.E_UNAUTHENTICATED: 401,
    # Authorization errors
    ApiErrorCode.E_FORBIDDEN: 403,
    ApiErrorCode.E_INTERNAL_ONLY: 403,
    ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN: 403,
    ApiErrorCode.E_LIBRARY_FORBIDDEN: 403,
    ApiErrorCode.E_OWNER_REQUIRED: 403,
    ApiErrorCode.E_OWNER_EXIT_FORBIDDEN: 403,
    ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN: 403,
    ApiErrorCode.E_BILLING_REQUIRED: 402,
    ApiErrorCode.E_BILLING_DISABLED: 503,
    # Not found errors
    ApiErrorCode.E_NOT_FOUND: 404,
    ApiErrorCode.E_LIBRARY_NOT_FOUND: 404,
    ApiErrorCode.E_MEDIA_NOT_FOUND: 404,
    ApiErrorCode.E_CONVERSATION_NOT_FOUND: 404,
    ApiErrorCode.E_MESSAGE_NOT_FOUND: 404,
    ApiErrorCode.E_USER_NOT_FOUND: 404,
    ApiErrorCode.E_INVITE_NOT_FOUND: 404,
    ApiErrorCode.E_DOSSIER_NOT_FOUND: 404,
    ApiErrorCode.E_DOSSIER_REVISION_NOT_FOUND: 404,
    # Validation errors
    ApiErrorCode.E_INVALID_REQUEST: 400,
    ApiErrorCode.E_NAME_INVALID: 400,
    ApiErrorCode.E_INVALID_KIND: 400,
    ApiErrorCode.E_INVALID_CONTENT_TYPE: 400,
    ApiErrorCode.E_FILE_TOO_LARGE: 400,
    ApiErrorCode.E_CAPTURE_TOO_LARGE: 413,
    ApiErrorCode.E_INVALID_FILE_TYPE: 400,
    ApiErrorCode.E_STORAGE_MISSING: 400,
    ApiErrorCode.E_INVALID_CURSOR: 400,
    ApiErrorCode.E_STRIPE_WEBHOOK_INVALID: 400,
    ApiErrorCode.E_BRANCH_PATH_INVALID: 400,
    ApiErrorCode.E_BRANCH_ANCHOR_INVALID: 400,
    ApiErrorCode.E_DOSSIER_INVALID_SUBJECT: 400,
    ApiErrorCode.E_DOSSIER_INVALID_INSTRUCTION: 400,
    # Conflict errors
    ApiErrorCode.E_INVITE_ALREADY_EXISTS: 409,
    ApiErrorCode.E_INVITE_MEMBER_EXISTS: 409,
    ApiErrorCode.E_INVITE_NOT_PENDING: 409,
    ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID: 409,
    ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH: 409,
    ApiErrorCode.E_BRANCH_HAS_ACTIVE_RUN: 409,
    ApiErrorCode.E_NOTE_CONFLICT: 409,
    ApiErrorCode.E_UPLOAD_CONFLICT: 409,
    ApiErrorCode.E_READER_STATE_CONFLICT: 409,
    ApiErrorCode.E_MEDIA_LAST_REFERENCE: 409,
    ApiErrorCode.E_DOSSIER_GENERATION_IN_PROGRESS: 409,
    ApiErrorCode.E_DOSSIER_BUILD_NOT_ACTIVE: 409,
    # Highlight errors
    ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE: 400,
    ApiErrorCode.E_HIGHLIGHT_CONFLICT: 409,
    ApiErrorCode.E_MEDIA_NOT_READY: 409,
    ApiErrorCode.E_READER_APPARATUS_STATE_MISSING: 500,
    # User API Key errors
    ApiErrorCode.E_KEY_PROVIDER_INVALID: 400,
    ApiErrorCode.E_KEY_INVALID_FORMAT: 400,
    ApiErrorCode.E_KEY_NOT_FOUND: 404,
    # LLM errors
    ApiErrorCode.E_APP_SEARCH_FAILED: 500,
    ApiErrorCode.E_MESSAGE_TOO_LONG: 400,
    ApiErrorCode.E_CONTEXT_TOO_LARGE: 400,
    ApiErrorCode.E_MODEL_NOT_AVAILABLE: 400,
    ApiErrorCode.E_CONVERSATION_BUSY: 409,
    ApiErrorCode.E_RATE_LIMITED: 429,
    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED: 429,
    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: 409,
    # Reader-selection quote-to-chat errors
    ApiErrorCode.E_READER_SELECTION_NOT_FOUND: 404,
    ApiErrorCode.E_READER_SELECTION_FORBIDDEN: 403,
    ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY: 400,
    ApiErrorCode.E_READER_SELECTION_TOO_LARGE: 400,
    ApiErrorCode.E_READER_SELECTION_STALE: 409,
    ApiErrorCode.E_CONVERSATION_NO_LONGER_EMPTY: 409,
    # Consumption/Lectern errors
    ApiErrorCode.E_MEDIA_DELETING: 409,
    ApiErrorCode.E_STALE_LISTENING_REVISION: 409,
    ApiErrorCode.E_LIMIT: 409,
    # Streaming errors
    ApiErrorCode.E_CLIENT_DISCONNECT: 499,
    ApiErrorCode.E_ORPHANED_PENDING: 500,
    ApiErrorCode.E_STREAM_IN_PROGRESS: 409,
    ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE: 503,
    ApiErrorCode.E_STREAM_TOKEN_EXPIRED: 401,
    ApiErrorCode.E_STREAM_TOKEN_REPLAYED: 401,
    ApiErrorCode.E_STREAM_TOKEN_INVALID: 401,
    ApiErrorCode.E_CANCELLED: 499,
    ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED: 429,
    # EPUB errors
    ApiErrorCode.E_RETRY_INVALID_STATE: 409,
    ApiErrorCode.E_RETRY_NOT_ALLOWED: 409,
    ApiErrorCode.E_CHAPTER_NOT_FOUND: 404,
    ApiErrorCode.E_ARCHIVE_UNSAFE: 400,
    # Podcast provider errors
    ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE: 503,
    ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE: 503,
    ApiErrorCode.E_X_PROVIDER_UNAVAILABLE: 503,
    ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED: 503,
    ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED: 503,
    ApiErrorCode.E_X_PROVIDER_RATE_LIMITED: 503,
    ApiErrorCode.E_X_PROVIDER_TIMEOUT: 504,
    ApiErrorCode.E_X_POST_UNAVAILABLE: 404,
    ApiErrorCode.E_TRANSCRIPTION_FAILED: 502,
    ApiErrorCode.E_TRANSCRIPTION_TIMEOUT: 504,
    ApiErrorCode.E_DIARIZATION_FAILED: 502,
    ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE: 409,
    # PDF errors
    ApiErrorCode.E_PDF_PASSWORD_REQUIRED: 422,
    # Author errors
    ApiErrorCode.E_AUTHOR_ALREADY_LISTED: 422,
    ApiErrorCode.E_AUTHOR_NOT_SELECTABLE: 422,
    # Link errors
    ApiErrorCode.E_LINK_SELF: 422,
    ApiErrorCode.E_LINK_CAPABILITY: 422,
    ApiErrorCode.E_LINK_TARGET_AMBIGUOUS: 422,
    ApiErrorCode.E_LINK_TARGET_STALE: 409,
    # Ingestion errors
    ApiErrorCode.E_INGEST_FAILED: 502,
    ApiErrorCode.E_INGEST_TIMEOUT: 504,
    ApiErrorCode.E_METADATA_PARSE_FAILED: 502,
    ApiErrorCode.E_METADATA_NO_FIELDS: 502,
    ApiErrorCode.E_METADATA_NO_PROVIDER: 503,
    # Image proxy errors
    ApiErrorCode.E_SSRF_BLOCKED: 403,
    ApiErrorCode.E_IMAGE_FETCH_FAILED: 502,
    ApiErrorCode.E_IMAGE_TOO_LARGE: 413,
    ApiErrorCode.E_SOURCE_FETCH_FAILED: 502,
    ApiErrorCode.E_SOURCE_TOO_LARGE: 413,
    # Server errors
    ApiErrorCode.E_AUTH_UNAVAILABLE: 503,
    ApiErrorCode.E_INTERNAL: 500,
    ApiErrorCode.E_SIGN_UPLOAD_FAILED: 500,
    ApiErrorCode.E_SIGN_DOWNLOAD_FAILED: 500,
    ApiErrorCode.E_STORAGE_ERROR: 500,
    ApiErrorCode.E_SANITIZATION_FAILED: 500,
    ApiErrorCode.E_BILLING_NOT_CONFIGURED: 500,
}


def exception_error_detail(
    exc: BaseException,
    *,
    provider_request_id: str | None = None,
    max_chars: int = _ERROR_DETAIL_MAX_CHARS,
) -> str:
    """Operator-facing terminal detail with provider request id when available."""
    request_id = provider_request_id
    detail = f"{type(exc).__name__}: {exc}"
    if request_id is None:
        return detail[:max_chars]
    suffix = f" (provider_request_id={request_id})"
    if max_chars <= len(suffix):
        return suffix[:max_chars]
    return f"{detail[: max_chars - len(suffix)]}{suffix}"


class ApiError(Exception):
    """Base exception for API errors.

    Attributes:
        code: The error code enum value
        message: Human-readable error message
        status_code: HTTP status code (derived from code)
    """

    def __init__(
        self,
        code: ApiErrorCode,
        message: str,
        *,
        retry_after_seconds: int | None = None,
        details: dict[str, Any] | None = None,
    ):
        self.code = code
        self.message = message
        self.retry_after_seconds = retry_after_seconds
        self.details = details
        self.status_code = ERROR_CODE_TO_STATUS.get(code, 500)
        super().__init__(message)


class NotFoundError(ApiError):
    """Resource not found error."""

    def __init__(self, code: ApiErrorCode = ApiErrorCode.E_NOT_FOUND, message: str = "Not found"):
        super().__init__(code, message)


class ForbiddenError(ApiError):
    """Authorization failure error."""

    def __init__(self, code: ApiErrorCode = ApiErrorCode.E_FORBIDDEN, message: str = "Forbidden"):
        super().__init__(code, message)


class ConflictError(ApiError):
    """Conflict error (409)."""

    def __init__(
        self,
        code: ApiErrorCode = ApiErrorCode.E_INVITE_NOT_PENDING,
        message: str = "Conflict",
        *,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(code, message, details=details)


class InvalidRequestError(ApiError):
    """Invalid request error."""

    def __init__(
        self, code: ApiErrorCode = ApiErrorCode.E_INVALID_REQUEST, message: str = "Invalid request"
    ):
        super().__init__(code, message)
