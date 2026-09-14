"""API error definitions.

All API errors are defined here with their corresponding HTTP status codes.
"""

from enum import Enum
from typing import Any, Literal

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
    E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED = "E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED"

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
    E_UPLOAD_SESSION_NOT_FOUND = "E_UPLOAD_SESSION_NOT_FOUND"
    E_IMPORT_NOT_FOUND = "E_IMPORT_NOT_FOUND"

    # Validation errors (400)
    E_INVALID_REQUEST = "E_INVALID_REQUEST"
    E_REQUEST_TOO_LARGE = "E_REQUEST_TOO_LARGE"  # 413 - body exceeds the qualified read profile
    E_NAME_INVALID = "E_NAME_INVALID"
    E_INVALID_KIND = "E_INVALID_KIND"
    E_INVALID_CONTENT_TYPE = "E_INVALID_CONTENT_TYPE"
    E_FILE_TOO_LARGE = "E_FILE_TOO_LARGE"
    E_CAPTURE_TOO_LARGE = "E_CAPTURE_TOO_LARGE"
    E_ACTIVITY_EXPIRED = "E_ACTIVITY_EXPIRED"
    E_INVALID_FILE_TYPE = "E_INVALID_FILE_TYPE"
    E_STORAGE_MISSING = "E_STORAGE_MISSING"
    E_SOURCE_INTEGRITY = "E_SOURCE_INTEGRITY"
    E_INVALID_CURSOR = "E_INVALID_CURSOR"
    E_INVALID_BROWSE_QUERY = "E_INVALID_BROWSE_QUERY"
    E_INVALID_DISCOVERY_TARGET = "E_INVALID_DISCOVERY_TARGET"
    E_STRIPE_WEBHOOK_INVALID = "E_STRIPE_WEBHOOK_INVALID"
    E_BRANCH_PATH_INVALID = "E_BRANCH_PATH_INVALID"
    E_BRANCH_ANCHOR_INVALID = "E_BRANCH_ANCHOR_INVALID"
    E_DOSSIER_INVALID_SUBJECT = "E_DOSSIER_INVALID_SUBJECT"
    E_DOSSIER_INVALID_INSTRUCTION = "E_DOSSIER_INVALID_INSTRUCTION"
    E_DOSSIER_IDEA_UNRESOLVED = "E_DOSSIER_IDEA_UNRESOLVED"
    E_EMPTY_NOTE_BODY = "E_EMPTY_NOTE_BODY"

    # Conflict errors (409)
    E_INVITE_ALREADY_EXISTS = "E_INVITE_ALREADY_EXISTS"
    E_INVITE_MEMBER_EXISTS = "E_INVITE_MEMBER_EXISTS"
    E_INVITE_NOT_PENDING = "E_INVITE_NOT_PENDING"
    E_OWNERSHIP_TRANSFER_INVALID = "E_OWNERSHIP_TRANSFER_INVALID"
    E_BRANCH_DELETE_ACTIVE_PATH = "E_BRANCH_DELETE_ACTIVE_PATH"
    E_BRANCH_HAS_ACTIVE_RUN = "E_BRANCH_HAS_ACTIVE_RUN"
    E_NOTE_CONFLICT = "E_NOTE_CONFLICT"
    E_RESOURCE_CONFLICT = "E_RESOURCE_CONFLICT"
    E_READER_STATE_CONFLICT = "E_READER_STATE_CONFLICT"
    E_READER_CONTENT_CHANGED = "E_READER_CONTENT_CHANGED"
    E_READER_PUBLICATION_BUSY = "E_READER_PUBLICATION_BUSY"
    E_ACTIVITY_CAPTURE_CONFLICT = "E_ACTIVITY_CAPTURE_CONFLICT"
    E_MEDIA_LAST_REFERENCE = "E_MEDIA_LAST_REFERENCE"
    E_DOSSIER_GENERATION_IN_PROGRESS = "E_DOSSIER_GENERATION_IN_PROGRESS"
    E_DOSSIER_BUILD_NOT_ACTIVE = "E_DOSSIER_BUILD_NOT_ACTIVE"
    E_DOSSIER_ALREADY_EXISTS = "E_DOSSIER_ALREADY_EXISTS"
    E_COLLECTION_CHANGED = "E_COLLECTION_CHANGED"
    E_SELECTION_CHANGED = "E_SELECTION_CHANGED"
    E_TOOL_PROJECTION_RELOAD_REQUIRED = "E_TOOL_PROJECTION_RELOAD_REQUIRED"
    E_PODCAST_REPLACES_EPISODES = "E_PODCAST_REPLACES_EPISODES"
    E_PODCAST_EPISODE_IDENTITY_CONFLICT = "E_PODCAST_EPISODE_IDENTITY_CONFLICT"
    E_PODCAST_SUBSCRIPTION_REQUIRED = "E_PODCAST_SUBSCRIPTION_REQUIRED"
    E_IDEMPOTENCY_CONFLICT = "E_IDEMPOTENCY_CONFLICT"
    E_UPLOAD_GENERATION_STALE = "E_UPLOAD_GENERATION_STALE"
    E_UPLOAD_ALREADY_PUBLISHED = "E_UPLOAD_ALREADY_PUBLISHED"
    E_UPLOAD_VERIFICATION_IN_PROGRESS = "E_UPLOAD_VERIFICATION_IN_PROGRESS"
    E_UPLOAD_INTENT_MISMATCH = "E_UPLOAD_INTENT_MISMATCH"

    # Highlight errors (400/409)
    E_HIGHLIGHT_INVALID_RANGE = "E_HIGHLIGHT_INVALID_RANGE"  # 400
    E_HIGHLIGHT_CONFLICT = "E_HIGHLIGHT_CONFLICT"  # 409
    E_MEDIA_NOT_READY = "E_MEDIA_NOT_READY"  # 409
    E_READER_APPARATUS_STATE_MISSING = "E_READER_APPARATUS_STATE_MISSING"  # 500

    # LLM errors
    E_APP_SEARCH_FAILED = "E_APP_SEARCH_FAILED"  # 500 - Required in-app retrieval failed
    E_MESSAGE_TOO_LONG = "E_MESSAGE_TOO_LONG"  # 400 - Message exceeds 20,000 char limit
    E_CONTEXT_TOO_LARGE = "E_CONTEXT_TOO_LARGE"  # 400 - Context exceeds 25,000 char limit
    E_MODEL_NOT_AVAILABLE = "E_MODEL_NOT_AVAILABLE"  # 400 - Model not available to user
    E_CONVERSATION_BUSY = "E_CONVERSATION_BUSY"  # 409 - Pending assistant already exists
    E_RATE_LIMITED = "E_RATE_LIMITED"  # 429 - Per-user rate limit exceeded
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

    # Offline media errors (409/422)
    E_OFFLINE_MEDIA_UNAVAILABLE = "E_OFFLINE_MEDIA_UNAVAILABLE"
    E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE = "E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE"

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
    E_REPAIR_NOT_ALLOWED = "E_REPAIR_NOT_ALLOWED"  # 409
    E_REGENERATION_NOT_ALLOWED = (
        "E_REGENERATION_NOT_ALLOWED"  # 409 - completed answer not regeneratable
    )
    E_ARCHIVE_UNSAFE = "E_ARCHIVE_UNSAFE"  # 400

    # Podcast provider errors
    E_BROWSE_PROVIDER_UNAVAILABLE = "E_BROWSE_PROVIDER_UNAVAILABLE"  # 503 upstream unavailable
    E_BROWSE_PROVIDER_RATE_LIMITED = "E_BROWSE_PROVIDER_RATE_LIMITED"
    E_BROWSE_PROVIDER_QUOTA_EXHAUSTED = "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED"
    E_PODCAST_PROVIDER_UNAVAILABLE = "E_PODCAST_PROVIDER_UNAVAILABLE"  # 503 upstream unavailable
    E_PODCAST_FEED_UNAVAILABLE = "E_PODCAST_FEED_UNAVAILABLE"  # 503 upstream unavailable
    E_PODCAST_SYNC_RETRY_EXHAUSTED = "E_PODCAST_SYNC_RETRY_EXHAUSTED"  # durable terminal
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
    E_RESOURCE_LIMIT = "E_RESOURCE_LIMIT"  # 422

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
    E_SOURCE_ACCESS_DENIED = "E_SOURCE_ACCESS_DENIED"  # 422
    E_SOURCE_NOT_READABLE = "E_SOURCE_NOT_READABLE"  # 422
    # Route-neutral generation failures and admission refusals.
    E_GENERATION_AUTH = "E_GENERATION_AUTH"  # 503
    E_GENERATION_QUOTA = "E_GENERATION_QUOTA"  # 429
    E_GENERATION_TIMEOUT = "E_GENERATION_TIMEOUT"  # 504
    E_GENERATION_OUTPUT_LIMIT = "E_GENERATION_OUTPUT_LIMIT"  # 502
    E_GENERATION_INVALID_OUTPUT = "E_GENERATION_INVALID_OUTPUT"  # 502
    E_GENERATION_POLICY_VIOLATION = "E_GENERATION_POLICY_VIOLATION"  # 502
    E_GENERATION_RUNTIME_UNAVAILABLE = "E_GENERATION_RUNTIME_UNAVAILABLE"  # 503
    E_GENERATION_CAPACITY_UNAVAILABLE = "E_GENERATION_CAPACITY_UNAVAILABLE"  # 503
    E_GENERATION_CONTEXT_TOO_LARGE = "E_GENERATION_CONTEXT_TOO_LARGE"  # 422
    E_GENERATION_CANCELLED = "E_GENERATION_CANCELLED"  # 499
    E_GENERATION_SOURCE_CHANGED = "E_GENERATION_SOURCE_CHANGED"  # 409
    E_GENERATION_UNCERTAIN = "E_GENERATION_UNCERTAIN"  # 409
    E_CATALOG_DEFINITION_STALE = "E_CATALOG_DEFINITION_STALE"  # 409
    E_GENERATION_SELECTION_UNAVAILABLE = "E_GENERATION_SELECTION_UNAVAILABLE"  # 409
    E_INVALID_GENERATION_SELECTION = "E_INVALID_GENERATION_SELECTION"  # 422

    # Image proxy errors (400/403/413/502/504)
    E_SSRF_BLOCKED = "E_SSRF_BLOCKED"  # 403 - URL violates SSRF rules
    E_IMAGE_FETCH_FAILED = "E_IMAGE_FETCH_FAILED"  # 502 - Upstream fetch failed
    E_IMAGE_TOO_LARGE = "E_IMAGE_TOO_LARGE"  # 413 - Image exceeds size/dimension limits

    # Feed-controlled fetch errors (413/502) — RSS feeds, chapters, transcript sidecars
    E_SOURCE_FETCH_FAILED = "E_SOURCE_FETCH_FAILED"  # 502 - feed-controlled fetch failed
    E_SOURCE_TOO_LARGE = "E_SOURCE_TOO_LARGE"  # 413 - response exceeded streamed size cap

    # Reader capacity errors (422)
    # 422 - retained content exceeds a qualified reader limit
    E_READER_CONTENT_TOO_LARGE = "E_READER_CONTENT_TOO_LARGE"

    # Server errors (500/503)
    E_AUTH_UNAVAILABLE = "E_AUTH_UNAVAILABLE"  # 503
    # 503 - foreground read admission exhausted (read_admission.py only)
    E_READ_CAPACITY = "E_READ_CAPACITY"
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
    ApiErrorCode.E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED: 503,
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
    ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND: 404,
    ApiErrorCode.E_IMPORT_NOT_FOUND: 404,
    # Validation errors
    ApiErrorCode.E_INVALID_REQUEST: 400,
    ApiErrorCode.E_REQUEST_TOO_LARGE: 413,
    ApiErrorCode.E_NAME_INVALID: 400,
    ApiErrorCode.E_INVALID_KIND: 400,
    ApiErrorCode.E_INVALID_CONTENT_TYPE: 400,
    ApiErrorCode.E_FILE_TOO_LARGE: 400,
    ApiErrorCode.E_CAPTURE_TOO_LARGE: 413,
    ApiErrorCode.E_ACTIVITY_EXPIRED: 400,
    ApiErrorCode.E_INVALID_FILE_TYPE: 400,
    ApiErrorCode.E_STORAGE_MISSING: 400,
    ApiErrorCode.E_SOURCE_INTEGRITY: 400,
    ApiErrorCode.E_INVALID_CURSOR: 400,
    ApiErrorCode.E_INVALID_BROWSE_QUERY: 400,
    ApiErrorCode.E_INVALID_DISCOVERY_TARGET: 400,
    ApiErrorCode.E_STRIPE_WEBHOOK_INVALID: 400,
    ApiErrorCode.E_BRANCH_PATH_INVALID: 400,
    ApiErrorCode.E_BRANCH_ANCHOR_INVALID: 400,
    ApiErrorCode.E_DOSSIER_INVALID_SUBJECT: 400,
    ApiErrorCode.E_DOSSIER_INVALID_INSTRUCTION: 400,
    ApiErrorCode.E_DOSSIER_IDEA_UNRESOLVED: 422,
    ApiErrorCode.E_EMPTY_NOTE_BODY: 400,
    # Conflict errors
    ApiErrorCode.E_INVITE_ALREADY_EXISTS: 409,
    ApiErrorCode.E_INVITE_MEMBER_EXISTS: 409,
    ApiErrorCode.E_INVITE_NOT_PENDING: 409,
    ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID: 409,
    ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH: 409,
    ApiErrorCode.E_BRANCH_HAS_ACTIVE_RUN: 409,
    ApiErrorCode.E_NOTE_CONFLICT: 409,
    ApiErrorCode.E_RESOURCE_CONFLICT: 409,
    ApiErrorCode.E_READER_STATE_CONFLICT: 409,
    ApiErrorCode.E_READER_CONTENT_CHANGED: 409,
    ApiErrorCode.E_READER_PUBLICATION_BUSY: 409,
    ApiErrorCode.E_ACTIVITY_CAPTURE_CONFLICT: 409,
    ApiErrorCode.E_MEDIA_LAST_REFERENCE: 409,
    ApiErrorCode.E_DOSSIER_GENERATION_IN_PROGRESS: 409,
    ApiErrorCode.E_DOSSIER_BUILD_NOT_ACTIVE: 409,
    ApiErrorCode.E_DOSSIER_ALREADY_EXISTS: 409,
    ApiErrorCode.E_COLLECTION_CHANGED: 409,
    ApiErrorCode.E_SELECTION_CHANGED: 409,
    ApiErrorCode.E_TOOL_PROJECTION_RELOAD_REQUIRED: 409,
    ApiErrorCode.E_PODCAST_REPLACES_EPISODES: 409,
    ApiErrorCode.E_PODCAST_EPISODE_IDENTITY_CONFLICT: 409,
    ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED: 409,
    ApiErrorCode.E_IDEMPOTENCY_CONFLICT: 409,
    ApiErrorCode.E_UPLOAD_GENERATION_STALE: 409,
    ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED: 409,
    ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS: 409,
    ApiErrorCode.E_UPLOAD_INTENT_MISMATCH: 409,
    # Highlight errors
    ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE: 400,
    ApiErrorCode.E_HIGHLIGHT_CONFLICT: 409,
    ApiErrorCode.E_MEDIA_NOT_READY: 409,
    ApiErrorCode.E_READER_APPARATUS_STATE_MISSING: 500,
    # LLM errors
    ApiErrorCode.E_APP_SEARCH_FAILED: 500,
    ApiErrorCode.E_MESSAGE_TOO_LONG: 400,
    ApiErrorCode.E_CONTEXT_TOO_LARGE: 400,
    ApiErrorCode.E_MODEL_NOT_AVAILABLE: 400,
    ApiErrorCode.E_CONVERSATION_BUSY: 409,
    ApiErrorCode.E_RATE_LIMITED: 429,
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
    # Offline media errors
    ApiErrorCode.E_OFFLINE_MEDIA_UNAVAILABLE: 409,
    ApiErrorCode.E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE: 422,
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
    ApiErrorCode.E_REPAIR_NOT_ALLOWED: 409,
    ApiErrorCode.E_REGENERATION_NOT_ALLOWED: 409,
    ApiErrorCode.E_ARCHIVE_UNSAFE: 400,
    # Podcast provider errors
    ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE: 503,
    ApiErrorCode.E_BROWSE_PROVIDER_RATE_LIMITED: 429,
    ApiErrorCode.E_BROWSE_PROVIDER_QUOTA_EXHAUSTED: 429,
    ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE: 503,
    ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE: 503,
    ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED: 500,
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
    ApiErrorCode.E_RESOURCE_LIMIT: 422,
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
    ApiErrorCode.E_SOURCE_ACCESS_DENIED: 422,
    ApiErrorCode.E_SOURCE_NOT_READABLE: 422,
    ApiErrorCode.E_GENERATION_AUTH: 503,
    ApiErrorCode.E_GENERATION_QUOTA: 429,
    ApiErrorCode.E_GENERATION_TIMEOUT: 504,
    ApiErrorCode.E_GENERATION_OUTPUT_LIMIT: 502,
    ApiErrorCode.E_GENERATION_INVALID_OUTPUT: 502,
    ApiErrorCode.E_GENERATION_POLICY_VIOLATION: 502,
    ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE: 503,
    ApiErrorCode.E_GENERATION_CAPACITY_UNAVAILABLE: 503,
    ApiErrorCode.E_GENERATION_CONTEXT_TOO_LARGE: 422,
    ApiErrorCode.E_GENERATION_CANCELLED: 499,
    ApiErrorCode.E_GENERATION_SOURCE_CHANGED: 409,
    ApiErrorCode.E_GENERATION_UNCERTAIN: 409,
    ApiErrorCode.E_CATALOG_DEFINITION_STALE: 409,
    ApiErrorCode.E_GENERATION_SELECTION_UNAVAILABLE: 409,
    ApiErrorCode.E_INVALID_GENERATION_SELECTION: 422,
    # Image proxy errors
    ApiErrorCode.E_SSRF_BLOCKED: 403,
    ApiErrorCode.E_IMAGE_FETCH_FAILED: 502,
    ApiErrorCode.E_IMAGE_TOO_LARGE: 413,
    ApiErrorCode.E_SOURCE_FETCH_FAILED: 502,
    ApiErrorCode.E_SOURCE_TOO_LARGE: 413,
    # Reader capacity errors
    ApiErrorCode.E_READER_CONTENT_TOO_LARGE: 422,
    # Server errors
    ApiErrorCode.E_AUTH_UNAVAILABLE: 503,
    ApiErrorCode.E_READ_CAPACITY: 503,
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


type ResourceFailureDimension = Literal["Memory", "Time", "Structure", "Output"]
"""Safe public dimension of an ``E_RESOURCE_LIMIT`` failure; raw parser text stays operator-only."""


class ResourceLimitError(ApiError):
    """A declared parser or runtime budget breach carrying its safe dimension.

    This is the single typed carrier the background child boundary projects into
    the ``ModeledFailure`` result; untyped exception attributes are never read.
    """

    def __init__(self, message: str, *, dimension: ResourceFailureDimension) -> None:
        super().__init__(ApiErrorCode.E_RESOURCE_LIMIT, message)
        self.dimension: ResourceFailureDimension = dimension


type ReaderCapacityDimension = Literal[
    "descriptor_bytes", "index_bytes", "unit_bytes", "unit_codepoints", "unit_dom_nodes"
]
"""Which field of the qualified ``ReaderPublicationLimits`` profile the content broke."""


class ReaderContentTooLargeError(ApiError):
    """Retained content that cannot be served inside the qualified reader profile.

    Deterministic and permanent for a ``(media_id, reader_generation)`` under the
    current profile, so it carries no ``Retry-After`` and the browser must not
    retry it. Distinct from ``E_READ_CAPACITY``, which the read admission owner
    alone raises when the foreground pool is momentarily full.

    ``measured`` is the size the content actually reached against ``limit``. A
    site that refuses content without producing one number — a split search that
    admits no unit at all — passes ``None`` and the key is omitted rather than
    reporting an invented figure.
    """

    def __init__(
        self,
        message: str,
        *,
        limit: ReaderCapacityDimension,
        limit_value: int,
        measured: int | None,
    ) -> None:
        details: dict[str, Any] = {"limit": limit, "limit_value": limit_value}
        if measured is not None:
            details["measured"] = measured
        super().__init__(ApiErrorCode.E_READER_CONTENT_TOO_LARGE, message, details=details)
        self.limit: ReaderCapacityDimension = limit
        self.limit_value = limit_value
        self.measured = measured


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
