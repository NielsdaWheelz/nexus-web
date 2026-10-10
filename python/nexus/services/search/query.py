"""The search request vocabulary: kinds, formats, scopes, the typed query and the cursor codec."""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Literal, TypeGuard, get_args
from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.search_types import ALL_RESULT_TYPES
from nexus.services.contributor_taxonomy import CONTRIBUTOR_ROLE_SET
from nexus.services.resource_graph.refs import ResourceRef

DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MIN_QUERY_LENGTH = 2
MAX_OFFSET = 1000  # the deepest page start a cursor names; it bounds every family's k

SearchKind = Literal["documents", "notes", "highlights", "conversations", "people", "web"]
MediaFormat = Literal["article", "pdf", "epub", "video", "episode", "podcast"]
ScopeKind = Literal["all", "media", "library", "conversation"]

SEARCH_KINDS: tuple[SearchKind, ...] = get_args(SearchKind)
SEARCH_FORMATS: tuple[MediaFormat, ...] = get_args(MediaFormat)

# Exactly one kind owns each result type; the chat tool asserts it.
KIND_TO_RESULT_TYPES: dict[SearchKind, tuple[str, ...]] = {
    "documents": (
        "media",
        "episode",
        "video",
        "podcast",
        "content_chunk",
        "fragment",
        "reader_apparatus_item",
    ),
    "notes": ("page", "note_block"),
    "highlights": ("highlight",),
    "conversations": ("conversation", "message", "artifact"),
    "people": ("contributor",),
    "web": ("web_result",),
}
# Public format -> the media.kind value (podcasts are their own table).
FORMAT_STORAGE: dict[MediaFormat, str] = {
    "article": "web_article",
    "pdf": "pdf",
    "epub": "epub",
    "video": "video",
    "episode": "podcast_episode",
    "podcast": "podcast",
}


@dataclass(frozen=True, slots=True)
class SearchScope:
    """``id`` is None iff ``kind == "all"``."""

    kind: ScopeKind
    id: UUID | None = None


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """The input to search. ``requested_kinds`` None means all kinds; empty means none.

    ``frozen_context_refs`` turns the "all" scope into exactly those refs (chat).
    """

    text: str
    requested_kinds: frozenset[SearchKind] | None = None
    formats: tuple[MediaFormat, ...] = ()
    authors: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()
    scope: SearchScope = field(default_factory=lambda: SearchScope("all"))
    cursor: str | None = None
    limit: int = DEFAULT_LIMIT
    frozen_context_refs: tuple[ResourceRef, ...] | None = None

    @property
    def effective_kinds(self) -> frozenset[SearchKind]:
        """A format narrows to documents; an author or role to documents and people."""
        kinds = frozenset(SEARCH_KINDS) if self.requested_kinds is None else self.requested_kinds
        if self.formats:
            kinds &= {"documents"}
        if self.authors or self.roles:
            kinds &= {"documents", "people"}
        return kinds

    @property
    def effective_result_types(self) -> tuple[str, ...]:
        wanted = {t for kind in self.effective_kinds for t in KIND_TO_RESULT_TYPES[kind]}
        return tuple(t for t in ALL_RESULT_TYPES if t in wanted)

    @property
    def highlight_notes_only(self) -> bool:
        """Highlights without notes also finds the notes hanging off readable highlights."""
        return "highlights" in self.effective_kinds and "notes" not in self.effective_kinds

    @property
    def terms(self) -> str:
        """The text to match, or "" when it is too short (a filter-only query)."""
        text = self.text.strip()
        return text if len(text) >= MIN_QUERY_LENGTH else ""


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
    """Strictly validate transport tokens; the first occurrence of a repeated token wins."""
    return SearchQuery(
        text=text,
        requested_kinds=None
        if raw_kinds is None
        else frozenset(_tokens(raw_kinds, SEARCH_KINDS, "kind")),
        formats=_tokens(raw_formats, SEARCH_FORMATS, "format"),
        authors=tuple(dict.fromkeys(a.strip() for a in raw_authors or () if a.strip())),
        roles=_tokens(raw_roles, tuple(CONTRIBUTOR_ROLE_SET), "role"),
        scope=scope,
        cursor=cursor,
        limit=limit,
    )


def _tokens[T: str](raw: list[str] | None, vocabulary: tuple[T, ...], label: str) -> tuple[T, ...]:
    by_name: dict[str, T] = {token: token for token in vocabulary}
    out: dict[T, None] = {}
    for token in raw or ():
        value = by_name.get(token.strip().lower())
        if value is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, f"Invalid search {label}: {token}"
            )
        out[value] = None
    return tuple(out)


def scope_from_uri(scope: str) -> SearchScope:
    """Parse ``all``, ``media:<id>``, ``library:<id>`` or ``conversation:<id>``."""
    if scope == "all":
        return SearchScope("all")
    kind, _, raw_id = scope.partition(":")
    if kind not in ("media", "library", "conversation"):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")
    try:
        return SearchScope(kind, UUID(raw_id))
    except ValueError:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid {kind} ID in scope"
        ) from None


def hash_query(q: str) -> str:
    """Privacy-safe query fingerprint used by citation records."""
    return hashlib.sha256(q.strip().lower().encode("utf-8")).hexdigest()[:16]


def encode_cursor(payload: dict[str, Any]) -> str:
    """An opaque page position: unpadded base64url of compact, key-sorted JSON."""
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> dict[str, Any]:
    """The payload of an encoded cursor (padded or not), or E_INVALID_CURSOR."""
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except ValueError:  # binascii, json and unicode decode errors are all ValueErrors
        payload = None
    if not isinstance(payload, dict):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
    return payload


def is_offset(value: object) -> TypeGuard[int]:
    """A page start a cursor may carry: an int in [0, MAX_OFFSET]. No cursor is issued past it."""
    return type(value) is int and 0 <= value <= MAX_OFFSET


def decode_offset(cursor: str | None) -> int:
    """The offset of an ``{"offset": n}`` cursor; 0 without a cursor."""
    if cursor is None:
        return 0
    offset = decode_cursor(cursor).get("offset")
    if not is_offset(offset):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
    return offset
