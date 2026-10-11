"""The shared page contract of the keyset lists: query grammar and response envelope."""

import re
from collections.abc import Iterable, Mapping, Set
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import Presence

_LIMIT = re.compile(r"[1-9][0-9]{0,2}\Z", re.ASCII)


class CollectionPage[T](BaseModel):
    """One page in list order; ``nextCursor`` is absent exactly at the end."""

    items: list[T]
    next_cursor: Presence[str] = Field(alias="nextCursor")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


@dataclass(frozen=True)
class CollectionQuery:
    limit: int
    cursor: str | None
    parameters: Mapping[str, str]


def parse_collection_query(
    items: Iterable[tuple[str, str]], *, domain_keys: Set[str]
) -> CollectionQuery:
    """``limit`` (1..200, default 100) and ``cursor`` plus the list's own keys. An unknown
    or repeated key, a bad limit or an empty cursor is E_INVALID_REQUEST."""
    parsed: dict[str, str] = {}
    for key, value in items:
        if key in parsed or key not in domain_keys | {"limit", "cursor"}:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid collection query")
        parsed[key] = value
    limit = parsed.pop("limit", "100")
    cursor = parsed.pop("cursor", None)
    if not _LIMIT.fullmatch(limit) or int(limit) > 200 or cursor == "":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid collection query")
    return CollectionQuery(limit=int(limit), cursor=cursor, parameters=parsed)
