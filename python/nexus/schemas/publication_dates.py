"""Calendar-precision bibliography dates and external source normalization."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from typing import Annotated

from pydantic import AfterValidator, StringConstraints

from nexus.schemas.presence import Presence, absent, present

_DATE_PATTERN = r"^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$"
_SOURCE_INSTANT = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
)


def _validate_calendar_date(value: str) -> str:
    parts = [int(part) for part in value.split("-")]
    date(parts[0], parts[1] if len(parts) > 1 else 1, parts[2] if len(parts) > 2 else 1)
    return value


PublicationDate = Annotated[
    str,
    StringConstraints(strict=True, min_length=4, max_length=10, pattern=_DATE_PATTERN),
    AfterValidator(_validate_calendar_date),
]


def normalize_source_publication_date(value: str | None) -> Presence[PublicationDate]:
    """Ignore unusable source dates; reduce qualified instants to their UTC day."""
    if value is None:
        return absent()
    value = value.strip()
    try:
        if re.fullmatch(_DATE_PATTERN, value):
            return present(_validate_calendar_date(value))
        if _SOURCE_INSTANT.fullmatch(value):
            return present(datetime.fromisoformat(value).astimezone(UTC).date().isoformat())
    # justify-ignore-error: invalid external calendar values and UTC overflow
    # are absent publication observations, not failed document ingestion.
    except (ValueError, OverflowError):
        return absent()
    return absent()
