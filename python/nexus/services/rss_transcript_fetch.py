"""Fetch and parse RSS podcast transcript artifacts."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import httpx

from nexus.config import get_settings, real_media_provider_fixtures_requested
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_TRANSCRIPT_TIMEOUT_SECONDS = 15.0
_MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024

_SOURCE_TYPE_PRIORITY = {
    "vtt": 0,
    "srt": 1,
    "json": 2,
    "text": 3,
}

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


def fetch_rss_transcript(
    refs: list[dict[str, Any]] | None,
    *,
    episode_duration_ms: int | None = None,
    episode_language: str | None = None,
    feed_language: str | None = None,
) -> dict[str, Any]:
    """Fetch and parse RSS transcript references in preference order."""
    ordered_refs = _order_transcript_refs(
        refs or [],
        episode_language=episode_language,
        feed_language=feed_language,
    )
    if real_media_provider_fixtures_requested():
        settings = get_settings()
        if settings.real_media_provider_fixtures:
            return _fetch_real_media_fixture_transcript(
                ordered_refs,
                fixture_dir=settings.real_media_fixture_dir,
                episode_duration_ms=episode_duration_ms,
            )
    if not ordered_refs:
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")

    for ref in ordered_refs:
        content, fetch_error = _fetch_transcript_text(
            ref["url"],
            source_type=ref["source_type"],
        )
        if content is None:
            logger.warning(
                "rss_transcript_fetch_failed",
                transcript_url=ref["url"],
                source_type=ref["source_type"],
                error=fetch_error,
            )
            continue

        source_type = ref["source_type"]
        if source_type == "vtt":
            segments = _parse_vtt_transcript(content)
        elif source_type == "srt":
            segments = _parse_srt_transcript(content)
        elif source_type == "json":
            try:
                payload = json.loads(content)
            except ValueError as exc:
                logger.warning(
                    "rss_transcript_parse_failed",
                    transcript_url=ref["url"],
                    source_type=source_type,
                    error=str(exc),
                )
                continue
            segments = _parse_json_transcript(payload)
        else:
            segments = _parse_plain_text_transcript(
                content,
                episode_duration_ms=episode_duration_ms,
            )

        if not segments:
            logger.warning(
                "rss_transcript_parse_failed",
                transcript_url=ref["url"],
                source_type=source_type,
                error="no_segments",
            )
            continue

        return {
            "status": "completed",
            "segments": segments,
            "error_code": None,
            "error_message": None,
            "source_type": source_type,
        }

    return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")


def _fetch_real_media_fixture_transcript(
    ordered_refs: list[dict[str, Any]],
    *,
    fixture_dir: str | None,
    episode_duration_ms: int | None,
) -> dict[str, Any]:
    expected_url = (
        "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/"
        "the-crew-4-astronauts/transcript.txt"
    )
    if not any(ref["url"] == expected_url and ref["source_type"] == "text" for ref in ordered_refs):
        return _failure(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "No real-media RSS transcript fixture for requested refs",
        )
    if fixture_dir is None:
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "REAL_MEDIA_FIXTURE_DIR is required for RSS transcript fixtures",
        )

    path = Path(fixture_dir) / "nasa-hwhap-crew4-transcript.txt"
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            f"RSS transcript fixture unavailable: {exc}",
        )

    payload = content.encode("utf-8")
    if len(payload) != 753 or hashlib.sha256(payload).hexdigest() != (
        "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953"
    ):
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "RSS transcript fixture hash mismatch",
        )

    segments = _parse_plain_text_transcript(content, episode_duration_ms=episode_duration_ms)
    if not segments:
        return _failure(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "RSS transcript fixture had no segments",
        )
    return {
        "status": "completed",
        "segments": segments,
        "error_code": None,
        "error_message": None,
        "source_type": "text",
        "provider_fixture": {
            "path": str(path),
            "byte_length": len(payload),
            "sha256": "57769de7add45b9393be2ea4ad23131a197511805920b1612c6bc91e3ed0b953",
            "source_url": expected_url,
        },
    }


def _order_transcript_refs(
    refs: list[dict[str, Any]],
    *,
    episode_language: str | None,
    feed_language: str | None,
) -> list[dict[str, Any]]:
    ordered: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str | None]] = set()
    normalized_episode_language = _normalize_language_tag(episode_language)
    normalized_feed_language = _normalize_language_tag(feed_language)

    for idx, ref in enumerate(refs):
        if not isinstance(ref, dict):
            continue
        url = str(ref.get("url") or "").strip()
        if not url:
            continue
        try:
            validate_requested_url(url)
        except InvalidRequestError:
            continue

        source_type = _classify_source_type(ref.get("type"), url)
        if source_type is None:
            continue

        language = _normalize_language_tag(ref.get("language"))
        dedupe_key = (url, source_type, language)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        ordered.append(
            {
                "url": url,
                "source_type": source_type,
                "language": language,
                "_sort_idx": idx,
                "_language_rank": _language_rank(
                    language,
                    episode_language=normalized_episode_language,
                    feed_language=normalized_feed_language,
                ),
            }
        )

    ordered.sort(
        key=lambda ref: (
            _SOURCE_TYPE_PRIORITY.get(ref["source_type"], 100),
            ref["_language_rank"],
            ref["_sort_idx"],
        )
    )
    for ref in ordered:
        ref.pop("_sort_idx", None)
        ref.pop("_language_rank", None)
    return ordered


def _classify_source_type(raw_type: Any, url: str) -> str | None:
    normalized_type = _normalize_content_type(raw_type)
    if normalized_type in _VTT_CONTENT_TYPES:
        return "vtt"
    if normalized_type in _SRT_CONTENT_TYPES:
        return "srt"
    if normalized_type in _JSON_CONTENT_TYPES or (
        normalized_type is not None and normalized_type.endswith("+json")
    ):
        return "json"
    if normalized_type == "text/plain":
        return "text"

    lowered_url = str(url or "").strip().lower()
    if lowered_url.endswith(".vtt"):
        return "vtt"
    if lowered_url.endswith(".srt"):
        return "srt"
    if lowered_url.endswith(".json"):
        return "json"
    if lowered_url.endswith(".txt") or lowered_url.endswith(".text"):
        return "text"
    return None


def _language_rank(
    language: str | None,
    *,
    episode_language: str | None,
    feed_language: str | None,
) -> int:
    if language is None:
        return 4
    if _language_matches(language, episode_language):
        return 0
    if _language_matches(language, feed_language):
        return 1
    if _language_matches(language, "en"):
        return 2
    return 3


def _language_matches(language: str | None, preferred: str | None) -> bool:
    if language is None or preferred is None:
        return False
    if language == preferred:
        return True
    language_base = language.split("-", 1)[0]
    preferred_base = preferred.split("-", 1)[0]
    return language_base == preferred_base


def _fetch_transcript_text(url: str, *, source_type: str) -> tuple[str | None, str | None]:
    try:
        validate_requested_url(url)
    except InvalidRequestError as exc:
        return None, f"url_rejected:{exc.message}"

    try:
        response = httpx.get(
            url,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
            timeout=_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except httpx.TimeoutException:
        return None, "timeout"
    except Exception as exc:  # pragma: no cover - exercised in integration paths.
        return None, f"request_failed:{exc}"

    if response.status_code >= 400:
        return None, f"http_{response.status_code}"

    payload_bytes = bytes(response.content or b"")
    if not payload_bytes:
        return None, "empty_body"
    if len(payload_bytes) > _MAX_TRANSCRIPT_BYTES:
        return None, "payload_too_large"

    content_type = _normalize_content_type(response.headers.get("Content-Type"))
    if not _is_allowed_content_type(content_type, source_type=source_type):
        return None, f"content_type_rejected:{content_type or 'unknown'}"

    text_content = response.text
    if not text_content.strip():
        return None, "empty_body"
    return text_content, None


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


def _parse_vtt_transcript(content: str) -> list[dict[str, Any]]:
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


def _parse_srt_transcript(content: str) -> list[dict[str, Any]]:
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


def _parse_json_transcript(payload: Any) -> list[dict[str, Any]]:
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


def _parse_plain_text_transcript(
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


def _normalize_content_type(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip().lower()
    if not normalized:
        return None
    return normalized.split(";", 1)[0].strip() or None


def _normalize_language_tag(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip().lower().replace("_", "-")
    return normalized or None


def _failure(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "segments": [],
        "error_code": error_code,
        "error_message": error_message,
        "source_type": None,
    }
