"""Shared transcript segment normalization and fragment persistence."""

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

    The single producer (:func:`normalize_transcript_segments`) populates every
    field, so readers use attribute access rather than defensive lookups.
    """

    segment_idx: int
    t_start_ms: int
    t_end_ms: int
    canonical_text: str
    speaker_label: str | None


def normalize_transcript_segments(raw_segments: Any) -> Sequence[TranscriptSegmentInput]:
    """Clean, drop and stably sort raw provider segments, then renumber them."""
    if not isinstance(raw_segments, list):
        return []
    accepted: list[TranscriptSegmentInput] = []
    for original_idx, segment in enumerate(raw_segments):
        if not isinstance(segment, dict):
            continue
        canonical_text = normalize_whitespace(str(segment.get("text") or ""))
        t_start_ms = coerce_non_negative_int(segment.get("t_start_ms"))
        t_end_ms = coerce_non_negative_int(segment.get("t_end_ms"))
        if not canonical_text or t_start_ms is None or t_end_ms is None:
            continue
        if t_start_ms >= t_end_ms:
            continue
        speaker_raw = segment.get("speaker_label")
        speaker_label = str(speaker_raw).strip() if speaker_raw is not None else None
        accepted.append(
            TranscriptSegmentInput(
                # a throwaway tie-break key for the stable sort below
                segment_idx=original_idx,
                t_start_ms=t_start_ms,
                t_end_ms=t_end_ms,
                canonical_text=canonical_text,
                speaker_label=speaker_label or None,
            )
        )
    accepted.sort(key=lambda segment: (segment.t_start_ms, segment.segment_idx))
    return [
        TranscriptSegmentInput(
            segment_idx=position,
            t_start_ms=segment.t_start_ms,
            t_end_ms=segment.t_end_ms,
            canonical_text=segment.canonical_text,
            speaker_label=segment.speaker_label,
        )
        for position, segment in enumerate(accepted)
    ]


def insert_transcript_fragments(
    db: Session,
    media_id: UUID,
    transcript_segments: Sequence[TranscriptSegmentInput],
    *,
    now: datetime,
) -> None:
    """Persist transcript segments as ordered fragments."""
    if not transcript_segments:
        return
    db.execute(
        text(
            """
            INSERT INTO fragments (
                media_id, idx, canonical_text, html_sanitized,
                t_start_ms, t_end_ms, speaker_label, created_at
            )
            VALUES (
                :media_id, :idx, :canonical_text, :html_sanitized,
                :t_start_ms, :t_end_ms, :speaker_label, :created_at
            )
            """
        ),
        [
            {
                "media_id": media_id,
                "idx": idx,
                "canonical_text": segment.canonical_text,
                "html_sanitized": f"<p>{html.escape(segment.canonical_text)}</p>",
                "t_start_ms": segment.t_start_ms,
                "t_end_ms": segment.t_end_ms,
                "speaker_label": segment.speaker_label,
                "created_at": now,
            }
            for idx, segment in enumerate(transcript_segments)
        ],
    )
