"""The ``SearchQuery`` value object and its strict request validators.

``SearchQuery`` is the sole input to ``search()`` (spec §5.1/§5.2). The HTTP route
and the chat tool both parse transport → ``SearchQuery`` at the edge. Validation is
query-strict: invalid kinds/formats/roles raise 400 rather than being normalized
(D-11), unlike the lenient ingestion-time ``normalize_contributor_role``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.contributor_taxonomy import CONTRIBUTOR_ROLES
from nexus.services.search import kinds
from nexus.services.search.constants import DEFAULT_LIMIT
from nexus.services.search.kinds import MediaFormat, SearchKind

ScopeKind = Literal["all", "media", "library", "conversation"]


@dataclass(frozen=True, slots=True)
class SearchScope:
    """A parsed, validated search scope (spec §5.1)."""

    kind: ScopeKind
    id: UUID | None = None  # None iff kind == "all"


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """The typed request object passed to ``search()`` (spec §5.1).

    ``requested_kinds`` is ``None`` when the param was omitted (⇒ all kinds) and an
    empty frozenset when explicitly cleared (⇒ no results).
    """

    text: str
    requested_kinds: frozenset[SearchKind] | None = None
    formats: tuple[MediaFormat, ...] = ()
    authors: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()
    scope: SearchScope = field(default_factory=lambda: SearchScope("all"))
    cursor: str | None = None
    limit: int = DEFAULT_LIMIT

    @property
    def effective_kinds(self) -> frozenset[SearchKind]:
        return kinds.effective_kinds(
            self.requested_kinds,
            has_format_filter=bool(self.formats),
            has_credit_filter=bool(self.authors or self.roles),
        )

    @property
    def effective_result_types(self) -> tuple[str, ...]:
        """Internal result types to dispatch, derived from public kinds."""
        return kinds.result_types_for(self.effective_kinds)

    @property
    def content_kinds(self) -> list[str]:
        """Storage-kind values the retrievers filter on, derived from public formats."""
        return kinds.storage_for_formats(self.formats)


def build_search_query(
    *,
    text: str,
    raw_kinds: list[str] | None,
    raw_formats: list[str] | None,
    raw_authors: list[str] | None,
    raw_roles: list[str] | None,
    scope: SearchScope,
    cursor: str | None,
    limit: int,
) -> SearchQuery:
    """Edge factory for the HTTP path: parse + validate transport → SearchQuery."""
    return SearchQuery(
        text=text,
        requested_kinds=parse_requested_kinds(raw_kinds),
        formats=validate_formats(raw_formats),
        authors=_dedup_strings(raw_authors),
        roles=validate_roles(raw_roles),
        scope=scope,
        cursor=cursor,
        limit=limit,
    )


def _dedup[T](raw: list[str] | None, normalize: Callable[[str], T | None]) -> tuple[T, ...]:
    """Map each token through ``normalize``, keeping the first occurrence of each non-None
    result in order. The single trim/dedup scaffold the validators share."""
    out: list[T] = []
    seen: set[T] = set()
    for token in raw or ():
        value = normalize(token)
        if value is None or value in seen:
            continue
        out.append(value)
        seen.add(value)
    return tuple(out)


def _validate_dedup[T](
    raw: list[str] | None, normalize: Callable[[str], T | None], label: str
) -> tuple[T, ...]:
    """Like :func:`_dedup`, but a token that normalizes to None is rejected (400) — the
    strict query-time validation the HTTP edge applies (D-11)."""
    out: list[T] = []
    seen: set[T] = set()
    for token in raw or ():
        value = normalize(token)
        if value is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, f"Invalid search {label}: {token}"
            )
        if value not in seen:
            out.append(value)
            seen.add(value)
    return tuple(out)


def _normalize_role(token: str) -> str | None:
    """A contributor role is valid iff it is in the taxonomy vocab (strict, no coercion)."""
    role = str(token or "").strip().lower()
    return role if role in CONTRIBUTOR_ROLES else None


def _dedup_strings(values: list[str] | None) -> tuple[str, ...]:
    """Trim and dedup free-text strings, preserving first-seen order. None → ()."""
    return _dedup(values, lambda token: str(token or "").strip() or None)


def parse_requested_kinds(raw: list[str] | None) -> frozenset[SearchKind] | None:
    """None (param omitted) ⇒ all; [] (explicitly empty) ⇒ none; invalid ⇒ 400."""
    if raw is None:
        return None
    return frozenset(_validate_dedup(raw, kinds.normalize_kind, "kind"))


def validate_formats(raw: list[str] | None) -> tuple[MediaFormat, ...]:
    """Validate formats against the canonical vocab; reject out-of-vocab (400)."""
    return _validate_dedup(raw, kinds.normalize_format, "format")


def validate_roles(raw: list[str] | None) -> tuple[str, ...]:
    """Validate roles against the contributor taxonomy; reject out-of-vocab (400)."""
    return _validate_dedup(raw, _normalize_role, "role")
