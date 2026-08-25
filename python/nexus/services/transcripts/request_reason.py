"""Canonical transcript request-reason type and durable decoder."""

from __future__ import annotations

from typing import Literal, cast

TranscriptRequestReason = Literal[
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
    "rss_feed",
]

def require_transcript_request_reason(value: object) -> TranscriptRequestReason:
    """Decode one exact same-system request reason or defect."""
    if not isinstance(value, str) or value not in {
        "episode_open",
        "search",
        "highlight",
        "quote",
        "background_warming",
        "operator_requeue",
        "rss_feed",
    }:
        # justify-defect: callers pass a validated request value or a durable
        # same-system payload/ledger protected by the matching database checks.
        raise AssertionError(f"invalid transcript request reason {value!r}")
    return cast(TranscriptRequestReason, value)
