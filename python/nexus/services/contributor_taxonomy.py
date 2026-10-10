"""Contributor vocabulary, name keys, handle grammar and observation values.

Pure values: no session and no I/O. Every other contributor module and every ingest
adapter builds on these definitions.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final, Literal, NewType, get_args

from nexus.schemas.presence import Presence, absent

ContributorRole = Literal[
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
]

# Author first, then descending byline precedence: where a new role slice is appended.
CONTRIBUTOR_ROLES_ORDERED: Final[tuple[ContributorRole, ...]] = get_args(ContributorRole)
CONTRIBUTOR_ROLE_SET: Final[frozenset[str]] = frozenset(CONTRIBUTOR_ROLES_ORDERED)

MAX_CREDITS_PER_MANAGED_ROLE: Final = 20
MAX_CONTRIBUTOR_NAME_CODE_POINTS: Final = 200
MAX_RAW_ROLE_LENGTH: Final = 80
MAX_CONTRIBUTOR_HANDLE_LENGTH: Final = 80

# Authority precedence for choosing the one identity key of an observed credit.
_KEY_AUTHORITIES: Final = ("email_address", "x_user", "youtube_channel")

# Default_Ignorable_Code_Point, frozen at Unicode 15.0.0; match key only, never display.
_DEFAULT_IGNORABLE_RE: Final = re.compile(
    "[­͏؜ᅟ-ᅠ឴-឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)
_EMBEDDED_EMAIL_RE: Final = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_EMAIL_STRIP_EDGE_CHARS: Final = ' \t\n\r\f\v<>()[]{}"“”,.;:!?|/\\@·•-–—'
_HANDLE_RE: Final = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

ContributorHandle = NewType("ContributorHandle", str)


def clean_contributor_display(value: str) -> str:
    """NFC + outer trim + Unicode-whitespace collapse. Preserves everything else."""
    return unicodedata.normalize("NFC", " ".join(value.split()))


def contributor_match_key(value: str) -> str:
    """The single ``toNFKC_Casefold`` match key; punctuation and order stay significant."""
    text = _DEFAULT_IGNORABLE_RE.sub("", unicodedata.normalize("NFKC", value))
    return " ".join(unicodedata.normalize("NFKC", text.casefold()).split())


def try_parse_contributor_handle(value: str) -> ContributorHandle | None:
    valid = 3 <= len(value) <= MAX_CONTRIBUTOR_HANDLE_LENGTH and _HANDLE_RE.fullmatch(value)
    return ContributorHandle(value) if valid else None


def parse_contributor_handle(value: str) -> ContributorHandle:
    """Validate outward handle text once at ingress; ``ValueError`` when invalid."""
    handle = try_parse_contributor_handle(value)
    if handle is None:
        raise ValueError(f"Invalid contributor handle: {value!r}")
    return handle


def new_contributor_handle(display_name: str, *, distinct: bool) -> ContributorHandle:
    """``slug≤32-<12 hex of the name key>``; a distinct person adds 12 random hex.

    The base handle is a pure function of the name, so the first person of a name owns
    it. Random suffixes need no determinism: a retry reruns the whole operation after a
    rollback, and the handle unique index catches a collision.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", clean_contributor_display(display_name).lower())
    slug = slug.strip("-")[:32].strip("-")
    key = contributor_match_key(display_name).encode()
    digest = hashlib.sha256(b"nexus:contributor-handle:name:v1\x00" + key).hexdigest()[:12]
    base = f"{slug}-{digest}" if slug else digest
    return ContributorHandle(f"{base}-{secrets.token_hex(6)}" if distinct else base)


@dataclass(frozen=True, slots=True)
class ContributorIdentityKey:
    authority: str
    key: str


@dataclass(frozen=True, slots=True)
class ContributorObservation:
    credited_name: str
    role: str
    raw_role: str | None
    identity_key: ContributorIdentityKey | None
    contributor_handle: Presence[ContributorHandle] = field(default_factory=absent)


@dataclass(frozen=True, slots=True)
class ObservedRoleSlices:
    """Complete role slices; declared roles own 0..20 credits, omitted roles stay untouched."""

    managed_roles: frozenset[str]
    credits: tuple[ContributorObservation, ...]


@dataclass(frozen=True, slots=True)
class NotObserved:
    """This attempt learned nothing; it never erases prior credits."""


NOT_OBSERVED: Final = NotObserved()

ContributorObservationBatch = ObservedRoleSlices | NotObserved


@dataclass(frozen=True, slots=True)
class RawIdentityClaim:
    """An uncanonicalized identity key, straight from an adapter."""

    authority: str
    key: str


@dataclass(frozen=True, slots=True)
class RawCreditEntry:
    credited_name: str
    raw_role: str | None = None
    identity_claims: tuple[RawIdentityClaim, ...] = ()


def build_observation(
    role_to_entries: Mapping[str, Sequence[RawCreditEntry]],
) -> tuple[ContributorObservationBatch, dict[str, int]]:
    """Clean, cap at 200, strip addresses, dedupe per role, cap at 20; plus truncation counts."""
    managed_roles: set[str] = set()
    credits: list[ContributorObservation] = []
    truncated: dict[str, int] = {}
    for role, entries in role_to_entries.items():
        seen: set[str] = set()
        kept: list[ContributorObservation] = []
        for entry in entries:
            display = clean_contributor_display(entry.credited_name)
            display = _strip_embedded_email_addresses(display[:MAX_CONTRIBUTOR_NAME_CODE_POINTS])
            match_key = contributor_match_key(display)
            if not display or match_key in seen:
                continue
            seen.add(match_key)
            raw_role = clean_contributor_display(entry.raw_role or "")[:MAX_RAW_ROLE_LENGTH]
            key = _best_identity_key(entry.identity_claims)
            kept.append(ContributorObservation(display, role, raw_role or None, key))
        overflow = len(kept) - MAX_CREDITS_PER_MANAGED_ROLE
        if overflow > 0:
            truncated[role] = overflow
            kept = kept[:MAX_CREDITS_PER_MANAGED_ROLE]
        if kept:
            managed_roles.add(role)
            credits.extend(kept)
    if not credits:
        return NOT_OBSERVED, truncated
    return ObservedRoleSlices(frozenset(managed_roles), tuple(credits)), truncated


def _strip_embedded_email_addresses(value: str) -> str:
    """Remove embedded addresses and wrappers; unchanged when there is none."""
    without = _EMBEDDED_EMAIL_RE.sub(" ", value)
    if without == value:
        return value
    return " ".join(without.split()).strip(_EMAIL_STRIP_EDGE_CHARS)


def _best_identity_key(claims: Sequence[RawIdentityClaim]) -> ContributorIdentityKey | None:
    """The claim of highest authority precedence that canonicalizes."""
    for authority in _KEY_AUTHORITIES:
        for claim in claims:
            if claim.authority == authority:
                key = _canonical_key(authority, claim.key.strip())
                if key is not None:
                    return ContributorIdentityKey(authority, key)
    return None


def _canonical_key(authority: str, value: str) -> str | None:
    if authority == "email_address":
        value = value.lower()
        local, _, domain = value.partition("@")
        valid = value.count("@") == 1 and local and domain and not any(c.isspace() for c in value)
        return value if valid else None
    if authority == "x_user":
        return value if re.fullmatch(r"[0-9]+", value) else None
    return value if re.fullmatch(r"UC[0-9A-Za-z_-]{22}", value) else None
