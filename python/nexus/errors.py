"""The api's closed error vocabulary and the exceptions that carry it.

Every code carries its HTTP status, so the envelope (``nexus.responses``) derives the
status from the code and a client branches on the code alone.
"""

from enum import Enum
from typing import Any, Literal


class ApiErrorCode(str, Enum):
    """``E_CATEGORY_NAME``; each member carries its HTTP status."""

    status: int

    def __new__(cls, value: str, status: int) -> "ApiErrorCode":
        member = str.__new__(cls, value)
        member._value_ = value
        member.status = status
        return member

    # Authentication errors
    E_CONTEXT_CHANGED = ("E_CONTEXT_CHANGED", 409)
    E_UNAUTHENTICATED = ("E_UNAUTHENTICATED", 401)

    # Authorization errors
    E_FORBIDDEN = ("E_FORBIDDEN", 403)
    E_INTERNAL_ONLY = ("E_INTERNAL_ONLY", 403)
    E_DEFAULT_LIBRARY_FORBIDDEN = ("E_DEFAULT_LIBRARY_FORBIDDEN", 403)
    E_LIBRARY_FORBIDDEN = ("E_LIBRARY_FORBIDDEN", 403)
    E_OWNER_REQUIRED = ("E_OWNER_REQUIRED", 403)
    E_OWNER_EXIT_FORBIDDEN = ("E_OWNER_EXIT_FORBIDDEN", 403)

    # Not found errors
    E_NOT_FOUND = ("E_NOT_FOUND", 404)
    E_LIBRARY_NOT_FOUND = ("E_LIBRARY_NOT_FOUND", 404)
    E_MEDIA_NOT_FOUND = ("E_MEDIA_NOT_FOUND", 404)
    E_CONVERSATION_NOT_FOUND = ("E_CONVERSATION_NOT_FOUND", 404)
    E_MESSAGE_NOT_FOUND = ("E_MESSAGE_NOT_FOUND", 404)
    E_USER_NOT_FOUND = ("E_USER_NOT_FOUND", 404)
    E_INVITE_NOT_FOUND = ("E_INVITE_NOT_FOUND", 404)
    E_UPLOAD_SESSION_NOT_FOUND = ("E_UPLOAD_SESSION_NOT_FOUND", 404)
    E_IMPORT_NOT_FOUND = ("E_IMPORT_NOT_FOUND", 404)

    # Validation errors
    E_INVALID_REQUEST = ("E_INVALID_REQUEST", 400)
    E_NAME_INVALID = ("E_NAME_INVALID", 400)
    E_INVALID_KIND = ("E_INVALID_KIND", 400)
    E_INVALID_CONTENT_TYPE = ("E_INVALID_CONTENT_TYPE", 400)
    E_FILE_TOO_LARGE = ("E_FILE_TOO_LARGE", 400)
    E_CAPTURE_TOO_LARGE = ("E_CAPTURE_TOO_LARGE", 413)
    E_INVALID_FILE_TYPE = ("E_INVALID_FILE_TYPE", 400)
    E_STORAGE_MISSING = ("E_STORAGE_MISSING", 400)
    E_SOURCE_INTEGRITY = ("E_SOURCE_INTEGRITY", 400)
    E_INVALID_CURSOR = ("E_INVALID_CURSOR", 400)
    E_INVALID_BROWSE_QUERY = ("E_INVALID_BROWSE_QUERY", 400)
    E_INVALID_DISCOVERY_TARGET = ("E_INVALID_DISCOVERY_TARGET", 400)
    E_BRANCH_PATH_INVALID = ("E_BRANCH_PATH_INVALID", 400)
    E_BRANCH_ANCHOR_INVALID = ("E_BRANCH_ANCHOR_INVALID", 400)
    E_EMPTY_NOTE_BODY = ("E_EMPTY_NOTE_BODY", 400)

    # Conflict errors
    E_CONVERSATION_CHANGED = ("E_CONVERSATION_CHANGED", 409)
    E_INVITE_ALREADY_EXISTS = ("E_INVITE_ALREADY_EXISTS", 409)
    E_INVITE_MEMBER_EXISTS = ("E_INVITE_MEMBER_EXISTS", 409)
    E_INVITE_NOT_PENDING = ("E_INVITE_NOT_PENDING", 409)
    E_OWNERSHIP_TRANSFER_INVALID = ("E_OWNERSHIP_TRANSFER_INVALID", 409)
    E_NOTE_CONFLICT = ("E_NOTE_CONFLICT", 409)
    E_RESOURCE_CONFLICT = ("E_RESOURCE_CONFLICT", 409)
    E_WRITING_DEPENDENCY_GONE = ("E_WRITING_DEPENDENCY_GONE", 409)
    E_READER_STATE_CONFLICT = ("E_READER_STATE_CONFLICT", 409)
    E_READER_CONTENT_CHANGED = ("E_READER_CONTENT_CHANGED", 409)
    E_ACTIVITY_CAPTURE_CONFLICT = ("E_ACTIVITY_CAPTURE_CONFLICT", 409)
    E_SELECTION_CHANGED = ("E_SELECTION_CHANGED", 409)
    E_PODCAST_EPISODE_IDENTITY_CONFLICT = ("E_PODCAST_EPISODE_IDENTITY_CONFLICT", 409)
    E_CAPTURE_TARGET_CHANGED = ("E_CAPTURE_TARGET_CHANGED", 409)
    E_UPLOAD_CAPABILITY_EXPIRED = ("E_UPLOAD_CAPABILITY_EXPIRED", 409)
    E_UPLOAD_GENERATION_STALE = ("E_UPLOAD_GENERATION_STALE", 409)
    E_UPLOAD_ALREADY_PUBLISHED = ("E_UPLOAD_ALREADY_PUBLISHED", 409)
    E_UPLOAD_INTENT_MISMATCH = ("E_UPLOAD_INTENT_MISMATCH", 409)

    E_PART_SOURCE_PINNED = ("E_PART_SOURCE_PINNED", 409)
    E_PART_CONFLICT = ("E_PART_CONFLICT", 409)
    E_PART_SELECTION_INVALID = ("E_PART_SELECTION_INVALID", 400)

    # Highlight errors
    E_HIGHLIGHT_INVALID_RANGE = ("E_HIGHLIGHT_INVALID_RANGE", 400)
    E_HIGHLIGHT_CONFLICT = ("E_HIGHLIGHT_CONFLICT", 409)
    E_MEDIA_NOT_READY = ("E_MEDIA_NOT_READY", 409)
    E_READER_APPARATUS_STATE_MISSING = ("E_READER_APPARATUS_STATE_MISSING", 500)

    # LLM errors
    E_APP_SEARCH_FAILED = ("E_APP_SEARCH_FAILED", 500)  # Required in-app retrieval failed
    # Indexing: the embedding provider stayed unavailable through its transient retries.
    E_EMBEDDING_PROVIDER_UNAVAILABLE = ("E_EMBEDDING_PROVIDER_UNAVAILABLE", 503)
    E_MESSAGE_TOO_LONG = ("E_MESSAGE_TOO_LONG", 400)  # Message exceeds 20,000 char limit
    E_RATE_LIMITED = ("E_RATE_LIMITED", 429)  # live-stream listener capacity (db/listen.py)

    # Reader-selection quote-to-chat errors
    E_READER_SELECTION_NOT_FOUND = ("E_READER_SELECTION_NOT_FOUND", 404)  # highlight/media absent
    E_READER_SELECTION_FORBIDDEN = ("E_READER_SELECTION_FORBIDDEN", 403)  # not viewer-readable
    E_READER_SELECTION_GEOMETRY_ONLY = ("E_READER_SELECTION_GEOMETRY_ONLY", 400)  # blank exact
    E_READER_SELECTION_TOO_LARGE = ("E_READER_SELECTION_TOO_LARGE", 400)  # bounded field over limit
    E_READER_SELECTION_STALE = ("E_READER_SELECTION_STALE", 409)  # revision precondition failed
    E_CONVERSATION_NO_LONGER_EMPTY = (
        "E_CONVERSATION_NO_LONGER_EMPTY",
        409,
    )  # Empty insertion raced

    # Consumption/Lectern errors
    E_MEDIA_DELETING = ("E_MEDIA_DELETING", 409)  # target media has a teardown intent
    E_STALE_LISTENING_REVISION = ("E_STALE_LISTENING_REVISION", 409)  # heartbeat CAS mismatch
    E_LIMIT = ("E_LIMIT", 409)  # Lectern aggregate row limit exceeded

    # Transport errors (the edge middleware)
    E_CLIENT_DISCONNECT = ("E_CLIENT_DISCONNECT", 499)
    E_WIRE_MISMATCH = ("E_WIRE_MISMATCH", 426)  # the client was built for another wire

    # EPUB errors
    E_RETRY_INVALID_STATE = ("E_RETRY_INVALID_STATE", 409)
    E_RETRY_NOT_ALLOWED = ("E_RETRY_NOT_ALLOWED", 409)
    E_REPAIR_NOT_ALLOWED = ("E_REPAIR_NOT_ALLOWED", 409)
    E_REGENERATION_NOT_ALLOWED = (
        "E_REGENERATION_NOT_ALLOWED",
        409,
    )  # completed answer not regeneratable
    E_ARCHIVE_UNSAFE = ("E_ARCHIVE_UNSAFE", 400)

    # Podcast provider errors
    E_BROWSE_PROVIDER_UNAVAILABLE = ("E_BROWSE_PROVIDER_UNAVAILABLE", 503)  # upstream unavailable
    E_BROWSE_PROVIDER_RATE_LIMITED = ("E_BROWSE_PROVIDER_RATE_LIMITED", 429)
    E_BROWSE_PROVIDER_QUOTA_EXHAUSTED = ("E_BROWSE_PROVIDER_QUOTA_EXHAUSTED", 429)
    E_PODCAST_PROVIDER_UNAVAILABLE = ("E_PODCAST_PROVIDER_UNAVAILABLE", 503)  # upstream unavailable
    E_PODCAST_FEED_UNAVAILABLE = ("E_PODCAST_FEED_UNAVAILABLE", 503)  # upstream unavailable
    E_PODCAST_HISTORY_CYCLE = ("E_PODCAST_HISTORY_CYCLE", 422)
    E_PODCAST_HISTORY_UNSAFE_NEXT_URL = ("E_PODCAST_HISTORY_UNSAFE_NEXT_URL", 422)
    E_PODCAST_ITEMS_SKIPPED = ("E_PODCAST_ITEMS_SKIPPED", 422)
    E_PODCAST_HISTORY_INCOMPLETE = ("E_PODCAST_HISTORY_INCOMPLETE", 422)
    E_PODCAST_SYNC_RETRY_EXHAUSTED = ("E_PODCAST_SYNC_RETRY_EXHAUSTED", 500)  # durable terminal
    E_X_PROVIDER_UNAVAILABLE = ("E_X_PROVIDER_UNAVAILABLE", 503)  # upstream unavailable
    E_X_PROVIDER_CREDITS_DEPLETED = ("E_X_PROVIDER_CREDITS_DEPLETED", 503)  # operator action
    E_X_PROVIDER_AUTH_REJECTED = ("E_X_PROVIDER_AUTH_REJECTED", 503)  # token/access unavailable
    E_X_PROVIDER_RATE_LIMITED = ("E_X_PROVIDER_RATE_LIMITED", 503)  # provider throttling
    E_X_PROVIDER_TIMEOUT = ("E_X_PROVIDER_TIMEOUT", 504)  # provider timeout
    E_X_POST_UNAVAILABLE = ("E_X_POST_UNAVAILABLE", 404)  # unavailable post
    E_X_ARTICLE_POST_LINK_REQUIRED = ("E_X_ARTICLE_POST_LINK_REQUIRED", 400)
    E_X_ARTICLE_BODY_UNAVAILABLE = ("E_X_ARTICLE_BODY_UNAVAILABLE", 422)
    E_X_ARTICLE_IDENTITY_CHANGED = ("E_X_ARTICLE_IDENTITY_CHANGED", 409)
    E_X_IDENTITY_CONFLICT = ("E_X_IDENTITY_CONFLICT", 409)
    E_X_SOURCE_CONFLICT = ("E_X_SOURCE_CONFLICT", 409)
    E_TRANSCRIPTION_FAILED = ("E_TRANSCRIPTION_FAILED", 502)  # provider returned error
    E_TRANSCRIPTION_TIMEOUT = ("E_TRANSCRIPTION_TIMEOUT", 504)  # provider timed out
    E_DIARIZATION_FAILED = ("E_DIARIZATION_FAILED", 502)  # diarized attempt failed (diagnostic)
    E_TRANSCRIPT_UNAVAILABLE = ("E_TRANSCRIPT_UNAVAILABLE", 409)  # transcript unavailable
    E_EPISODE_DOWNLOAD_CHANGED = ("E_EPISODE_DOWNLOAD_CHANGED", 409)

    # PDF errors
    E_PDF_PASSWORD_REQUIRED = ("E_PDF_PASSWORD_REQUIRED", 422)
    E_RESOURCE_LIMIT = ("E_RESOURCE_LIMIT", 422)

    # Link errors
    E_LINK_SELF = ("E_LINK_SELF", 422)  # Link source and target are the same resource
    E_LINK_CAPABILITY = ("E_LINK_CAPABILITY", 422)  # endpoint not admissible for a user Link
    E_LINK_TARGET_AMBIGUOUS = ("E_LINK_TARGET_AMBIGUOUS", 422)  # quote not unique within owner
    E_LINK_TARGET_STALE = ("E_LINK_TARGET_STALE", 409)  # passage candidate row no longer exists

    # Ingestion errors
    E_INGEST_FAILED = ("E_INGEST_FAILED", 502)
    E_INGEST_TIMEOUT = ("E_INGEST_TIMEOUT", 504)
    E_SOURCE_ACCESS_DENIED = ("E_SOURCE_ACCESS_DENIED", 422)
    E_SOURCE_NOT_READABLE = ("E_SOURCE_NOT_READABLE", 422)
    E_SOURCE_POSITION_UNMAPPABLE = ("E_SOURCE_POSITION_UNMAPPABLE", 409)
    # Route-neutral generation failures and admission refusals.
    E_GENERATION_AUTH = ("E_GENERATION_AUTH", 503)
    E_GENERATION_QUOTA = ("E_GENERATION_QUOTA", 429)
    E_GENERATION_TIMEOUT = ("E_GENERATION_TIMEOUT", 504)
    E_GENERATION_OUTPUT_LIMIT = ("E_GENERATION_OUTPUT_LIMIT", 502)
    E_GENERATION_INVALID_OUTPUT = ("E_GENERATION_INVALID_OUTPUT", 502)
    E_GENERATION_POLICY_VIOLATION = ("E_GENERATION_POLICY_VIOLATION", 502)
    E_GENERATION_RUNTIME_UNAVAILABLE = ("E_GENERATION_RUNTIME_UNAVAILABLE", 503)
    E_GENERATION_CONTEXT_TOO_LARGE = ("E_GENERATION_CONTEXT_TOO_LARGE", 422)
    E_GENERATION_CANCELLED = ("E_GENERATION_CANCELLED", 499)
    E_GENERATION_SOURCE_CHANGED = ("E_GENERATION_SOURCE_CHANGED", 409)
    E_GENERATION_SELECTION_UNAVAILABLE = ("E_GENERATION_SELECTION_UNAVAILABLE", 409)
    E_INVALID_GENERATION_SELECTION = ("E_INVALID_GENERATION_SELECTION", 422)

    # Image proxy errors
    E_SSRF_BLOCKED = ("E_SSRF_BLOCKED", 403)  # URL violates SSRF rules
    E_IMAGE_FETCH_FAILED = ("E_IMAGE_FETCH_FAILED", 502)  # Upstream fetch failed
    E_IMAGE_TOO_LARGE = ("E_IMAGE_TOO_LARGE", 413)  # Image exceeds size/dimension limits

    # Feed-controlled fetch errors — RSS feeds, chapters, transcript sidecars
    E_SOURCE_FETCH_FAILED = ("E_SOURCE_FETCH_FAILED", 502)  # feed-controlled fetch failed
    E_SOURCE_GONE = ("E_SOURCE_GONE", 502)  # the source answered 404/410: nothing is there
    E_SOURCE_TOO_LARGE = ("E_SOURCE_TOO_LARGE", 413)  # response exceeded streamed size cap

    # Server errors
    E_AUTH_UNAVAILABLE = ("E_AUTH_UNAVAILABLE", 503)
    E_INTERNAL = ("E_INTERNAL", 500)
    E_SIGN_UPLOAD_FAILED = ("E_SIGN_UPLOAD_FAILED", 500)
    E_SIGN_DOWNLOAD_FAILED = ("E_SIGN_DOWNLOAD_FAILED", 500)
    E_STORAGE_ERROR = ("E_STORAGE_ERROR", 500)
    E_SANITIZATION_FAILED = ("E_SANITIZATION_FAILED", 500)


class ApiError(Exception):
    """A modeled failure: its code (and so its status), a message and optional details."""

    def __init__(
        self, code: ApiErrorCode, message: str, *, details: dict[str, Any] | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.details = details
        self.status_code = code.status
        super().__init__(message)


class NotFoundError(ApiError):
    def __init__(self, code: ApiErrorCode = ApiErrorCode.E_NOT_FOUND, message: str = "Not found"):
        super().__init__(code, message)


class ForbiddenError(ApiError):
    def __init__(self, code: ApiErrorCode = ApiErrorCode.E_FORBIDDEN, message: str = "Forbidden"):
        super().__init__(code, message)


type ResourceFailureDimension = Literal["Memory", "Time", "Structure", "Output"]
"""Safe public dimension of an ``E_RESOURCE_LIMIT`` failure; raw parser text stays operator-only."""


class ResourceLimitError(ApiError):
    """A declared parser or runtime budget breach carrying its safe dimension.

    The job runtime's ``failure_of`` keeps the dimension, so the job goes dead as a
    resource failure; untyped exception attributes are never read.
    """

    def __init__(self, message: str, *, dimension: ResourceFailureDimension) -> None:
        super().__init__(ApiErrorCode.E_RESOURCE_LIMIT, message)
        self.dimension: ResourceFailureDimension = dimension


class ConflictError(ApiError):
    def __init__(
        self,
        code: ApiErrorCode = ApiErrorCode.E_INVITE_NOT_PENDING,
        message: str = "Conflict",
        *,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(code, message, details=details)


class InvalidRequestError(ApiError):
    def __init__(
        self, code: ApiErrorCode = ApiErrorCode.E_INVALID_REQUEST, message: str = "Invalid request"
    ):
        super().__init__(code, message)
