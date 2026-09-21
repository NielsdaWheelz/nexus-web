"""Shared text and datetime parsers for podcast feed and provider payloads."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def normalize_optional_text(value: Any) -> str | None:
    normalized = str(value).strip() if value is not None else ""
    return normalized or None


def normalize_language_tag(value: Any) -> str | None:
    normalized = normalize_optional_text(value)
    return None if normalized is None else normalized.lower().replace("_", "-")


def parse_iso_datetime(raw_value: Any) -> datetime | None:
    value = normalize_optional_text(raw_value)
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def normalize_provider_published_at(raw_value: Any) -> str | None:
    if isinstance(raw_value, (int, float)):
        if raw_value <= 0:
            return None
        return datetime.fromtimestamp(raw_value, UTC).isoformat().replace("+00:00", "Z")
    parsed = parse_iso_datetime(raw_value)
    return None if parsed is None else parsed.isoformat().replace("+00:00", "Z")
