"""Retry-After header parsing shared by provider clients."""

from __future__ import annotations


def parse_retry_after_seconds(value: str | None, *, cap_seconds: float) -> float | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    try:
        seconds = float(stripped)
    except ValueError:
        return None
    if seconds <= 0:
        return None
    return min(seconds, cap_seconds)
