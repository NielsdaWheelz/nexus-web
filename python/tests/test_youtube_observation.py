"""Unit tests for the YouTube author observation builder.

Pure logic — no database or network. Confirms the channel title is the credited
name, ``snippet.channelId`` becomes the ``youtube_channel`` identity key, and an
absent channel title is ``not_observed``.
"""

from __future__ import annotations

import pytest

from nexus.services.contributor_taxonomy import NotObserved, ObservedRoleSlices
from nexus.services.youtube_video_ingest import _build_youtube_observation

pytestmark = pytest.mark.unit


class TestBuildYoutubeObservation:
    def test_channel_title_and_channel_id(self):
        batch = _build_youtube_observation("Nexus Channel", "UC1234567890abcdefghijkl")
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.managed_roles == frozenset({"author"})
        credit = batch.credits[0]
        assert credit.credited_name == "Nexus Channel"
        assert credit.role == "author"
        assert credit.identity_key is not None
        assert credit.identity_key.authority == "youtube_channel"
        assert credit.identity_key.key == "UC1234567890abcdefghijkl"

    def test_missing_channel_id_leaves_name_keyless(self):
        batch = _build_youtube_observation("Nexus Channel", None)
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.credits[0].identity_key is None

    def test_malformed_channel_id_is_omitted(self):
        # Not a UC-prefixed 24-char id -> not a valid youtube_channel key.
        batch = _build_youtube_observation("Nexus Channel", "not-a-channel")
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.credits[0].identity_key is None

    def test_absent_channel_title_is_not_observed(self):
        assert isinstance(_build_youtube_observation(None, "UC1234567890abcdefghijkl"), NotObserved)
        assert isinstance(_build_youtube_observation("", None), NotObserved)
