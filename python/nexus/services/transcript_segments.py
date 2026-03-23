"""Shared transcript segment normalization and persistence helpers."""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

_TRANSCRIPT_WHITESPACE_RE = re.compile(r"[\s\u00a0]+", re.UNICODE)


def canonicalize_transcript_segment_text(raw_value: Any) -> str:
    """Canonicalize transcript text to stable, searchable form."""
    text_value = str(raw_value or "")
    text_value = unicodedata.normalize("NFC", text_value)
    text_value = _TRANSCRIPT_WHITESPACE_RE.sub(" ", text_value)
    return text_value.strip()


def normalize_transcript_segments(raw_segments: Any) -> list[dict[str, Any]]:
    """Normalize and sort transcript segments with deterministic ordering."""
    if not isinstance(raw_segments, list):
        return []

    normalized: list[dict[str, Any]] = []
    for original_idx, segment in enumerate(raw_segments):
        if not isinstance(segment, dict):
            continue

        text_value = canonicalize_transcript_segment_text(segment.get("text"))
        if not text_value:
            continue

        t_start_ms = _coerce_non_negative_int(segment.get("t_start_ms"))
        t_end_ms = _coerce_non_negative_int(segment.get("t_end_ms"))
        if t_start_ms is None or t_end_ms is None:
            continue
        if t_start_ms >= t_end_ms:
            continue

        speaker_raw = segment.get("speaker_label")
        speaker_label = str(speaker_raw).strip() if speaker_raw is not None else None
        if speaker_label == "":
            speaker_label = None

        normalized.append(
            {
                "text": text_value,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": speaker_label,
                "_original_idx": original_idx,
            }
        )

    normalized.sort(key=lambda seg: (seg["t_start_ms"], seg["_original_idx"]))
    for seg in normalized:
        seg.pop("_original_idx", None)
    return normalized


def insert_transcript_fragments(
    db: Session,
    media_id: UUID,
    transcript_segments: list[dict[str, Any]],
    *,
    now: datetime,
    transcript_version_id: UUID | None = None,
) -> None:
    """Persist transcript segments as ordered fragments."""
    for idx, segment in enumerate(transcript_segments):
        canonical_text = segment["text"]
        html_sanitized = f"<p>{html.escape(canonical_text)}</p>"
        db.execute(
            text(
                """
                INSERT INTO fragments (
                    media_id,
                    transcript_version_id,
                    idx,
                    canonical_text,
                    html_sanitized,
                    t_start_ms,
                    t_end_ms,
                    speaker_label,
                    created_at
                )
                VALUES (
                    :media_id,
                    :transcript_version_id,
                    :idx,
                    :canonical_text,
                    :html_sanitized,
                    :t_start_ms,
                    :t_end_ms,
                    :speaker_label,
                    :created_at
                )
                """
            ),
            {
                "media_id": media_id,
                "transcript_version_id": transcript_version_id,
                "idx": idx,
                "canonical_text": canonical_text,
                "html_sanitized": html_sanitized,
                "t_start_ms": segment["t_start_ms"],
                "t_end_ms": segment["t_end_ms"],
                "speaker_label": segment["speaker_label"],
                "created_at": now,
            },
        )


def _coerce_non_negative_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value
