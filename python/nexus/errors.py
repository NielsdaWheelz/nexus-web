"""API error definitions.

All API errors are defined here with their corresponding HTTP status codes.
"""

from enum import Enum


class ApiErrorCode(str, Enum):
    """Standardized error codes for the API.

    Format: E_CATEGORY_NAME
    All error codes are defined here for Slice 0.
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

    # Validation errors (400)
    E_INVALID_REQUEST = "E_INVALID_REQUEST"
    E_NAME_INVALID = "E_NAME_INVALID"
    E_INVALID_KIND = "E_INVALID_KIND"
    E_INVALID_CONTENT_TYPE = "E_INVALID_CONTENT_TYPE"
    E_FILE_TOO_LARGE = "E_FILE_TOO_LARGE"
    E_INVALID_FILE_TYPE = "E_INVALID_FILE_TYPE"
    E_STORAGE_MISSING = "E_STORAGE_MISSING"
    E_INGEST_TIMEOUT = "E_INGEST_TIMEOUT"

    # Server errors
    E_AUTH_UNAVAILABLE = "E_AUTH_UNAVAILABLE"  # 503
    E_INTERNAL = "E_INTERNAL"  # 500
    E_SIGN_UPLOAD_FAILED = "E_SIGN_UPLOAD_FAILED"  # 500
    E_SIGN_DOWNLOAD_FAILED = "E_SIGN_DOWNLOAD_FAILED"  # 500
    E_STORAGE_ERROR = "E_STORAGE_ERROR"  # 500


# Error code to HTTP status mapping
ERROR_CODE_TO_STATUS: dict[ApiErrorCode, int] = {
    ApiErrorCode.E_UNAUTHENTICATED: 401,
    ApiErrorCode.E_FORBIDDEN: 403,
    ApiErrorCode.E_INTERNAL_ONLY: 403,
    ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN: 403,
    ApiErrorCode.E_LAST_ADMIN_FORBIDDEN: 403,
    ApiErrorCode.E_NOT_FOUND: 404,
    ApiErrorCode.E_LIBRARY_NOT_FOUND: 404,
    ApiErrorCode.E_MEDIA_NOT_FOUND: 404,
    ApiErrorCode.E_INVALID_REQUEST: 400,
    ApiErrorCode.E_NAME_INVALID: 400,
    ApiErrorCode.E_INVALID_KIND: 400,
    ApiErrorCode.E_INVALID_CONTENT_TYPE: 400,
    ApiErrorCode.E_FILE_TOO_LARGE: 400,
    ApiErrorCode.E_INVALID_FILE_TYPE: 400,
    ApiErrorCode.E_STORAGE_MISSING: 400,
    ApiErrorCode.E_INGEST_TIMEOUT: 504,
    ApiErrorCode.E_AUTH_UNAVAILABLE: 503,
    ApiErrorCode.E_INTERNAL: 500,
    ApiErrorCode.E_SIGN_UPLOAD_FAILED: 500,
    ApiErrorCode.E_SIGN_DOWNLOAD_FAILED: 500,
    ApiErrorCode.E_STORAGE_ERROR: 500,
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
