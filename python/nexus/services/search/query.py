"""The search request vocabulary: kinds, formats, the typed query, and the cursor."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.search_types import ALL_RESULT_TYPES
from nexus.services.contributor_taxonomy import CONTRIBUTOR_ROLE_SET

DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MIN_QUERY_LENGTH = 2
# Candidates fetched per result type before cross-type ranking.
CANDIDATES_PER_TYPE = 200

SearchKind = Literal["documents", "notes", "highlights", "conversations", "people", "web"]
MediaFormat = Literal["article", "pdf", "epub", "video", "episode", "podcast"]
ScopeKind = Literal["all", "media", "library", "conversation"]

SEARCH_KINDS: tuple[SearchKind, ...] = (
    "documents",
    "notes",
    "highlights",
    "conversations",
    "people",
    "web",
)
SEARCH_FORMATS: tuple[MediaFormat, ...] = (
    "article",
    "pdf",
    "epub",
    "video",
    "episode",
    "podcast",
)
ALL_KINDS: frozenset[SearchKind] = frozenset(SEARCH_KINDS)

# The one kind → internal result type fold. Exactly one kind owns each result
# type; the chat tool asserts that 1:1 property when it labels a citation.
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

# Public format → the media.kind / podcast storage value retrievers filter on.
# Podcasts are a separate table keyed by the sentinel "podcast".
FORMAT_TO_STORAGE: dict[MediaFormat, str] = {
    "article": "web_article",
    "pdf": "pdf",
    "epub": "epub",
    "video": "video",
    "episode": "podcast_episode",
    "podcast": "podcast",
}

# Result types the one query embedding serves.
SEMANTIC_RESULT_TYPES = ("content_chunk", "note_block")

# Implied kinds: a format filter narrows to Documents, an author/role filter to
# Documents+People, both to Documents only.
FORMAT_KINDS: frozenset[SearchKind] = frozenset({"documents"})
CREDIT_KINDS: frozenset[SearchKind] = frozenset({"documents", "people"})

_KIND_VOCAB: dict[str, SearchKind] = {kind: kind for kind in SEARCH_KINDS}
_FORMAT_VOCAB: dict[str, MediaFormat] = {fmt: fmt for fmt in SEARCH_FORMATS}


@dataclass(frozen=True, slots=True)
class SearchScope:
    """A parsed, validated search scope. ``id`` is None iff ``kind == "all"``."""

    kind: ScopeKind
    id: UUID | None = None


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """The sole input to ``search()``.

    ``requested_kinds`` is None when the param was omitted (⇒ all kinds) and an
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
        kinds = ALL_KINDS if self.requested_kinds is None else self.requested_kinds
        if self.formats:
            kinds = kinds & FORMAT_KINDS
        if self.authors or self.roles:
            kinds = kinds & CREDIT_KINDS
        return kinds

    @property
    def effective_result_types(self) -> tuple[str, ...]:
        wanted: set[str] = set()
        for kind in self.effective_kinds:
            wanted.update(KIND_TO_RESULT_TYPES[kind])
        return tuple(result_type for result_type in ALL_RESULT_TYPES if result_type in wanted)

    @property
    def content_kinds(self) -> list[str]:
        """Storage-kind values the retrievers filter on, from the public formats."""
        return [FORMAT_TO_STORAGE[fmt] for fmt in self.formats]

    @property
    def highlight_notes_only(self) -> bool:
        """Highlights without Notes also retrieves the attached highlight notes."""
        kinds = self.effective_kinds
        return "highlights" in kinds and "notes" not in kinds


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
    """Parse and strictly validate transport tokens into a SearchQuery."""
    return SearchQuery(
        text=text,
        requested_kinds=(
            None if raw_kinds is None else frozenset(_validated(raw_kinds, _kind, "kind"))
        ),
        formats=_validated(raw_formats, _format, "format"),
        authors=tuple(
            dict.fromkeys(t for t in (str(v or "").strip() for v in raw_authors or ()) if t)
        ),
        roles=_validated(raw_roles, _role, "role"),
        scope=scope,
        cursor=cursor,
        limit=limit,
    )


def _validated[T](
    raw: list[str] | None, normalize: Callable[[str], T | None], label: str
) -> tuple[T, ...]:
    """Normalize each token in order, keeping first occurrences; reject out-of-vocab."""
    out: list[T] = []
    for token in raw or ():
        value = normalize(token)
        if value is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, f"Invalid search {label}: {token}"
            )
        if value not in out:
            out.append(value)
    return tuple(out)


def _kind(token: str) -> SearchKind | None:
    return _KIND_VOCAB.get(token.strip().lower())


def _format(token: str) -> MediaFormat | None:
    return _FORMAT_VOCAB.get(token.strip().lower())


def _role(token: str) -> str | None:
    role = str(token or "").strip().lower()
    return role if role in CONTRIBUTOR_ROLE_SET else None


def encode_search_cursor(offset: int) -> str:
    """Encode ``{"offset": n}`` as unpadded base64url."""
    return (
        base64.urlsafe_b64encode(json.dumps({"offset": offset}).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )


def decode_search_cursor(cursor: str) -> int:
    """Decode an offset cursor, or raise E_INVALID_CURSOR."""
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(cursor).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Cursor payload must be an object")
        offset = payload["offset"]
        if type(offset) is not int:
            raise ValueError("Cursor offset must be an integer")
        if offset < 0:
            raise ValueError("Offset must be non-negative")
        return offset
    except (KeyError, ValueError):
        # justify-ignore-error: malformed cursor decode path. ValueError covers
        # binascii.Error, json.JSONDecodeError, UnicodeDecodeError, and the
        # explicit shape raises; KeyError covers a missing offset key.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def hash_query(q: str) -> str:
    """Privacy-safe query fingerprint used by citation records."""
    return hashlib.sha256(q.strip().lower().encode("utf-8")).hexdigest()[:16]
