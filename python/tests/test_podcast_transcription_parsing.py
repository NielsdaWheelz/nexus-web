"""Unit tests for podcast transcription payload parsing and normalization."""

from __future__ import annotations

import pytest

from nexus.services.podcasts.transcripts import (
    _canonicalize_transcript_segment_text,
    _extract_deepgram_segments,
    _normalize_transcript_segments,
)

pytestmark = pytest.mark.unit


def test_extract_deepgram_segments_prefers_utterances_with_speaker_labels():
    payload = {
        "results": {
            "utterances": [
                {
                    "transcript": "hello there",
                    "start": 1.25,
                    "end": 2.5,
                    "speaker": 2,
                }
            ]
        }
    }

    segments = _extract_deepgram_segments(payload)

    assert segments == [
        {
            "text": "hello there",
            "t_start_ms": 1250,
            "t_end_ms": 2500,
            "speaker_label": "2",
        }
    ]


def test_extract_deepgram_segments_falls_back_to_channel_transcript_duration():
    payload = {
        "metadata": {"duration": 8.4},
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "fallback channel transcript",
                        }
                    ]
                }
            ]
        },
    }

    segments = _extract_deepgram_segments(payload)

    assert segments == [
        {
            "text": "fallback channel transcript",
            "t_start_ms": 0,
            "t_end_ms": 8400,
            "speaker_label": None,
        }
    ]


def test_extract_deepgram_segments_uses_word_timing_when_metadata_duration_missing():
    payload = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "words timing fallback",
                            "words": [
                                {"word": "words", "start": 0.0, "end": 0.4},
                                {"word": "timing", "start": 0.41, "end": 0.8},
                                {"word": "fallback", "start": 0.81, "end": 1.2},
                            ],
                        }
                    ]
                }
            ]
        },
    }

    segments = _extract_deepgram_segments(payload)

    assert segments == [
        {
            "text": "words timing fallback",
            "t_start_ms": 0,
            "t_end_ms": 1200,
            "speaker_label": None,
        }
    ]


def test_normalize_transcript_segments_enforces_canonicalization_and_strict_timing():
    raw_segments = [
        {
            "text": "Cafe\u0301\u00a0   story",
            "t_start_ms": 100,
            "t_end_ms": 300,
            "speaker_label": " Host ",
        },
        {"text": "invalid zero", "t_start_ms": 400, "t_end_ms": 400, "speaker_label": None},
        {"text": "invalid backwards", "t_start_ms": 600, "t_end_ms": 550, "speaker_label": None},
        {"text": " later  segment ", "t_start_ms": 500, "t_end_ms": 800, "speaker_label": ""},
    ]

    normalized = _normalize_transcript_segments(raw_segments)

    assert normalized == [
        {"text": "Café story", "t_start_ms": 100, "t_end_ms": 300, "speaker_label": "Host"},
        {"text": "later segment", "t_start_ms": 500, "t_end_ms": 800, "speaker_label": None},
    ]


def test_canonicalize_transcript_segment_text_handles_empty_and_whitespace_only():
    assert _canonicalize_transcript_segment_text(None) == ""
    assert _canonicalize_transcript_segment_text(" \t\n\u00a0 ") == ""
