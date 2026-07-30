from __future__ import annotations

import pytest

from nexus.services.podcasts.episode_identity import (
    EpisodeIdentityConflict,
    validate_episode_alias_batch,
)

pytestmark = pytest.mark.unit


def _episode(
    *, podcast_index_ref: str | None, guid: str | None, audio_url: str
) -> dict[str, object]:
    return {
        "podcast_index_episode_ref": podcast_index_ref,
        "guid": guid,
        "audio_url": audio_url,
    }


def test_batch_rejects_duplicate_podcast_index_ref_without_shared_guid() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref="episode-1",
                    guid="guid-1",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref="episode-1",
                    guid="guid-2",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )


def test_batch_rejects_duplicate_guid_without_podcast_index_proof() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref=None,
                    guid="same-guid",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref=None,
                    guid="same-guid",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )


def test_batch_rejects_duplicate_podcast_index_even_when_guid_matches() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref="episode-1",
                    guid="same-guid",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref="episode-1",
                    guid="same-guid",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )
