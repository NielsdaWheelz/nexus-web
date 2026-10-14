"""The source-attempt vocabulary: types, statuses, the history stage, the stored artifact.

A leaf over the history schemas: the background supervisor's queue hooks and the
history seam read this vocabulary and must never import the ORM's heavy neighbours
(boto3, httpx, lxml). The types mirror ``ck_media_source_attempts_source_type``.
"""

from __future__ import annotations

from collections.abc import Mapping

from nexus.schemas.import_history import SourceFailureProgress, Stage

GENERIC_WEB_URL = "generic_web_url"
YOUTUBE_VIDEO = "youtube_video"
X_AUTHOR_THREAD = "x_author_thread"
X_POST = "x_post"
REMOTE_PDF_URL = "remote_pdf_url"
REMOTE_EPUB_URL = "remote_epub_url"
BROWSER_ARTICLE_CAPTURE = "browser_article_capture"
UPLOADED_PDF_FILE = "uploaded_pdf_file"
UPLOADED_EPUB_FILE = "uploaded_epub_file"
BROWSER_PDF_CAPTURE = "browser_pdf_capture"
BROWSER_EPUB_CAPTURE = "browser_epub_capture"
PODCAST_EPISODE_TRANSCRIPT = "podcast_episode_transcript"
EMAIL_MESSAGE = "email_message"

TRANSCRIPT_SOURCE_TYPES = frozenset({PODCAST_EPISODE_TRANSCRIPT, YOUTUBE_VIDEO})
REMOTE_FILE_SOURCE_TYPES = frozenset({REMOTE_PDF_URL, REMOTE_EPUB_URL})
LOCAL_FILE_SOURCE_TYPES = frozenset(
    {UPLOADED_PDF_FILE, UPLOADED_EPUB_FILE, BROWSER_PDF_CAPTURE, BROWSER_EPUB_CAPTURE}
)
STORED_SOURCE_TYPES = LOCAL_FILE_SOURCE_TYPES | {BROWSER_ARTICLE_CAPTURE, EMAIL_MESSAGE}
"""Sources whose bytes exist only as the stored artifact: nothing to re-fetch."""
EPUB_SOURCE_TYPES = frozenset({REMOTE_EPUB_URL, UPLOADED_EPUB_FILE, BROWSER_EPUB_CAPTURE})
COUNTED_PROGRESS_SOURCE_TYPES = LOCAL_FILE_SOURCE_TYPES | REMOTE_FILE_SOURCE_TYPES
"""Only the PDF/EPUB file adapters record Validate/Extract/Finalize progress."""

ACCEPTED, QUEUED, RUNNING = "accepted", "queued", "running"
SUCCEEDED, FAILED = "succeeded", "failed"
IN_FLIGHT = frozenset({ACCEPTED, QUEUED, RUNNING})

LATEST_ORDER_SQL = "attempt_no DESC, created_at DESC, id DESC"
"""The one order that names a media's authoritative (latest) attempt."""

_STAGES: dict[str, Stage] = {"Validate": "Validate", "Extract": "Extract", "Finalize": "Finalize"}


def source_history_stage(*, source_type: str, processing_stage: str | None) -> Stage:
    """The history stage one attempt is in; an uncounted source is one opaque step."""
    if source_type not in COUNTED_PROGRESS_SOURCE_TYPES:
        return "SourceProcessing"
    return _STAGES.get(processing_stage or "Validate", "Validate")


def source_failure_progress(
    *,
    processing_stage: str | None,
    progress_completed: int,
    progress_total: int | None,
    progress_unit: str | None,
) -> SourceFailureProgress | None:
    """The counted progress a failure happened at, present only during Extract."""
    if processing_stage != "Extract" or progress_total is None:
        return None
    return SourceFailureProgress(
        completed=progress_completed, total=progress_total, unit=progress_unit
    )


def stored_artifact_path(source_payload: Mapping[str, object] | None) -> str | None:
    """The storage object an attempt's payload owns: a capture packet or an email body.

    File sources keep their bytes in ``media_file``; url sources own nothing.
    """
    path = (source_payload or {}).get("storage_path")
    return path if isinstance(path, str) and path else None
