"""Complete finite indexes and their strict, domain-owned query grammar."""

from collections.abc import Iterable, Set

from pydantic import BaseModel, ConfigDict

from nexus.errors import ApiErrorCode, InvalidRequestError


class CollectionIndex[T](BaseModel):
    """Every selected item, in its canonical total order, from one read snapshot."""

    items: list[T]

    model_config = ConfigDict(extra="forbid")


def parse_index_query(items: Iterable[tuple[str, str]], *, domain_keys: Set[str]) -> dict[str, str]:
    """Reject repeated and undeclared keys, including paging controls."""
    parsed: dict[str, str] = {}
    for key, value in items:
        if key in parsed or key not in domain_keys or key in {"limit", "cursor"}:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid index query")
        parsed[key] = value
    return parsed
