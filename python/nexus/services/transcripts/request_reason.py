"""The canonical transcript request-reason vocabulary and its strict decoder."""

from __future__ import annotations

from typing import Literal, cast, get_args

TranscriptRequestReason = Literal[
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
    "rss_feed",
]

_REASONS = frozenset(get_args(TranscriptRequestReason))


def require_transcript_request_reason(value: object) -> TranscriptRequestReason:
    """Decode one same-system request reason; anything else is corruption."""
    if not isinstance(value, str) or value not in _REASONS:
        raise AssertionError(f"invalid transcript request reason {value!r}")
    return cast(TranscriptRequestReason, value)
