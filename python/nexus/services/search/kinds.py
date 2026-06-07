"""Search kind taxonomy — the spine that folds the 14 internal result types into
six user-facing ``SearchKind``s.

Sole owner of: ``SearchKind`` ↔ internal result types, the ``MediaFormat`` →
storage-target map, kind/format aliases, and the implied-kind (filter↔kind)
compatibility rule. See the search intent-model cutover spec §4.3–§4.5/§4.4a.

Pure leaf: depends only on the result-type authority in ``schemas.search``.
"""

from __future__ import annotations

from typing import Literal

from nexus.schemas.search import ALL_RESULT_TYPES

SearchKind = Literal["documents", "notes", "highlights", "conversations", "people", "web"]
MediaFormat = Literal["article", "pdf", "epub", "video", "episode", "podcast"]

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

# kind → the internal result types it folds in (§4.3). podcast/episode/video are
# Documents differentiated by format; people returns contributor rows.
KIND_TO_RESULT_TYPES: dict[SearchKind, tuple[str, ...]] = {
    "documents": (
        "media",
        "episode",
        "video",
        "podcast",
        "content_chunk",
        "fragment",
        "evidence_span",
    ),
    "notes": ("page", "note_block"),
    "highlights": ("highlight",),
    "conversations": ("conversation", "message"),
    "people": ("contributor",),
    "web": ("web_result",),
}

# Public MediaFormat → the media.kind / podcast storage value the retrievers filter
# on (§4.4a). MediaKind = {web_article, epub, pdf, video, podcast_episode}; podcasts
# are a separate table keyed by the sentinel "podcast". Gutenberg is provenance, not
# a format, and is intentionally absent (N10).
FORMAT_TO_STORAGE: dict[MediaFormat, str] = {
    "article": "web_article",
    "pdf": "pdf",
    "epub": "epub",
    "video": "video",
    "episode": "podcast_episode",
    "podcast": "podcast",
}

# Operator/API aliases that normalize to a canonical kind (§4.4). There is no
# "author" alias — author: is an operator, not a kind.
KIND_ALIASES: dict[str, SearchKind] = {
    "documents": "documents",
    "document": "documents",
    "doc": "documents",
    "docs": "documents",
    "notes": "notes",
    "note": "notes",
    "highlights": "highlights",
    "highlight": "highlights",
    "conversations": "conversations",
    "conversation": "conversations",
    "chat": "conversations",
    "chats": "conversations",
    "people": "people",
    "person": "people",
    "web": "web",
}

# Canonical format vocab as an identity alias map (mirrors KIND_ALIASES) so normalize_format
# narrows to MediaFormat without a cast and leaves room for future format aliases.
FORMAT_ALIASES: dict[str, MediaFormat] = {fmt: fmt for fmt in SEARCH_FORMATS}

# Implied-kind: which kinds can honor a media-format vs an author/role filter (§4.5).
FORMAT_KINDS: frozenset[SearchKind] = frozenset({"documents"})
CREDIT_KINDS: frozenset[SearchKind] = frozenset({"documents", "people"})


def normalize_kind(token: str) -> SearchKind | None:
    """Map a raw kind token (canonical or alias) to a canonical SearchKind, or None."""
    return KIND_ALIASES.get(token.strip().lower())


def normalize_format(token: str) -> MediaFormat | None:
    """Map a raw format token to a canonical MediaFormat, or None."""
    return FORMAT_ALIASES.get(token.strip().lower())


def effective_kinds(
    requested: frozenset[SearchKind] | None,
    *,
    has_format_filter: bool,
    has_credit_filter: bool,
) -> frozenset[SearchKind]:
    """Apply implied-kind narrowing (§4.5).

    ``None`` requested ⇒ all kinds. A media-format filter restricts to Documents;
    an author/role filter restricts to Documents+People. Both ⇒ Documents only.
    An explicitly-empty request stays empty (no results).
    """
    eff = ALL_KINDS if requested is None else requested
    if has_format_filter:
        eff = eff & FORMAT_KINDS
    if has_credit_filter:
        eff = eff & CREDIT_KINDS
    return eff


def result_types_for(kinds: frozenset[SearchKind]) -> tuple[str, ...]:
    """Internal result types for the given kinds, in canonical ALL_RESULT_TYPES order."""
    wanted: set[str] = set()
    for kind in kinds:
        wanted.update(KIND_TO_RESULT_TYPES[kind])
    return tuple(result_type for result_type in ALL_RESULT_TYPES if result_type in wanted)


def storage_for_formats(formats: tuple[MediaFormat, ...]) -> list[str]:
    """Translate the public format vocab to the storage values retrievers filter on."""
    return [FORMAT_TO_STORAGE[fmt] for fmt in formats]
