"""API error definitions.

All API errors are defined here with their corresponding HTTP status codes.
"""

from enum import Enum


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
    E_LAST_ADMIN_FORBIDDEN = "E_LAST_ADMIN_FORBIDDEN"

    # Not found errors (404)
    E_NOT_FOUND = "E_NOT_FOUND"
    E_LIBRARY_NOT_FOUND = "E_LIBRARY_NOT_FOUND"
    E_MEDIA_NOT_FOUND = "E_MEDIA_NOT_FOUND"
    E_CONVERSATION_NOT_FOUND = "E_CONVERSATION_NOT_FOUND"
    E_MESSAGE_NOT_FOUND = "E_MESSAGE_NOT_FOUND"

    # Validation errors (400)
    E_INVALID_REQUEST = "E_INVALID_REQUEST"
    E_NAME_INVALID = "E_NAME_INVALID"
    E_INVALID_KIND = "E_INVALID_KIND"
    E_INVALID_CONTENT_TYPE = "E_INVALID_CONTENT_TYPE"
    E_FILE_TOO_LARGE = "E_FILE_TOO_LARGE"
    E_INVALID_FILE_TYPE = "E_INVALID_FILE_TYPE"
    E_STORAGE_MISSING = "E_STORAGE_MISSING"
    E_INVALID_CURSOR = "E_INVALID_CURSOR"

    # Conflict errors (409)
    E_SHARE_REQUIRED = "E_SHARE_REQUIRED"
    E_SHARES_NOT_ALLOWED = "E_SHARES_NOT_ALLOWED"

    # Highlight errors (400/409)
    E_HIGHLIGHT_INVALID_RANGE = "E_HIGHLIGHT_INVALID_RANGE"  # 400
    E_HIGHLIGHT_CONFLICT = "E_HIGHLIGHT_CONFLICT"  # 409
    E_MEDIA_NOT_READY = "E_MEDIA_NOT_READY"  # 409

    # User API Key errors (400/404)
    E_KEY_PROVIDER_INVALID = "E_KEY_PROVIDER_INVALID"  # 400 - Unknown provider
    E_KEY_INVALID_FORMAT = "E_KEY_INVALID_FORMAT"  # 400 - Key too short or contains whitespace
    E_KEY_NOT_FOUND = "E_KEY_NOT_FOUND"  # 404 - Key doesn't exist or not owned by viewer

    # LLM errors (PR-05)
    E_LLM_NO_KEY = "E_LLM_NO_KEY"  # 400 - No API key available for provider
    E_LLM_RATE_LIMIT = "E_LLM_RATE_LIMIT"  # 429 - Provider rate limit exceeded
    E_LLM_INVALID_KEY = "E_LLM_INVALID_KEY"  # 400 - API key is invalid or revoked
    E_LLM_PROVIDER_DOWN = "E_LLM_PROVIDER_DOWN"  # 503 - Provider service unavailable
    E_LLM_TIMEOUT = "E_LLM_TIMEOUT"  # 504 - Provider request timed out
    E_LLM_CONTEXT_TOO_LARGE = "E_LLM_CONTEXT_TOO_LARGE"  # 400 - Context too large for model
    E_MESSAGE_TOO_LONG = "E_MESSAGE_TOO_LONG"  # 400 - Message exceeds 20,000 char limit
    E_CONTEXT_TOO_LARGE = "E_CONTEXT_TOO_LARGE"  # 400 - Context exceeds 25,000 char limit
    E_MODEL_NOT_AVAILABLE = "E_MODEL_NOT_AVAILABLE"  # 400 - Model not available to user
    E_CONVERSATION_BUSY = "E_CONVERSATION_BUSY"  # 409 - Pending assistant already exists
    E_RATE_LIMITED = "E_RATE_LIMITED"  # 429 - Per-user rate limit exceeded
    E_TOKEN_BUDGET_EXCEEDED = "E_TOKEN_BUDGET_EXCEEDED"  # 429 - Platform token budget exceeded
    E_IDEMPOTENCY_KEY_REPLAY_MISMATCH = (
        "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"  # 409 - Key reused with different payload
    )

    # Streaming errors (PR-08)
    E_CLIENT_DISCONNECT = "E_CLIENT_DISCONNECT"  # stream aborted by client
    E_ORPHANED_PENDING = "E_ORPHANED_PENDING"  # sweeper cleanup
    E_STREAM_IN_PROGRESS = "E_STREAM_IN_PROGRESS"  # replay while stream running
    E_RATE_LIMITER_UNAVAILABLE = "E_RATE_LIMITER_UNAVAILABLE"  # 503 budget system down
    E_STREAM_TOKEN_EXPIRED = "E_STREAM_TOKEN_EXPIRED"  # 401 token past expiry
    E_STREAM_TOKEN_REPLAYED = "E_STREAM_TOKEN_REPLAYED"  # 401 jti already used
    E_STREAM_TOKEN_INVALID = "E_STREAM_TOKEN_INVALID"  # 401 signature or claims failed

    # Ingestion errors (502/504)
    E_INGEST_FAILED = "E_INGEST_FAILED"  # 502
    E_INGEST_TIMEOUT = "E_INGEST_TIMEOUT"  # 504

    # Image proxy errors (400/403/413/502/504)
    E_SSRF_BLOCKED = "E_SSRF_BLOCKED"  # 403 - URL violates SSRF rules
    E_IMAGE_FETCH_FAILED = "E_IMAGE_FETCH_FAILED"  # 502 - Upstream fetch failed
    E_IMAGE_TOO_LARGE = "E_IMAGE_TOO_LARGE"  # 413 - Image exceeds size/dimension limits

    # Server errors (500/503)
    E_AUTH_UNAVAILABLE = "E_AUTH_UNAVAILABLE"  # 503
    E_INTERNAL = "E_INTERNAL"  # 500
    E_SIGN_UPLOAD_FAILED = "E_SIGN_UPLOAD_FAILED"  # 500
    E_SIGN_DOWNLOAD_FAILED = "E_SIGN_DOWNLOAD_FAILED"  # 500
    E_STORAGE_ERROR = "E_STORAGE_ERROR"  # 500
    E_SANITIZATION_FAILED = "E_SANITIZATION_FAILED"  # 500


# Error code to HTTP status mapping
ERROR_CODE_TO_STATUS: dict[ApiErrorCode, int] = {
    # Authentication errors
    ApiErrorCode.E_UNAUTHENTICATED: 401,
    # Authorization errors
    ApiErrorCode.E_FORBIDDEN: 403,
    ApiErrorCode.E_INTERNAL_ONLY: 403,
    ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN: 403,
    ApiErrorCode.E_LAST_ADMIN_FORBIDDEN: 403,
    # Not found errors
    ApiErrorCode.E_NOT_FOUND: 404,
    ApiErrorCode.E_LIBRARY_NOT_FOUND: 404,
    ApiErrorCode.E_MEDIA_NOT_FOUND: 404,
    ApiErrorCode.E_CONVERSATION_NOT_FOUND: 404,
    ApiErrorCode.E_MESSAGE_NOT_FOUND: 404,
    # Validation errors
    ApiErrorCode.E_INVALID_REQUEST: 400,
    ApiErrorCode.E_NAME_INVALID: 400,
    ApiErrorCode.E_INVALID_KIND: 400,
    ApiErrorCode.E_INVALID_CONTENT_TYPE: 400,
    ApiErrorCode.E_FILE_TOO_LARGE: 400,
    ApiErrorCode.E_INVALID_FILE_TYPE: 400,
    ApiErrorCode.E_STORAGE_MISSING: 400,
    ApiErrorCode.E_INVALID_CURSOR: 400,
    # Conflict errors
    ApiErrorCode.E_SHARE_REQUIRED: 409,
    ApiErrorCode.E_SHARES_NOT_ALLOWED: 409,
    # Highlight errors
    ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE: 400,
    ApiErrorCode.E_HIGHLIGHT_CONFLICT: 409,
    ApiErrorCode.E_MEDIA_NOT_READY: 409,
    # User API Key errors
    ApiErrorCode.E_KEY_PROVIDER_INVALID: 400,
    ApiErrorCode.E_KEY_INVALID_FORMAT: 400,
    ApiErrorCode.E_KEY_NOT_FOUND: 404,
    # LLM errors (PR-05)
    ApiErrorCode.E_LLM_NO_KEY: 400,
    ApiErrorCode.E_LLM_RATE_LIMIT: 429,
    ApiErrorCode.E_LLM_INVALID_KEY: 400,
    ApiErrorCode.E_LLM_PROVIDER_DOWN: 503,
    ApiErrorCode.E_LLM_TIMEOUT: 504,
    ApiErrorCode.E_LLM_CONTEXT_TOO_LARGE: 400,
    ApiErrorCode.E_MESSAGE_TOO_LONG: 400,
    ApiErrorCode.E_CONTEXT_TOO_LARGE: 400,
    ApiErrorCode.E_MODEL_NOT_AVAILABLE: 400,
    ApiErrorCode.E_CONVERSATION_BUSY: 409,
    ApiErrorCode.E_RATE_LIMITED: 429,
    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED: 429,
    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: 409,
    # Streaming errors (PR-08)
    ApiErrorCode.E_CLIENT_DISCONNECT: 499,
    ApiErrorCode.E_ORPHANED_PENDING: 500,
    ApiErrorCode.E_STREAM_IN_PROGRESS: 409,
    ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE: 503,
    ApiErrorCode.E_STREAM_TOKEN_EXPIRED: 401,
    ApiErrorCode.E_STREAM_TOKEN_REPLAYED: 401,
    ApiErrorCode.E_STREAM_TOKEN_INVALID: 401,
    # Ingestion errors
    ApiErrorCode.E_INGEST_FAILED: 502,
    ApiErrorCode.E_INGEST_TIMEOUT: 504,
    # Image proxy errors
    ApiErrorCode.E_SSRF_BLOCKED: 403,
    ApiErrorCode.E_IMAGE_FETCH_FAILED: 502,
    ApiErrorCode.E_IMAGE_TOO_LARGE: 413,
    # Server errors
    ApiErrorCode.E_AUTH_UNAVAILABLE: 503,
    ApiErrorCode.E_INTERNAL: 500,
    ApiErrorCode.E_SIGN_UPLOAD_FAILED: 500,
    ApiErrorCode.E_SIGN_DOWNLOAD_FAILED: 500,
    ApiErrorCode.E_STORAGE_ERROR: 500,
    ApiErrorCode.E_SANITIZATION_FAILED: 500,
}


class ApiError(Exception):
    """Base exception for API errors.

    Attributes:
        code: The error code enum value
        message: Human-readable error message
        status_code: HTTP status code (derived from code)
    """

    def __init__(self, code: ApiErrorCode, message: str):
        self.code = code
        self.message = message
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


class InvalidRequestError(ApiError):
    """Invalid request error."""

    def __init__(
        self, code: ApiErrorCode = ApiErrorCode.E_INVALID_REQUEST, message: str = "Invalid request"
    ):
        super().__init__(code, message)
