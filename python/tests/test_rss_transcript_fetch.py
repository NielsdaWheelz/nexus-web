"""Unit tests for RSS transcript fetch + format parsing boundary."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from nexus.services.rss_transcript_fetch import (
    _parse_json_transcript,
    _parse_plain_text_transcript,
    _parse_srt_transcript,
    _parse_vtt_transcript,
    fetch_rss_transcript,
)

pytestmark = pytest.mark.unit

_FIXTURE_DIR = Path(__file__).parent / "fixtures"


def _fixture_text(name: str) -> str:
    return (_FIXTURE_DIR / name).read_text(encoding="utf-8")


def _fixture_json(name: str) -> dict:
    return json.loads(_fixture_text(name))


class TestRssTranscriptParsing:
    def test_parse_vtt_handles_bom_note_style_multiline_and_speaker(self):
        vtt_content = "\ufeff" + _fixture_text("sample_transcript.vtt")

        segments = _parse_vtt_transcript(vtt_content)

        assert segments == [
            {
                "text": "Hello world",
                "t_start_ms": 0,
                "t_end_ms": 2500,
                "speaker_label": "Host",
            },
            {
                "text": "Plain cue line",
                "t_start_ms": 3000,
                "t_end_ms": 4000,
                "speaker_label": None,
            },
        ]

    def test_parse_vtt_skips_malformed_timing_lines_without_failing_entire_file(self):
        vtt_content = """WEBVTT

bad timing line --> nope
should be skipped

00:00:01.000 --> 00:00:02.500
valid cue
"""

        segments = _parse_vtt_transcript(vtt_content)

        assert segments == [
            {
                "text": "valid cue",
                "t_start_ms": 1000,
                "t_end_ms": 2500,
                "speaker_label": None,
            }
        ]

    def test_parse_srt_handles_multiline_text_strips_html_and_skips_malformed_entries(self):
        srt_content = _fixture_text("sample_transcript.srt") + """

3
broken timing
this entry must be ignored
"""

        segments = _parse_srt_transcript(srt_content)

        assert segments == [
            {
                "text": "Hello world",
                "t_start_ms": 0,
                "t_end_ms": 1500,
                "speaker_label": None,
            },
            {
                "text": "Second line continues",
                "t_start_ms": 2000,
                "t_end_ms": 3000,
                "speaker_label": None,
            },
        ]

    def test_parse_json_extracts_known_segment_shapes_and_returns_empty_for_unrecognized(self):
        fixture_payload = _fixture_json("sample_transcript.json")

        fixture_segments = _parse_json_transcript(fixture_payload)
        list_segments = _parse_json_transcript([{"text": "list shape", "start": 1, "end": 2}])
        unknown_segments = _parse_json_transcript({"foo": "bar"})

        assert fixture_segments == [
            {
                "text": "json one",
                "t_start_ms": 500,
                "t_end_ms": 1500,
                "speaker_label": None,
            },
            {
                "text": "json two",
                "t_start_ms": 2000,
                "t_end_ms": 3250,
                "speaker_label": None,
            },
        ]
        assert list_segments == [
            {
                "text": "list shape",
                "t_start_ms": 1000,
                "t_end_ms": 2000,
                "speaker_label": None,
            }
        ]
        assert unknown_segments == []

    def test_parse_plain_text_outputs_single_segment_with_duration_or_zero(self):
        plain_text = _fixture_text("sample_transcript.txt")

        known_duration = _parse_plain_text_transcript(plain_text, episode_duration_ms=120_000)
        unknown_duration = _parse_plain_text_transcript(plain_text, episode_duration_ms=None)

        assert known_duration == [
            {
                "text": "This is a plain text transcript.\nWith another line.",
                "t_start_ms": 0,
                "t_end_ms": 120_000,
                "speaker_label": None,
            }
        ]
        assert unknown_duration == [
            {
                "text": "This is a plain text transcript.\nWith another line.",
                "t_start_ms": 0,
                "t_end_ms": 0,
                "speaker_label": None,
            }
        ]


class TestRssTranscriptFetchBoundary:
    def test_fetch_prefers_format_then_language_and_falls_through_failures(self, monkeypatch):
        refs = [
            {
                "url": "https://cdn.example.com/transcripts/episode-es.vtt",
                "type": "text/vtt",
                "language": "es",
            },
            {
                "url": "https://cdn.example.com/transcripts/episode-en.vtt",
                "type": "text/vtt",
                "language": "en",
            },
            {
                "url": "https://cdn.example.com/transcripts/episode-fr.srt",
                "type": "application/x-subrip",
                "language": "fr",
            },
            {
                "url": "https://cdn.example.com/transcripts/episode-any.json",
                "type": "application/json",
                "language": None,
            },
        ]
        called_urls: list[str] = []

        def fake_http_get(url: str, **kwargs):  # noqa: ANN003
            _ = kwargs
            called_urls.append(url)
            if url.endswith("episode-es.vtt"):
                return httpx.Response(500, request=httpx.Request("GET", url))
            if url.endswith("episode-en.vtt"):
                return httpx.Response(404, request=httpx.Request("GET", url))
            if url.endswith("episode-fr.srt"):
                return httpx.Response(
                    200,
                    text=_fixture_text("sample_transcript.srt"),
                    headers={"Content-Type": "application/x-subrip"},
                    request=httpx.Request("GET", url),
                )
            raise AssertionError(f"unexpected transcript URL fetch: {url}")

        monkeypatch.setattr("nexus.services.rss_transcript_fetch.httpx.get", fake_http_get)

        result = fetch_rss_transcript(
            refs,
            episode_duration_ms=1_000,
            episode_language="es",
            feed_language="fr",
        )

        assert called_urls == [
            "https://cdn.example.com/transcripts/episode-es.vtt",
            "https://cdn.example.com/transcripts/episode-en.vtt",
            "https://cdn.example.com/transcripts/episode-fr.srt",
        ], f"unexpected RSS transcript fetch order: {called_urls}"
        assert result["status"] == "completed", (
            f"expected successful fallback to SRT after VTT failures, got {result}"
        )
        assert result["source_type"] == "srt", (
            f"expected source_type='srt' for SRT fallback success, got {result}"
        )
        assert len(result["segments"]) == 2

    def test_fetch_rejects_payloads_over_size_limit(self, monkeypatch):
        refs = [{"url": "https://cdn.example.com/transcripts/huge.vtt", "type": "text/vtt"}]

        def fake_http_get(url: str, **kwargs):  # noqa: ANN003
            _ = kwargs
            return httpx.Response(
                200,
                text="A" * 1024,
                headers={"Content-Type": "text/vtt"},
                request=httpx.Request("GET", url),
            )

        monkeypatch.setattr("nexus.services.rss_transcript_fetch.httpx.get", fake_http_get)
        monkeypatch.setattr("nexus.services.rss_transcript_fetch._MAX_TRANSCRIPT_BYTES", 128)

        result = fetch_rss_transcript(refs)

        assert result["status"] == "failed", (
            f"expected oversized RSS transcript payload to fail, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"expected oversized RSS transcript payload to map to E_TRANSCRIPT_UNAVAILABLE, got {result}"
        )
