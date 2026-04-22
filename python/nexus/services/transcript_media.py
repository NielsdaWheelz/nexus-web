"""Shared transcript-media policy helpers."""

from nexus.db.models import MediaKind, TranscriptState


def transcript_media_searchable_sql(
    media_alias: str = "m",
    transcript_state_alias: str = "mts",
) -> str:
    """Return the transcript-search predicate for canonical transcript state rows."""
    return (
        f"("
        f"{media_alias}.kind NOT IN ('{MediaKind.video.value}', '{MediaKind.podcast_episode.value}') "
        f"OR COALESCE({transcript_state_alias}.transcript_state, '') "
        f"!= '{TranscriptState.unavailable.value}'"
        f")"
    )
