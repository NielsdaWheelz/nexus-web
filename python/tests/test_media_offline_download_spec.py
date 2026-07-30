"""Integration coverage for the Android offline-download specification read."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from nexus.db.models import Media, MediaKind, Podcast, PodcastEpisode, ProcessingStatus
from nexus.services.offline_download_source import (
    OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH,
    OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH,
)
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_default_library(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"expected /me bootstrap to succeed, got {response.status_code}: {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


def _seed_media(
    direct_db: DirectSessionManager,
    *,
    library_id: UUID,
    kind: MediaKind = MediaKind.podcast_episode,
    title: str = "Offline Episode",
    canonical_source_url: str = "https://example.com/episode-page",
    external_playback_url: str | None = "https://media.example.com/audio/episode.mp3",
    podcast_id: UUID | None = None,
) -> UUID:
    media_id = uuid4()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=kind.value,
                title=title,
                canonical_source_url=canonical_source_url,
                external_playback_url=external_playback_url,
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        if podcast_id is not None:
            session.add(
                PodcastEpisode(
                    media_id=media_id,
                    podcast_id=podcast_id,
                    published_at=datetime.now(UTC),
                    duration_seconds=600,
                )
            )
        session.flush()
        add_media_to_library(session, library_id, media_id)
        session.commit()
    return media_id


def _seed_podcast(direct_db: DirectSessionManager) -> UUID:
    podcast_id = uuid4()
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"offline-{podcast_id}",
                title="Offline Show",
                feed_url=f"https://feeds.example.com/{podcast_id}.xml",
            )
        )
        session.commit()
    return podcast_id


def test_offline_download_spec_returns_exact_stable_enclosure_contract(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    library_id = _bootstrap_default_library(auth_client, user_id)
    podcast_id = _seed_podcast(direct_db)
    source_url = "https://redirector.example.com/enclosures/episode.m4a?source=rss"
    media_id = _seed_media(
        direct_db,
        library_id=library_id,
        podcast_id=podcast_id,
        title="A Stable Episode",
        canonical_source_url="https://publisher.example.com/episodes/stable",
        external_playback_url=source_url,
    )

    response = auth_client.get(
        f"/media/{media_id}/offline-download-spec",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, (
        f"expected eligible episode spec, got {response.status_code}: {response.text}"
    )
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == {
        "data": {
            "kind": "ProgressiveAudio",
            "mediaId": str(media_id),
            "title": "A Stable Episode",
            "sourceUrl": source_url,
        }
    }


def test_offline_download_spec_masks_missing_and_invisible_media(
    auth_client,
    direct_db: DirectSessionManager,
):
    viewer_id = create_test_user_id()
    owner_id = create_test_user_id()
    _bootstrap_default_library(auth_client, viewer_id)
    owner_library_id = _bootstrap_default_library(auth_client, owner_id)
    podcast_id = _seed_podcast(direct_db)
    invisible_media_id = _seed_media(
        direct_db,
        library_id=owner_library_id,
        podcast_id=podcast_id,
    )

    for media_id in (uuid4(), invisible_media_id):
        response = auth_client.get(
            f"/media/{media_id}/offline-download-spec",
            headers=auth_headers(viewer_id),
        )
        assert response.status_code == 404, (
            f"expected missing/invisible media to be masked, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
        assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(
    ("kind", "external_playback_url"),
    [
        (MediaKind.web_article, "https://media.example.com/article.mp3"),
        (MediaKind.podcast_episode, None),
        (MediaKind.podcast_episode, "   "),
    ],
)
def test_offline_download_spec_rejects_unavailable_media_without_canonical_fallback(
    auth_client,
    direct_db: DirectSessionManager,
    kind: MediaKind,
    external_playback_url: str | None,
):
    user_id = create_test_user_id()
    library_id = _bootstrap_default_library(auth_client, user_id)
    podcast_id = _seed_podcast(direct_db) if kind is MediaKind.podcast_episode else None
    media_id = _seed_media(
        direct_db,
        library_id=library_id,
        kind=kind,
        podcast_id=podcast_id,
        canonical_source_url="https://media.example.com/must-not-be-used.mp3",
        external_playback_url=external_playback_url,
    )

    response = auth_client.get(
        f"/media/{media_id}/offline-download-spec",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 409, (
        f"expected unavailable offline source, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_OFFLINE_MEDIA_UNAVAILABLE"


@pytest.mark.parametrize(
    "source_url",
    [
        "http://media.example.com/episode.mp3",
        "https://user:secret@media.example.com/episode.mp3",
        "https://media.example.com/episode.mp3#chapter",
        "https:///episode.mp3",
    ],
)
def test_offline_download_spec_rejects_unsupported_static_sources(
    auth_client,
    direct_db: DirectSessionManager,
    source_url: str,
):
    user_id = create_test_user_id()
    library_id = _bootstrap_default_library(auth_client, user_id)
    podcast_id = _seed_podcast(direct_db)
    media_id = _seed_media(
        direct_db,
        library_id=library_id,
        podcast_id=podcast_id,
        external_playback_url=source_url,
    )

    response = auth_client.get(
        f"/media/{media_id}/offline-download-spec",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 422, (
        f"expected unsupported offline source, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE"


def test_podcast_episode_rows_project_static_offline_eligibility_without_source_url(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    library_id = _bootstrap_default_library(auth_client, user_id)
    podcast_id = _seed_podcast(direct_db)
    eligible_id = _seed_media(
        direct_db,
        library_id=library_id,
        podcast_id=podcast_id,
        title="Eligible",
        external_playback_url="https://media.example.com/eligible.mp3",
    )
    missing_id = _seed_media(
        direct_db,
        library_id=library_id,
        podcast_id=podcast_id,
        title="Missing",
        external_playback_url=None,
    )
    unsupported_id = _seed_media(
        direct_db,
        library_id=library_id,
        podcast_id=podcast_id,
        title="Unsupported",
        external_playback_url="https://media.example.com/unsupported.mp3#fragment",
    )

    response = auth_client.get(
        f"/podcasts/{podcast_id}/episodes?limit=10",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, (
        f"expected compact episode projection, got {response.status_code}: {response.text}"
    )
    rows = {row["id"]: row for row in response.json()["data"]["items"]}
    assert rows[str(eligible_id)]["offline_download_eligible"] is True
    assert rows[str(missing_id)]["offline_download_eligible"] is False
    assert rows[str(unsupported_id)]["offline_download_eligible"] is False
    for row in rows.values():
        assert "sourceUrl" not in row
        assert "external_playback_url" not in row


def test_offline_download_wire_bounds_align_endpoint_and_compact_eligibility(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    library_id = _bootstrap_default_library(auth_client, user_id)
    podcast_id = _seed_podcast(direct_db)
    source_prefix = "https://media.example.com/"
    source_at_limit = source_prefix + "a" * (
        OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH - len(source_prefix)
    )
    source_over_limit = f"{source_at_limit}a"
    cases = [
        (
            "title_at_limit",
            "t" * OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH,
            "https://media.example.com/title-limit.mp3",
            200,
            None,
            True,
        ),
        (
            "title_over_limit",
            "t" * (OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH + 1),
            "https://media.example.com/title-over-limit.mp3",
            409,
            "E_OFFLINE_MEDIA_UNAVAILABLE",
            False,
        ),
        (
            "source_at_limit",
            "Source at limit",
            source_at_limit,
            200,
            None,
            True,
        ),
        (
            "source_over_limit",
            "Source over limit",
            source_over_limit,
            422,
            "E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE",
            False,
        ),
    ]
    media_ids: dict[str, UUID] = {}
    for name, title, source_url, _status, _code, _eligible in cases:
        media_ids[name] = _seed_media(
            direct_db,
            library_id=library_id,
            podcast_id=podcast_id,
            title=title,
            external_playback_url=source_url,
        )

    for name, title, source_url, expected_status, expected_code, _eligible in cases:
        response = auth_client.get(
            f"/media/{media_ids[name]}/offline-download-spec",
            headers=auth_headers(user_id),
        )
        assert response.status_code == expected_status, (
            f"expected {name} to return {expected_status}, got "
            f"{response.status_code}: {response.text}"
        )
        if expected_code is None:
            assert response.json()["data"] == {
                "kind": "ProgressiveAudio",
                "mediaId": str(media_ids[name]),
                "title": title,
                "sourceUrl": source_url,
            }
        else:
            assert response.json()["error"]["code"] == expected_code

    response = auth_client.get(
        f"/podcasts/{podcast_id}/episodes?limit=10",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["data"]["items"]}
    for name, _title, _source_url, _status, _code, expected_eligible in cases:
        assert rows[str(media_ids[name])]["offline_download_eligible"] is expected_eligible
