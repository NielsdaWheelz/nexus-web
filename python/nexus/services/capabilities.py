"""Capabilities derivation for media items.

Capabilities determine what actions a viewer can perform on a media item.
They are derived from:
- media.kind
- processing_status
- last_error_code
- media_file existence (for can_download_file)
- external_playback_url existence (for can_play)

Precondition: Caller has already verified can_read_media(viewer, media).
If that check failed, endpoint returned 404 and never calls this function.
"""

from nexus.db.models import MediaKind, ProcessingStatus
from nexus.schemas.media import CapabilitiesOut


def derive_capabilities(
    kind: str,
    processing_status: str,
    last_error_code: str | None,
    *,
    media_file_exists: bool,
    external_playback_url_exists: bool,
    has_fragments: bool = False,
    has_plain_text: bool = False,
) -> CapabilitiesOut:
    """Derive capabilities from media state.

    This is a pure function - no database access.

    Args:
        kind: Media kind (web_article, pdf, epub, video, podcast_episode).
        processing_status: Current processing status.
        last_error_code: Error code if failed, None otherwise.
        media_file_exists: True if MediaFile row exists for this media.
        external_playback_url_exists: True if external_playback_url is set.
        has_fragments: True if media has at least one fragment.
        has_plain_text: True if media.plain_text is set (for PDF quote-to-chat).

    Returns:
        CapabilitiesOut with derived boolean flags.

    Notes:
        - can_download_file: True iff media_file exists (authorization already passed)
        - can_play: True iff external_playback_url exists and (status >= ready_for_reading
          OR failed + E_TRANSCRIPT_UNAVAILABLE)
        - PDF is special: can_read = media_file_exists (pdf.js can render before extraction)
        - Other document types require ready_for_reading status (fragments exist)
        - Transcript media (video, podcast_episode) require fragments (transcript segments)
    """
    # Normalize inputs
    is_pdf = kind == MediaKind.pdf.value
    is_epub = kind == MediaKind.epub.value
    is_web_article = kind == MediaKind.web_article.value
    is_document = is_pdf or is_epub or is_web_article
    is_transcript_media = kind in (MediaKind.video.value, MediaKind.podcast_episode.value)

    # Status checks
    status_ready_for_reading = processing_status in (
        ProcessingStatus.ready_for_reading.value,
        ProcessingStatus.embedding.value,
        ProcessingStatus.ready.value,
    )
    is_failed = processing_status == ProcessingStatus.failed.value
    is_transcript_unavailable = is_failed and last_error_code == "E_TRANSCRIPT_UNAVAILABLE"

    # =========================================================================
    # can_download_file: True iff media_file exists (for PDF/EPUB)
    # =========================================================================
    can_download_file = media_file_exists

    # =========================================================================
    # can_play: True iff external_playback_url exists and conditions met
    # For transcript media: allowed even if transcript failed
    # =========================================================================
    if external_playback_url_exists:
        can_play = status_ready_for_reading or is_transcript_unavailable
    else:
        can_play = False

    # =========================================================================
    # can_read: Depends on media kind
    # =========================================================================
    if is_pdf:
        # PDF special case: can_read if file exists (pdf.js renders directly)
        can_read = media_file_exists
    elif is_document:
        # Other documents: require ready_for_reading (fragments exist)
        can_read = status_ready_for_reading
    elif is_transcript_media:
        # Transcript media: require fragments (transcript segments)
        # But NOT if transcript is unavailable
        if is_transcript_unavailable:
            can_read = False
        else:
            can_read = status_ready_for_reading
    else:
        # Unknown kind: default to status check
        can_read = status_ready_for_reading

    # =========================================================================
    # can_highlight: Same as can_read for most types
    # Special case: failed + transcript unavailable disables highlights
    # =========================================================================
    if is_transcript_unavailable:
        can_highlight = False
    else:
        can_highlight = can_read

    # =========================================================================
    # can_quote: Depends on kind
    # - PDF: requires plain_text (extracted text)
    # - Others: same as can_read
    # =========================================================================
    if is_pdf:
        # PDF can_quote requires text extraction complete
        can_quote = can_read and has_plain_text
    elif is_transcript_unavailable:
        can_quote = False
    else:
        can_quote = can_read

    # =========================================================================
    # can_search: Same as can_quote (searchable requires text)
    # =========================================================================
    can_search = can_quote

    return CapabilitiesOut(
        can_read=can_read,
        can_highlight=can_highlight,
        can_quote=can_quote,
        can_search=can_search,
        can_play=can_play,
        can_download_file=can_download_file,
    )
