"""Shared parsers for podcast feed/provider datetime and text fields."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def normalize_language_tag(value: Any) -> str | None:
    normalized = normalize_optional_text(value)
    if normalized is None:
        return None
    return normalized.lower().replace("_", "-")


def parse_iso_datetime(raw_value: Any) -> datetime | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def normalize_provider_published_at(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value <= 0:
            return None
        return datetime.fromtimestamp(raw_value, UTC).isoformat().replace("+00:00", "Z")
    raw_text = str(raw_value).strip()
    if not raw_text:
        return None
    parsed = parse_iso_datetime(raw_text)
    if parsed is None:
        return None
    return parsed.isoformat().replace("+00:00", "Z")
