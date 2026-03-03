"""Shared transcript-media policy helpers."""

from nexus.db.models import MediaKind, ProcessingStatus
from nexus.errors import ApiErrorCode


def is_transcript_media_searchable(
    *,
    kind: str,
    processing_status: str,
    last_error_code: str | None,
) -> bool:
    """Return True when media should be included in transcript-driven search surfaces."""
    is_transcript_kind = kind in {MediaKind.video.value, MediaKind.podcast_episode.value}
    is_transcript_unavailable = (
        processing_status == ProcessingStatus.failed.value
        and last_error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
    )
    return not (is_transcript_kind and is_transcript_unavailable)


def transcript_media_searchable_sql(alias: str = "m") -> str:
    """SQL predicate equivalent of `is_transcript_media_searchable`."""
    return (
        f"NOT ("
        f"{alias}.kind IN ('{MediaKind.video.value}', '{MediaKind.podcast_episode.value}') "
        f"AND {alias}.processing_status = '{ProcessingStatus.failed.value}' "
        f"AND {alias}.last_error_code = '{ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value}'"
        f")"
    )
