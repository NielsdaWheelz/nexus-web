"""YouTube videos: Data API metadata with the playable-media publication, and captions.

Add never fetches captions; they arrive only through the explicit Transcribe command.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from requests import Session as RequestsSession
from sqlalchemy.orm import Session, sessionmaker
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig

from nexus.config import get_settings
from nexus.db.models import Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.presence import Present, present
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.net.http_retry import get_json_with_retry
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.youtube_identity import YouTubeIdentity, placeholder_title

logger = get_logger(__name__)


def run_youtube_video_ingest(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    *,
    identity: YouTubeIdentity,
    publication_fence: SourcePublicationFence,
) -> SourceRunOutcome:
    """Read the video's snippet outside any transaction, then publish playable media once."""
    snippet = _snippet(identity.provider_video_id)

    def publish(db: Session, _attempt: object) -> taxonomy.ContributorObservationBatch:
        media = db.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media.provider, media.provider_id = identity.provider, identity.provider_video_id
        media.canonical_url = media.canonical_source_url = identity.watch_url
        media.external_playback_url = identity.watch_url
        media.updated_at = datetime.now(UTC)
        if snippet is None:
            return taxonomy.NOT_OBSERVED
        if snippet.get("title") and media.title == placeholder_title(identity.provider_video_id):
            media.title = snippet["title"][:255]
        if snippet.get("description") and not media.description:
            media.description = snippet["description"][:2000]
        if snippet.get("language") and not media.language:
            media.language = snippet["language"][:32]
        if snippet.get("channel_title") and not media.publisher:
            media.publisher = snippet["channel_title"][:255]
        edition = normalize_source_publication_date(snippet.get("published_at"))
        if isinstance(edition, Present):
            media.edition_published_date = edition.value
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        if not snippet.get("channel_title"):
            return taxonomy.NOT_OBSERVED
        channel_id = snippet.get("channel_id")
        batch, _truncated = taxonomy.build_observation(
            {
                "author": [
                    taxonomy.RawCreditEntry(
                        credited_name=snippet["channel_title"],
                        identity_claims=(
                            (taxonomy.RawIdentityClaim("youtube_channel", channel_id),)
                            if channel_id
                            else ()
                        ),
                    )
                ]
            }
        )
        return batch

    observation = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_youtube_playable_media",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish,
    )
    return SourceRunOutcome(
        diagnostics={"status": "success"},
        observations=source_contributor_observations(
            media_id=media_id, observation=observation, source="youtube_metadata"
        ),
        metadata_enrichment=present(snippet is not None),
    )


def _snippet(video_id: str) -> dict[str, str] | None:
    """The video's non-blank snippet fields; ``None`` when the API is unset or unhelpful.

    A video the API answers for with no item does not exist (or is private): that is
    the terminal ``E_SOURCE_GONE``, never a published dead link.
    """
    settings = get_settings()
    if not settings.youtube_data_api_key:
        return None
    try:
        payload = get_json_with_retry(
            f"{settings.youtube_data_base_url.rstrip('/')}/videos",
            headers={"Accept": "application/json"},
            params={
                "key": settings.youtube_data_api_key,
                "part": "snippet",
                "id": video_id,
                "maxResults": 1,
            },
            timeout_s=15.0,
            backoff_seconds=(),
            error_code=ApiErrorCode.E_INGEST_FAILED,
            provider_name="youtube_data",
        )
    except ApiError as exc:
        # Metadata is an optional enrichment: a provider failure never fails the ingest.
        logger.warning("youtube_metadata_fetch_failed", video_id=video_id, error=exc.message)
        return None
    items = payload.get("items")
    if items == []:
        raise ApiError(ApiErrorCode.E_SOURCE_GONE, "YouTube has no such public video.")
    snippet = (
        items[0].get("snippet") if isinstance(items, list) and isinstance(items[0], dict) else None
    )
    if not isinstance(snippet, dict):
        return None
    fields = {
        "title": snippet.get("title"),
        "description": snippet.get("description"),
        "channel_title": snippet.get("channelTitle"),
        "channel_id": snippet.get("channelId"),
        "published_at": snippet.get("publishedAt"),
        "language": snippet.get("defaultAudioLanguage") or snippet.get("defaultLanguage"),
    }
    metadata = {
        key: str(value).strip() for key, value in fields.items() if str(value or "").strip()
    }
    return metadata or None


# Provider exception classes that mean "this video has no captions", matched by name.
_ABSENT = frozenset(
    "TranscriptsDisabled NoTranscriptFound VideoUnavailable InvalidVideoId VideoUnplayable".split()
)
_UNAVAILABLE = {
    "status": "failed",
    "error_code": ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
    "error_message": "Transcript unavailable",
}


class _Proxy(GenericProxyConfig):
    """One operator proxy for both schemes, retried when YouTube blocks it."""

    def __init__(self, url: str, retries_when_blocked: int) -> None:
        super().__init__(http_url=url, https_url=url)
        self._retries = retries_when_blocked

    @property
    def prevent_keeping_connections_alive(self) -> bool:
        return self._retries > 0

    @property
    def retries_when_blocked(self) -> int:
        return self._retries


class _TimeoutSession(RequestsSession):
    """A requests session whose calls default to the configured timeout."""

    def request(self, *args: Any, **kwargs: Any) -> Any:
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = get_settings().youtube_transcript_timeout_seconds
        return super().request(*args, **kwargs)


def fetch_youtube_transcript(provider_video_id: str) -> dict[str, Any]:
    """One closed transcript result; unexpected provider faults raise."""
    video_id = str(provider_video_id or "").strip()
    if not video_id:
        return dict(_UNAVAILABLE)
    settings = get_settings()
    proxy_url = str(settings.youtube_transcript_proxy_url or "").strip()
    proxy = (
        _Proxy(proxy_url, int(settings.youtube_transcript_proxy_retries_when_blocked))
        if proxy_url
        else None
    )
    try:
        rows = list(
            YouTubeTranscriptApi(http_client=_TimeoutSession(), proxy_config=proxy).fetch(video_id)
        )
    # justify-ignore-error: the class name decides, so this boundary does not couple
    # to youtube_transcript_api's exception module layout.
    except Exception as exc:
        if type(exc).__name__ in _ABSENT:
            return dict(_UNAVAILABLE)
        logger.warning(
            "youtube_transcript_provider_error", video_id=video_id, error_class=type(exc).__name__
        )
        raise
    segments = [segment for row in rows if (segment := _segment(row)) is not None]
    if rows and not segments:
        raise RuntimeError("YouTube transcript provider returned malformed segments")
    if not segments:
        return dict(_UNAVAILABLE)
    return {"status": "completed", "segments": sorted(segments, key=lambda s: s["t_start_ms"])}


def _segment(row: Any) -> dict[str, Any] | None:
    try:
        start_ms = round(float(row.start) * 1000)
        end_ms = start_ms + round(float(row.duration) * 1000)
    except (AttributeError, TypeError, ValueError):
        return None
    if start_ms < 0 or end_ms <= start_ms:
        return None
    text = str(getattr(row, "text", None) or "")
    return {"t_start_ms": start_ms, "t_end_ms": end_ms, "text": text, "speaker_label": None}
