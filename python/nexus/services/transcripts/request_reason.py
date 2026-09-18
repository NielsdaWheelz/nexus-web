"""Canonical transcript request-reason type and durable decoder."""

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
    """Decode one exact same-system request reason or defect."""
    if not isinstance(value, str) or value not in _REASONS:
        # justify-defect: callers pass a validated request value or a durable
        # same-system payload/ledger protected by the matching database checks.
        raise AssertionError(f"invalid transcript request reason {value!r}")
    return cast(TranscriptRequestReason, value)
