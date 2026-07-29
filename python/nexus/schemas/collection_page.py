"""Strict shared transport contract for complete collection pages."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Set
from dataclasses import dataclass
from types import MappingProxyType
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import Presence

_INT64_MAX = 2**63 - 1
_LIMIT_PATTERN = re.compile(r"[1-9][0-9]*\Z", re.ASCII)
_REVISION_PATTERN = re.compile(r"(?:0|[1-9][0-9]*)\Z", re.ASCII)
_PAGE_KEYS = frozenset({"limit", "cursor", "collection_revision"})
_MANUAL_PAGE_KEYS = frozenset({"limit", "cursor"})

CollectionCursor = Annotated[str, Field(strict=True, min_length=1)]
CollectionRevision = Annotated[int, Field(strict=True, ge=0, le=_INT64_MAX)]


class CollectionPage[T](BaseModel):
    items: list[T]
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    next_cursor: Presence[CollectionCursor] = Field(alias="nextCursor")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class CollectionRevisionOut(BaseModel):
    collection_revision: CollectionRevision = Field(alias="collectionRevision")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


@dataclass(frozen=True)
class ParsedCollectionQuery:
    limit: int
    cursor: CollectionCursor | None
    collection_revision: CollectionRevision | None
    parameters: Mapping[str, str]


def _invalid_query() -> InvalidRequestError:
    return InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid collection query")


def parse_collection_query(
    query_items: Iterable[tuple[str, str]],
    *,
    domain_keys: Set[str],
) -> ParsedCollectionQuery:
    """Parse one exhaustive-list query before owner-specific typed parsing."""
    if domain_keys & (_PAGE_KEYS | {"offset"}):
        raise ValueError("Domain collection query keys overlap shared page keys")

    allowed = _PAGE_KEYS | frozenset(domain_keys)
    parsed: dict[str, str] = {}
    for key, value in query_items:
        if key not in allowed or key in parsed:
            raise _invalid_query()
        parsed[key] = value

    raw_limit = parsed.pop("limit", "100")
    if not _LIMIT_PATTERN.fullmatch(raw_limit):
        raise _invalid_query()
    limit = int(raw_limit)
    if limit > 200:
        raise _invalid_query()

    cursor = parsed.pop("cursor", None)
    raw_revision = parsed.pop("collection_revision", None)
    if cursor == "" or raw_revision == "" or (cursor is None) != (raw_revision is None):
        raise _invalid_query()

    revision = None
    if raw_revision is not None:
        if not _REVISION_PATTERN.fullmatch(raw_revision):
            raise _invalid_query()
        revision = int(raw_revision)
        if revision > _INT64_MAX:
            raise _invalid_query()

    return ParsedCollectionQuery(
        limit=limit,
        cursor=cursor,
        collection_revision=revision,
        parameters=MappingProxyType(parsed),
    )


def parse_manual_page_query(
    query_items: Iterable[tuple[str, str]],
    *,
    domain_keys: Set[str],
    default_limit: int,
    max_limit: int,
) -> ParsedCollectionQuery:
    """Strictly parse an excluded, explicitly paginated collection mode."""
    if domain_keys & (_PAGE_KEYS | {"offset"}):
        raise ValueError("Domain collection query keys overlap shared page keys")
    if not 1 <= default_limit <= max_limit:
        raise ValueError("Manual page limits are invalid")

    allowed = _MANUAL_PAGE_KEYS | frozenset(domain_keys)
    parsed: dict[str, str] = {}
    for key, value in query_items:
        if key not in allowed or key in parsed:
            raise _invalid_query()
        parsed[key] = value

    raw_limit = parsed.pop("limit", str(default_limit))
    if not _LIMIT_PATTERN.fullmatch(raw_limit):
        raise _invalid_query()
    limit = int(raw_limit)
    if limit > max_limit:
        raise _invalid_query()

    cursor = parsed.pop("cursor", None)
    if cursor == "":
        raise _invalid_query()

    return ParsedCollectionQuery(
        limit=limit,
        cursor=cursor,
        collection_revision=None,
        parameters=MappingProxyType(parsed),
    )
