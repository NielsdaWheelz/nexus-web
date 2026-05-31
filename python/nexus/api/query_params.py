"""Shared HTTP query/header parsing helpers."""


def parse_comma_list(value: str | None) -> list[str] | None:
    if value is None:
        return None
    return [item.strip() for item in value.split(",") if item.strip()]
