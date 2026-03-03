"""Fixture-backed YouTube transcript feasibility checks."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from nexus.errors import ApiErrorCode

pytestmark = pytest.mark.unit

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "youtube_transcript_probe_samples.json"


def _load_probe_samples() -> list[dict[str, Any]]:
    return json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


class TestYoutubeTranscriptFeasibility:
    def test_probe_fixture_is_structurally_valid_and_reproducible(self):
        samples = _load_probe_samples()

        assert len(samples) >= 8
        sample_ids = [str(sample["sample_id"]) for sample in samples]
        assert len(sample_ids) == len(set(sample_ids))
        assert all(sample.get("playback_available") is True for sample in samples)

    def test_probe_fixture_preserves_playback_only_fallback_contract(self):
        samples = _load_probe_samples()

        total = len(samples)
        completed = [
            sample for sample in samples if sample["transcript_fetch_status"] == "completed"
        ]
        failed = [sample for sample in samples if sample["transcript_fetch_status"] == "failed"]
        error_counts = Counter(str(sample["error_code"]) for sample in failed)

        success_rate = round(len(completed) / total, 3)
        transcript_unavailable_rate = round(
            error_counts[ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value] / total, 3
        )

        # Dated probe expectations captured in docs/v1/s8/feasibility.
        assert success_rate == 0.5
        assert transcript_unavailable_rate == 0.375
        assert error_counts[ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value] == 1

        for sample in failed:
            assert sample["playback_available"] is True
            if sample["error_code"] == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
                assert sample["expected_playback_only"] is True
