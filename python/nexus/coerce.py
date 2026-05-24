"""Numeric coercion helpers shared across services."""

from typing import Any


def coerce_positive_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def coerce_non_negative_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value
