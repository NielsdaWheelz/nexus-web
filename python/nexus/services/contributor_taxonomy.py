"""Contributor taxonomy: role/status/authority vocabularies and name normalizers.

Pure leaf — no database, no imports from sibling services. Both
``contributors`` (identity) and ``contributor_credits`` (junction) depend on it.
"""

from __future__ import annotations

CONTRIBUTOR_ROLES = frozenset(
    {
        "author",
        "editor",
        "translator",
        "host",
        "guest",
        "narrator",
        "creator",
        "producer",
        "publisher",
        "channel",
        "organization",
        "unknown",
    }
)
CONTRIBUTOR_RESOLUTION_STATUSES = frozenset(
    {
        "external_id",
        "manual",
        "confirmed_alias",
        "unverified",
    }
)
# Only true name-authority files assert identity during resolution. Provider
# accounts (podcast_index/rss/youtube/gutenberg) are provenance, never identity
# keys — cross-provider duplicates are reconciled by explicit merge (D-EXT/N9).
STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES = frozenset(
    {"orcid", "isni", "viaf", "wikidata", "openalex", "lcnaf"}
)
CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES = STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES | frozenset(
    {"podcast_index", "rss", "youtube", "gutenberg"}
)
# Alias sources trusted enough to resolve a name to an existing contributor.
# "merge" is written by merge_contributor so post-merge name-only reingest
# resolves to the survivor instead of re-duplicating.
CONFIRMED_ALIAS_SOURCES = frozenset({"manual", "curated", "user", "merge"})


def normalize_contributor_role(value: str | None) -> str:
    role = " ".join(str(value or "author").strip().lower().replace("_", " ").split())
    return role if role in CONTRIBUTOR_ROLES else "unknown"


def normalize_contributor_name(value: str) -> str:
    return " ".join(value.strip().split()).lower()


def display_contributor_name(value: str) -> str:
    return " ".join(value.strip().split())


def normalize_resolution_status(value: object, *, default: str) -> str:
    status = str(value or default).strip()
    return status if status in CONTRIBUTOR_RESOLUTION_STATUSES else default
