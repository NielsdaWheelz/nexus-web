"""Fetch and parse one publisher transcript sidecar."""

from __future__ import annotations

import json
import re
from typing import Any

from nexus.errors import ApiError, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_TIMEOUT_SECONDS = 15.0
_MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024
_ALLOWED_CONTENT_TYPES = {
    "vtt": {"text/vtt", "text/plain"},
    "srt": {"application/x-subrip", "application/srt", "text/srt", "text/x-subrip", "text/plain"},
    "json": {"application/json", "text/json", "text/plain"},
}
_REJECTED_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
_OPAQUE_CONTENT_TYPES = {"application/octet-stream", "binary/octet-stream"}
_SOURCE_TYPE_BY_SUFFIX = {
    ".vtt": "vtt",
    ".srt": "srt",
    ".json": "json",
    ".txt": "text",
    ".text": "text",
}
_VTT_TIMING = re.compile(r"^(?P<start>\S+)\s*-->\s*(?P<end>\S+)")
_VTT_SPEAKER = re.compile(r"<v(?:\.[^>\s]+)?(?:\s+([^>]+))?>", re.IGNORECASE)
_VTT_SPEAKER_TAG = re.compile(r"</?v(?:\.[^>\s]+)?(?:\s+[^>]*)?>", re.IGNORECASE)
_SRT_TIMING = re.compile(r"^(?P<start>[^-\s]+)\s*-->\s*(?P<end>[^-\s]+)")
_HTML_TAG = re.compile(r"<[^>]+>")
_WHITESPACE = re.compile(r"\s+")


def fetch_rss_transcript(url: str, *, episode_duration_ms: int | None) -> list[dict[str, Any]]:
    """Return the sidecar's segments, or none when it is unusable."""
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return []
    source_type = next(
        (
            value
            for suffix, value in _SOURCE_TYPE_BY_SUFFIX.items()
            if url.strip().lower().endswith(suffix)
        ),
        None,
    )
    if source_type is None:
        return []

    try:
        result = safe_get(url, max_bytes=_MAX_TRANSCRIPT_BYTES, timeout_s=_TIMEOUT_SECONDS)
    except ApiError as exc:
        logger.warning("rss_transcript_fetch_failed", transcript_url=url, error=exc.message)
        return []
    if not _content_type_allowed(result.content_type, source_type=source_type):
        logger.warning(
            "rss_transcript_fetch_failed",
            transcript_url=url,
            error=f"content_type_rejected:{result.content_type or 'unknown'}",
        )
        return []

    content = result.text
    if not content.strip():
        segments: list[dict[str, Any]] = []
    elif source_type == "vtt":
        segments = parse_vtt_transcript(content)
    elif source_type == "srt":
        segments = parse_srt_transcript(content)
    elif source_type == "json":
        try:
            segments = parse_json_transcript(json.loads(content))
        except ValueError:
            segments = []
    else:
        segments = parse_plain_text_transcript(content, episode_duration_ms=episode_duration_ms)

    if not segments:
        logger.warning("rss_transcript_parse_failed", transcript_url=url, source_type=source_type)
    return segments


def _content_type_allowed(content_type: str | None, *, source_type: str) -> bool:
    if content_type is None or content_type in _OPAQUE_CONTENT_TYPES:
        return True
    if content_type in _REJECTED_CONTENT_TYPES:
        return False
    if source_type == "json" and content_type.endswith("+json"):
        return True
    if source_type == "text":
        return content_type.startswith("text/")
    return content_type in _ALLOWED_CONTENT_TYPES[source_type]


def parse_vtt_transcript(content: str) -> list[dict[str, Any]]:
    lines = _normalize_newlines(content).split("\n")
    segments: list[dict[str, Any]] = []
    line_idx = 0
    while line_idx < len(lines):
        line = lines[line_idx].strip()
        line_idx += 1
        if not line:
            continue
        if line.upper() == "WEBVTT":
            continue
        if line.upper().startswith("NOTE") or line.upper() in {"STYLE", "REGION"}:
            while line_idx < len(lines) and lines[line_idx].strip():
                line_idx += 1
            continue
        if "-->" not in line:
            if line_idx >= len(lines) or "-->" not in lines[line_idx]:
                continue
            line = lines[line_idx].strip()
            line_idx += 1

        match = _VTT_TIMING.match(line)
        cue_lines: list[str] = []
        while line_idx < len(lines) and lines[line_idx].strip():
            cue_lines.append(lines[line_idx])
            line_idx += 1
        if match is None:
            continue
        t_start_ms = _parse_timestamp_ms(match.group("start"))
        t_end_ms = _parse_timestamp_ms(match.group("end"))
        if t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms:
            continue
        raw_text = "\n".join(cue_lines).strip()
        speaker_match = _VTT_SPEAKER.search(raw_text)
        text_value = _plain_text(_VTT_SPEAKER_TAG.sub("", raw_text))
        if not text_value:
            continue
        segments.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": (
                    str(speaker_match.group(1) or "").strip() or None
                    if speaker_match is not None
                    else None
                ),
            }
        )
    return segments


def parse_srt_transcript(content: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for block in re.split(r"\n\s*\n", _normalize_newlines(content)):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if lines and lines[0].isdigit():
            lines = lines[1:]
        if not lines:
            continue
        match = _SRT_TIMING.match(lines[0])
        if match is None:
            continue
        t_start_ms = _parse_timestamp_ms(match.group("start"))
        t_end_ms = _parse_timestamp_ms(match.group("end"))
        text_value = _plain_text(" ".join(lines[1:]))
        if t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms or not text_value:
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


def parse_json_transcript(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        raw_entries = payload.get("segments")
    else:
        raw_entries = payload
    if not isinstance(raw_entries, list):
        return []
    segments: list[dict[str, Any]] = []
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue
        text_value = _plain_text(entry.get("text") or entry.get("transcript"))
        t_start_ms = _coerce_json_time_ms(
            entry.get("startTime") or entry.get("start_time") or entry.get("start")
        )
        t_end_ms = _coerce_json_time_ms(
            entry.get("endTime") or entry.get("end_time") or entry.get("end")
        )
        if not text_value or t_start_ms is None or t_end_ms is None or t_end_ms <= t_start_ms:
            continue
        speaker_raw = (
            entry.get("speaker_label") or entry.get("speakerLabel") or entry.get("speaker")
        )
        segments.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": (str(speaker_raw).strip() or None) if speaker_raw else None,
            }
        )
    return segments


def parse_plain_text_transcript(
    content: str,
    *,
    episode_duration_ms: int | None = None,
) -> list[dict[str, Any]]:
    lines = [
        _WHITESPACE.sub(" ", line).strip()
        for line in _HTML_TAG.sub(" ", _normalize_newlines(content).strip()).split("\n")
        if _WHITESPACE.sub(" ", line).strip()
    ]
    if not lines:
        return []
    return [
        {
            "text": "\n".join(lines),
            "t_start_ms": 0,
            "t_end_ms": max(0, int(episode_duration_ms or 0)),
            "speaker_label": None,
        }
    ]


def _normalize_newlines(content: str) -> str:
    return str(content or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")


def _plain_text(raw_value: Any) -> str:
    return _WHITESPACE.sub(" ", _HTML_TAG.sub(" ", str(raw_value or ""))).strip()


def _coerce_json_time_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return None if raw_value < 0 else int(round(float(raw_value) * 1000))
    value = str(raw_value).strip()
    if ":" in value:
        return _parse_timestamp_ms(value)
    try:
        seconds = float(value)
    except ValueError:
        return None
    return None if seconds < 0 else int(round(seconds * 1000))


def _parse_timestamp_ms(raw_value: Any) -> int | None:
    """Parse `[HH:]MM:SS[.,mmm]`, rejecting out-of-range components."""
    parts = str(raw_value or "").strip().split(":")
    if len(parts) not in {2, 3}:
        return None
    try:
        seconds = float(parts[-1].replace(",", "."))
        minutes = int(parts[-2])
        hours = int(parts[0]) if len(parts) == 3 else 0
    except ValueError:
        return None
    if not 0 <= seconds < 60 or minutes < 0 or hours < 0:
        return None
    if len(parts) == 3 and minutes >= 60:
        return None
    return int(round((hours * 3600 + minutes * 60 + seconds) * 1000))
