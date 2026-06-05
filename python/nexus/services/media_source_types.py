"""Durable media source-attempt type contract."""

from __future__ import annotations

GENERIC_WEB_URL = "generic_web_url"
YOUTUBE_VIDEO = "youtube_video"
VIDEO_TRANSCRIPT = "video_transcript"
X_AUTHOR_THREAD = "x_author_thread"
REMOTE_PDF_URL = "remote_pdf_url"
REMOTE_EPUB_URL = "remote_epub_url"
BROWSER_ARTICLE_CAPTURE = "browser_article_capture"
UPLOADED_PDF_FILE = "uploaded_pdf_file"
UPLOADED_EPUB_FILE = "uploaded_epub_file"
BROWSER_PDF_CAPTURE = "browser_pdf_capture"
BROWSER_EPUB_CAPTURE = "browser_epub_capture"
PODCAST_EPISODE_TRANSCRIPT = "podcast_episode_transcript"

TRANSCRIPT_SOURCE_TYPES = frozenset(
    {
        PODCAST_EPISODE_TRANSCRIPT,
        YOUTUBE_VIDEO,
        VIDEO_TRANSCRIPT,
    }
)
REMOTE_FILE_SOURCE_TYPES = frozenset({REMOTE_PDF_URL, REMOTE_EPUB_URL})
LOCAL_FILE_SOURCE_TYPES = frozenset(
    {
        UPLOADED_PDF_FILE,
        UPLOADED_EPUB_FILE,
        BROWSER_PDF_CAPTURE,
        BROWSER_EPUB_CAPTURE,
    }
)
WEB_ARTICLE_ARTIFACT_SOURCE_TYPES = frozenset(
    {
        GENERIC_WEB_URL,
        BROWSER_ARTICLE_CAPTURE,
        X_AUTHOR_THREAD,
    }
)
NON_REACQUIRABLE_FILE_SOURCE_TYPES = frozenset(
    {
        UPLOADED_PDF_FILE,
        UPLOADED_EPUB_FILE,
        BROWSER_ARTICLE_CAPTURE,
        BROWSER_PDF_CAPTURE,
        BROWSER_EPUB_CAPTURE,
    }
)
