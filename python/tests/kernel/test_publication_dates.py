"""Bibliography dates preserve precision and reject fictitious calendar values."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from nexus.schemas.presence import absent, present
from nexus.schemas.publication_dates import PublicationDate, normalize_source_publication_date


@pytest.mark.parametrize("value", ["0001", "1899", "1899-02", "2000-02-29", "2024-12-31"])
def test_publication_dates_preserve_known_calendar_precision(value: str) -> None:
    assert TypeAdapter(PublicationDate).validate_python(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "0000",
        "1900-02-29",
        "2023-02-29",
        "2024-13",
        "2023-99-99",
        "-0700",
        "1899-01-01T00:00:00Z",
        1899,
    ],
)
def test_publication_dates_reject_impossible_or_unsupported_generated_values(value: object) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(PublicationDate).validate_python(value)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("1899", "1899"),
        (" 1899-02 ", "1899-02"),
        ("2000-01-01T00:30:00+01:00", "1999-12-31"),
        ("2024-01-01T23:30:00.123456789-01:00", "2024-01-02"),
    ],
)
def test_source_instants_reduce_to_utc_days_without_padding_partial_dates(
    source: str, expected: str
) -> None:
    assert normalize_source_publication_date(source) == present(expected)


@pytest.mark.parametrize(
    "source",
    [
        None,
        "",
        "2023-02-29",
        "2024-01-01T10:00:00",
        "2024-01-01T10:00:00+00:99",
        "0001-01-01T00:00:00+01:00",
    ],
)
def test_invalid_source_dates_are_absent_observations(source: str | None) -> None:
    assert normalize_source_publication_date(source) == absent()
