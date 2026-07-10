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
# Two classes of authority resolve identity during contributor lookup:
#
# 1. Bibliographic name-authority files (orcid/isni/viaf/wikidata/openalex/lcnaf):
#    globally scoped, cross-authority identity claims — an ORCID for one work and
#    an ISNI for another can be merged by a human; they assert the same real person.
#
# 2. Stable self-asserted single-authority network identity (email):
#    resolves ONLY within its own (authority, external_key) pair. An email sender
#    address is stable and self-asserted: the second issue from the same address is
#    provably the same sender. Resolution here is idempotency — the same address
#    maps to the same contributor — NOT cross-authority merge. ``email`` never
#    merges with an ORCID contributor; ``email``→``email`` is deduplication.
#    ``rss`` stays weak because its per-feed identifier is provenance (the product
#    does not resolve senders by RSS feed id), while ``email`` is strong because
#    sender idempotency is the whole point of the Post Room.
#
# Provider accounts (podcast_index/rss/youtube/gutenberg) are provenance, never
# identity keys — cross-provider duplicates are reconciled by explicit merge.
STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES = frozenset(
    {"orcid", "isni", "viaf", "wikidata", "openalex", "lcnaf", "email"}
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
