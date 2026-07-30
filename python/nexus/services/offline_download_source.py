"""Static podcast-enclosure policy for Android offline downloads."""

from urllib.parse import urlsplit

from nexus.db.models import MediaKind
from nexus.errors import ApiError, ApiErrorCode

OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH = 512
OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH = 8_192


def derive_offline_download_title(*, title: str) -> str:
    if not 1 <= len(title) <= OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH:
        raise ApiError(
            ApiErrorCode.E_OFFLINE_MEDIA_UNAVAILABLE,
            "Offline media is unavailable",
        )
    return title


def derive_offline_download_source(
    *,
    kind: str,
    external_playback_url: str | None,
) -> str:
    if (
        kind != MediaKind.podcast_episode.value
        or external_playback_url is None
        or not external_playback_url.strip()
    ):
        raise ApiError(
            ApiErrorCode.E_OFFLINE_MEDIA_UNAVAILABLE,
            "Offline media is unavailable",
        )

    if len(external_playback_url) > OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH:
        raise ApiError(
            ApiErrorCode.E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE,
            "Offline media source is unsupported",
        )

    try:
        parsed = urlsplit(external_playback_url)
        _ = parsed.port
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE,
            "Offline media source is unsupported",
        ) from exc

    if (
        external_playback_url != external_playback_url.strip()
        or parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or "#" in external_playback_url
    ):
        raise ApiError(
            ApiErrorCode.E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE,
            "Offline media source is unsupported",
        )
    return external_playback_url


def offline_download_eligible(
    *,
    kind: str,
    title: str,
    external_playback_url: str | None,
) -> bool:
    try:
        derive_offline_download_title(title=title)
        derive_offline_download_source(
            kind=kind,
            external_playback_url=external_playback_url,
        )
    except ApiError as error:
        if error.code in {
            ApiErrorCode.E_OFFLINE_MEDIA_UNAVAILABLE,
            ApiErrorCode.E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE,
        }:
            return False
        raise
    return True
