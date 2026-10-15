"""Lossy integers from provider payloads: anything unusable is None."""

from typing import Any


def coerce_int(raw: Any, *, minimum: int) -> int | None:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= minimum else None
