"""Shared transcript segment normalization and persistence helpers."""

from __future__ import annotations

import html
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.coerce import coerce_non_negative_int
from nexus.text import normalize_whitespace


@dataclass(frozen=True)
class TranscriptSegmentInput:
    """A normalized transcript segment ready for persistence and indexing.

    The single producer (`normalize_transcript_segments`) populates every field,
    so readers can rely on attribute access rather than defensive `.get(...)`.
    """

    segment_idx: int
    t_start_ms: int
    t_end_ms: int
    canonical_text: str
    speaker_label: str | None


def canonicalize_transcript_segment_text(raw_value: Any) -> str:
    """Canonicalize transcript text to stable, searchable form."""
    return normalize_whitespace(str(raw_value or ""))


def normalize_transcript_segments(raw_segments: Any) -> Sequence[TranscriptSegmentInput]:
    """Normalize and sort transcript segments with deterministic ordering."""
    if not isinstance(raw_segments, list):
        return []

    # (segment, original_idx) pairs: original_idx is a throwaway tie-break key for
    # the stable sort below; it is not part of the persisted contract.
    accepted: list[tuple[TranscriptSegmentInput, int]] = []
    for original_idx, segment in enumerate(raw_segments):
        if not isinstance(segment, dict):
            continue

        text_value = canonicalize_transcript_segment_text(segment.get("text"))
        if not text_value:
            continue

        t_start_ms = coerce_non_negative_int(segment.get("t_start_ms"))
        t_end_ms = coerce_non_negative_int(segment.get("t_end_ms"))
        if t_start_ms is None or t_end_ms is None:
            continue
        if t_start_ms >= t_end_ms:
            continue

        speaker_raw = segment.get("speaker_label")
        speaker_label = str(speaker_raw).strip() if speaker_raw is not None else None
        if speaker_label == "":
            speaker_label = None

        accepted.append(
            (
                TranscriptSegmentInput(
                    segment_idx=0,  # assigned after sorting from final position
                    t_start_ms=t_start_ms,
                    t_end_ms=t_end_ms,
                    canonical_text=text_value,
                    speaker_label=speaker_label,
                ),
                original_idx,
            )
        )

    accepted.sort(key=lambda pair: (pair[0].t_start_ms, pair[1]))
    return [
        TranscriptSegmentInput(
            segment_idx=position,
            t_start_ms=segment.t_start_ms,
            t_end_ms=segment.t_end_ms,
            canonical_text=segment.canonical_text,
            speaker_label=segment.speaker_label,
        )
        for position, (segment, _original_idx) in enumerate(accepted)
    ]


def insert_transcript_fragments(
    db: Session,
    media_id: UUID,
    transcript_segments: Sequence[TranscriptSegmentInput],
    *,
    now: datetime,
    transcript_version_id: UUID | None = None,
) -> None:
    """Persist transcript segments as ordered fragments."""
    for idx, segment in enumerate(transcript_segments):
        canonical_text = segment.canonical_text
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
                "t_start_ms": segment.t_start_ms,
                "t_end_ms": segment.t_end_ms,
                "speaker_label": segment.speaker_label,
                "created_at": now,
            },
        )
