"""Fetch and parse RSS podcast transcript artifacts."""

from __future__ import annotations

import json
import re
from typing import Any

from nexus.errors import ApiError, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_TRANSCRIPT_TIMEOUT_SECONDS = 15.0
_MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024

_VTT_CONTENT_TYPES = {"text/vtt"}
_SRT_CONTENT_TYPES = {
    "application/x-subrip",
    "application/srt",
    "text/srt",
    "text/x-subrip",
}
_JSON_CONTENT_TYPES = {
    "application/json",
    "text/json",
}
_REJECTED_CONTENT_TYPES = {
    "text/html",
    "application/xhtml+xml",
}

_VTT_TIMING_RE = re.compile(r"^(?P<start>\S+)\s*-->\s*(?P<end>\S+)")
_VTT_SPEAKER_RE = re.compile(r"<v(?:\.[^>\s]+)?(?:\s+([^>]+))?>", re.IGNORECASE)
_VTT_SPEAKER_TAG_RE = re.compile(r"</?v(?:\.[^>\s]+)?(?:\s+[^>]*)?>", re.IGNORECASE)
_SRT_TIMING_RE = re.compile(r"^(?P<start>[^-\s]+)\s*-->\s*(?P<end>[^-\s]+)")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def fetch_rss_transcript(url: str, *, episode_duration_ms: int | None) -> list[dict[str, Any]]:
    """Fetch and parse one publisher transcript sidecar URL.

    Returns no segments when the sidecar is unavailable or unparseable.
    """
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return []

    source_type = _classify_source_type(url)
    if source_type is None:
        return []

    content, fetch_error = _fetch_transcript_text(url, source_type=source_type)
    if content is None:
        logger.warning(
            "rss_transcript_fetch_failed",
            transcript_url=url,
            source_type=source_type,
            error=fetch_error,
        )
        return []

    if source_type == "vtt":
        segments = parse_vtt_transcript(content)
    elif source_type == "srt":
        segments = parse_srt_transcript(content)
    elif source_type == "json":
        try:
            payload = json.loads(content)
        except ValueError as exc:
            logger.warning(
                "rss_transcript_parse_failed",
                transcript_url=url,
                source_type=source_type,
                error=str(exc),
            )
            return []
        segments = parse_json_transcript(payload)
    else:
        segments = parse_plain_text_transcript(content, episode_duration_ms=episode_duration_ms)

    if not segments:
        logger.warning(
            "rss_transcript_parse_failed",
            transcript_url=url,
            source_type=source_type,
            error="no_segments",
        )
        return []

    return segments


def _classify_source_type(url: str) -> str | None:
    lowered_url = url.strip().lower()
    if lowered_url.endswith(".vtt"):
        return "vtt"
    if lowered_url.endswith(".srt"):
        return "srt"
    if lowered_url.endswith(".json"):
        return "json"
    if lowered_url.endswith(".txt") or lowered_url.endswith(".text"):
        return "text"
    return None


def _fetch_transcript_text(url: str, *, source_type: str) -> tuple[str | None, str | None]:
    try:
        result = safe_get(
            url,
            max_bytes=_MAX_TRANSCRIPT_BYTES,
            timeout_s=_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except ApiError as exc:
        return None, f"fetch_rejected:{exc.code.value}"

    if not _is_allowed_content_type(result.content_type, source_type=source_type):
        return None, f"content_type_rejected:{result.content_type or 'unknown'}"

    if not result.text.strip():
        return None, "empty_body"
    return result.text, None


def _is_allowed_content_type(content_type: str | None, *, source_type: str) -> bool:
    if content_type is None:
        return True
    if content_type in {"application/octet-stream", "binary/octet-stream"}:
        return True
    if content_type in _REJECTED_CONTENT_TYPES:
        return False
    if source_type == "vtt":
        return content_type in _VTT_CONTENT_TYPES or content_type == "text/plain"
    if source_type == "srt":
        return content_type in _SRT_CONTENT_TYPES or content_type == "text/plain"
    if source_type == "json":
        return (
            content_type in _JSON_CONTENT_TYPES
            or content_type.endswith("+json")
            or content_type == "text/plain"
        )
    return content_type.startswith("text/") and content_type not in _REJECTED_CONTENT_TYPES


def parse_vtt_transcript(content: str) -> list[dict[str, Any]]:
    normalized = str(content or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if not normalized.strip():
        return []

    lines = normalized.split("\n")
    segments: list[dict[str, Any]] = []
    line_idx = 0
    while line_idx < len(lines):
        line = lines[line_idx].strip()
        if not line:
            line_idx += 1
            continue

        upper_line = line.upper()
        if upper_line == "WEBVTT":
            line_idx += 1
            continue
        if upper_line.startswith("NOTE"):
            line_idx += 1
            while line_idx < len(lines) and lines[line_idx].strip():
                line_idx += 1
            continue
        if upper_line in {"STYLE", "REGION"}:
            line_idx += 1
            while line_idx < len(lines) and lines[line_idx].strip():
                line_idx += 1
            continue

        timing_line = line
        if "-->" not in timing_line and line_idx + 1 < len(lines):
            next_line = lines[line_idx + 1].strip()
            if "-->" in next_line:
                line_idx += 1
                timing_line = next_line

        if "-->" not in timing_line:
            line_idx += 1
            continue

        t_start_ms, t_end_ms = _parse_vtt_timing_line(timing_line)
        line_idx += 1

        cue_lines: list[str] = []
        while line_idx < len(lines) and lines[line_idx].strip():
            cue_lines.append(lines[line_idx])
            line_idx += 1

        if t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms:
            continue
        text_value, speaker_label = _extract_vtt_text_and_speaker(cue_lines)
        if not text_value:
            continue
        segments.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": speaker_label,
            }
        )

    return segments


def _parse_vtt_timing_line(line: str) -> tuple[int | None, int | None]:
    match = _VTT_TIMING_RE.match(str(line or "").strip())
    if match is None:
        return None, None
    t_start_ms = _parse_timestamp_ms(match.group("start"))
    t_end_ms = _parse_timestamp_ms(match.group("end"))
    return t_start_ms, t_end_ms


def _extract_vtt_text_and_speaker(cue_lines: list[str]) -> tuple[str, str | None]:
    raw_text = "\n".join(cue_lines).strip()
    if not raw_text:
        return "", None

    speaker_label: str | None = None
    speaker_match = _VTT_SPEAKER_RE.search(raw_text)
    if speaker_match is not None:
        speaker_candidate = str(speaker_match.group(1) or "").strip()
        if speaker_candidate:
            speaker_label = speaker_candidate

    without_speaker_tags = _VTT_SPEAKER_TAG_RE.sub("", raw_text)
    text_value = _strip_html_and_collapse(without_speaker_tags)
    return text_value, speaker_label


def parse_srt_transcript(content: str) -> list[dict[str, Any]]:
    normalized = str(content or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if not normalized.strip():
        return []

    segments: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", normalized)
    for block in blocks:
        raw_lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not raw_lines:
            continue

        line_idx = 0
        if raw_lines[0].isdigit():
            line_idx = 1
        if line_idx >= len(raw_lines):
            continue

        t_start_ms, t_end_ms = _parse_srt_timing_line(raw_lines[line_idx])
        if t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms:
            continue

        text_lines = raw_lines[line_idx + 1 :]
        text_value = _strip_html_and_collapse(" ".join(text_lines))
        if not text_value:
            continue
        segments.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": None,
            }
        )
    return segments


def _parse_srt_timing_line(line: str) -> tuple[int | None, int | None]:
    match = _SRT_TIMING_RE.match(str(line or "").strip())
    if match is None:
        return None, None
    t_start_ms = _parse_timestamp_ms(match.group("start"))
    t_end_ms = _parse_timestamp_ms(match.group("end"))
    return t_start_ms, t_end_ms


def parse_json_transcript(payload: Any) -> list[dict[str, Any]]:
    entries: list[Any]
    if isinstance(payload, dict):
        raw_segments = payload.get("segments")
        entries = raw_segments if isinstance(raw_segments, list) else []
    elif isinstance(payload, list):
        entries = payload
    else:
        return []

    segments: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        text_value = _strip_html_and_collapse(entry.get("text") or entry.get("transcript"))
        if not text_value:
            continue
        t_start_ms = _coerce_json_time_to_ms(
            entry.get("startTime") or entry.get("start_time") or entry.get("start")
        )
        t_end_ms = _coerce_json_time_to_ms(
            entry.get("endTime") or entry.get("end_time") or entry.get("end")
        )
        if t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms:
            continue
        speaker_raw = (
            entry.get("speaker_label") or entry.get("speakerLabel") or entry.get("speaker")
        )
        speaker_label = str(speaker_raw).strip() if speaker_raw is not None else None
        if speaker_label == "":
            speaker_label = None
        segments.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": speaker_label,
            }
        )
    return segments


def parse_plain_text_transcript(
    content: str,
    *,
    episode_duration_ms: int | None = None,
) -> list[dict[str, Any]]:
    normalized = str(content or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    without_tags = _HTML_TAG_RE.sub(" ", normalized)
    lines = [
        _WHITESPACE_RE.sub(" ", line).strip()
        for line in without_tags.split("\n")
        if _WHITESPACE_RE.sub(" ", line).strip()
    ]
    if not lines:
        return []
    t_end_ms = int(episode_duration_ms) if isinstance(episode_duration_ms, int) else 0
    if t_end_ms < 0:
        t_end_ms = 0
    return [
        {
            "text": "\n".join(lines),
            "t_start_ms": 0,
            "t_end_ms": t_end_ms,
            "speaker_label": None,
        }
    ]


def _coerce_json_time_to_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value < 0:
            return None
        return int(round(float(raw_value) * 1000))

    value = str(raw_value).strip()
    if not value:
        return None
    if ":" in value:
        return _parse_timestamp_ms(value)
    try:
        as_seconds = float(value)
    except ValueError:
        return None
    if as_seconds < 0:
        return None
    return int(round(as_seconds * 1000))


def _parse_timestamp_ms(raw_value: Any) -> int | None:
    value = str(raw_value or "").strip()
    if not value:
        return None

    parts = value.split(":")
    if len(parts) not in {2, 3}:
        return None

    seconds_part = parts[-1].replace(",", ".")
    try:
        seconds_value = float(seconds_part)
    except ValueError:
        return None
    if seconds_value < 0 or seconds_value >= 60:
        return None

    try:
        minutes_value = int(parts[-2])
    except ValueError:
        return None
    if minutes_value < 0:
        return None

    hours_value = 0
    if len(parts) == 3:
        if minutes_value >= 60:
            return None
        try:
            hours_value = int(parts[0])
        except ValueError:
            return None
        if hours_value < 0:
            return None

    total_seconds = (hours_value * 3600) + (minutes_value * 60) + seconds_value
    return int(round(total_seconds * 1000))


def _strip_html_and_collapse(raw_value: Any) -> str:
    text_value = str(raw_value or "")
    text_value = _HTML_TAG_RE.sub(" ", text_value)
    text_value = _WHITESPACE_RE.sub(" ", text_value)
    return text_value.strip()
