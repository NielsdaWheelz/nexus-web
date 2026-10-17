"""Collection revisions stay exact across the bigint database and JSON wire."""

from typing import Annotated

from pydantic import AfterValidator, StringConstraints


def _within_bigint(value: str) -> str:
    if int(value) > 9_223_372_036_854_775_807:
        raise ValueError("Order revision exceeds bigint")
    return value


type OrderRevision = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=False, pattern=r"^[1-9][0-9]{0,18}$"),
    AfterValidator(_within_bigint),
]
