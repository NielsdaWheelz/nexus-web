"""Timestamp formatting helpers shared across services."""


def format_timestamp_ms(timestamp_ms: int | None) -> str | None:
    """Render milliseconds as HH:MM:SS, or None when input is None."""
    if timestamp_ms is None:
        return None
    total_seconds = max(0, int(timestamp_ms) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
