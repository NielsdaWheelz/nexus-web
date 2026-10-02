"""Canonical ISBN-13 values and external-source ISBN normalization."""

import re
from typing import Annotated

from pydantic import AfterValidator, StringConstraints

from nexus.schemas.presence import Presence, absent, present


def _validate_isbn13(value: str) -> str:
    checksum = sum(int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(value))
    if checksum % 10:
        raise ValueError("ISBN-13 checksum is invalid")
    return value


Isbn13 = Annotated[
    str,
    StringConstraints(strict=True, min_length=13, max_length=13, pattern=r"^97[89][0-9]{10}$"),
    AfterValidator(_validate_isbn13),
]


def normalize_source_isbn(raw_identifier: str) -> Presence[Isbn13]:
    """Normalize a checksum-valid source ISBN-10/13 to canonical ISBN-13."""
    raw = re.sub(
        r"^(?:urn:isbn:|isbn(?:-1[03])?:?)[ \t]*",
        "",
        raw_identifier.strip(),
        flags=re.IGNORECASE,
    )
    value = re.sub(r"[\s-]", "", raw).upper()
    if re.fullmatch(r"[0-9]{9}[0-9X]", value):
        digits = [10 if char == "X" else int(char) for char in value]
        if sum((10 - index) * digit for index, digit in enumerate(digits)) % 11:
            return absent()
        body = "978" + value[:9]
        checksum = sum(int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(body))
        return present(body + str((-checksum) % 10))
    if re.fullmatch(r"97[89][0-9]{10}", value):
        try:
            return present(_validate_isbn13(value))
        except ValueError:
            return absent()
    return absent()
