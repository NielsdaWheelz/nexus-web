"""Contributor vocabulary, name normalizers, handle grammar, and observation values."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal, NewType, get_args

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

# Authority precedence for selecting the one identity key on an observation.
CONTRIBUTOR_KEY_AUTHORITIES: Final[tuple[str, ...]] = ("email_address", "x_user", "youtube_channel")


def canonicalize_identity_key(authority: str, key: str) -> str | None:
    """Canonical form of an exact identity key, or ``None`` to omit the claim."""
    value = key.strip()
    if authority == "email_address":
        normalized = value.lower()
        if normalized.count("@") != 1 or any(ch.isspace() for ch in normalized):
            return None
        local, _, domain = normalized.partition("@")
        return normalized if local and domain else None
    if authority == "x_user":
        return value if re.fullmatch(r"[0-9]+", value) else None
    if authority == "youtube_channel":
        return value if re.fullmatch(r"UC[0-9A-Za-z_-]{22}", value) else None
    return None


# Default_Ignorable_Code_Point, frozen at Unicode 15.0.0; match key only, not display.
_DEFAULT_IGNORABLE_RE: Final = re.compile(
    "[­͏؜ᅟ-ᅠ឴-឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)
# Migration 0179 embeds a frozen byte-identical copy of this regex, the edge-char
# set, and strip_embedded_email_addresses; keep them in lockstep.
_EMBEDDED_EMAIL_RE: Final = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_EMAIL_STRIP_EDGE_CHARS: Final = ' \t\n\r\f\v<>()[]{}"“”,.;:!?|/\\@·•-–—'


def clean_contributor_display(value: str) -> str:
    """NFC + outer trim + Unicode-whitespace collapse. Preserves everything else."""
    return unicodedata.normalize("NFC", " ".join(value.split()))


def contributor_match_key(value: str) -> str:
    """The single ``toNFKC_Casefold`` match key; punctuation and order stay significant."""
    text = _DEFAULT_IGNORABLE_RE.sub("", unicodedata.normalize("NFKC", value))
    return " ".join(unicodedata.normalize("NFKC", text.casefold()).split())


def strip_embedded_email_addresses(value: str) -> str:
    """Remove embedded addresses and wrappers; unchanged when there is none, empty when only one."""
    without = _EMBEDDED_EMAIL_RE.sub(" ", value)
    if without == value:
        return value
    return " ".join(without.split()).strip(_EMAIL_STRIP_EDGE_CHARS)


RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS: Final[frozenset[str]] = frozenset(
    {"directory", "reconciliation-candidates"}
)
CONTRIBUTOR_HANDLE_RE: Final = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_CONTRIBUTOR_HANDLE_LENGTH: Final = 80

ContributorHandle = NewType("ContributorHandle", str)


def try_parse_contributor_handle(value: str) -> ContributorHandle | None:
    valid = (
        3 <= len(value) <= MAX_CONTRIBUTOR_HANDLE_LENGTH
        and value not in RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS
        and CONTRIBUTOR_HANDLE_RE.match(value) is not None
    )
    return ContributorHandle(value) if valid else None


def parse_contributor_handle(value: str) -> ContributorHandle:
    """Validate outward handle text once at ingress; ``ValueError`` when invalid."""
    handle = try_parse_contributor_handle(value)
    if handle is None:
        raise ValueError(f"Invalid contributor handle: {value!r}")
    return handle


def assume_contributor_handle(value: str) -> ContributorHandle:
    handle = try_parse_contributor_handle(value)
    if handle is None:
        raise RuntimeError(f"Non-canonical contributor handle: {value!r}")
    return handle


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


@dataclass(frozen=True, slots=True)
class ObservedRoleSlices:
    """A completely-observed set of role slices; each managed role owns 1..20 rows."""

    managed_roles: frozenset[str]
    credits: tuple[ContributorObservation, ...]


@dataclass(frozen=True, slots=True)
class NotObserved:
    """This attempt learned nothing; it never erases prior credits."""


NOT_OBSERVED: Final = NotObserved()

ContributorObservationBatch = ObservedRoleSlices | NotObserved


@dataclass(frozen=True, slots=True)
class RawIdentityClaim:
    """Uncanonicalized twin of :class:`ContributorIdentityKey`, straight from an adapter."""

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
            display = strip_embedded_email_addresses(display[:MAX_CONTRIBUTOR_NAME_CODE_POINTS])
            match_key = contributor_match_key(display)
            if not display or match_key in seen:
                continue
            seen.add(match_key)
            raw_role = clean_contributor_display(entry.raw_role or "")[:MAX_RAW_ROLE_LENGTH]
            kept.append(
                ContributorObservation(
                    credited_name=display,
                    role=role,
                    raw_role=raw_role or None,
                    identity_key=_best_identity_key(entry.identity_claims),
                )
            )
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


def _best_identity_key(claims: Sequence[RawIdentityClaim]) -> ContributorIdentityKey | None:
    """The claim of highest authority precedence that canonicalizes."""
    for authority in CONTRIBUTOR_KEY_AUTHORITIES:
        for claim in claims:
            if claim.authority != authority:
                continue
            canonical = canonicalize_identity_key(authority, claim.key)
            if canonical is not None:
                return ContributorIdentityKey(authority, canonical)
    return None


@dataclass(frozen=True, slots=True)
class KeyDistinctSeed:
    """Forced-distinct seed: an automatic same-authority key conflict."""

    authority: str
    canonical_key: str


@dataclass(frozen=True, slots=True)
class ManualDistinctSeed:
    """Forced-distinct seed: an explicit manual "different author" creation."""

    user_id: str
    media_id: str
    client_mutation_id: str
    row_index: int


def _digest(prefix: bytes, *parts: str) -> str:
    # Preimage is prefix + b"\0" + NUL-joined fields; migration 0179's copy matches it.
    payload = prefix + b"\x00" + b"\x00".join(part.encode("utf-8") for part in parts)
    return hashlib.sha256(payload).hexdigest()


def contributor_handle_candidates(
    display_name: str,
    *,
    distinct_seed: KeyDistinctSeed | ManualDistinctSeed | None = None,
) -> Iterator[ContributorHandle]:
    """Deterministic ladder; hex not base58 because the grammar is [a-z0-9].

    ``None`` yields the base handle; a seed yields the 12/16/24/32-hex ladder over it.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", clean_contributor_display(display_name).lower()).strip("-")
    slug = slug[:32].strip("-")
    name_digest = _digest(b"nexus:contributor-handle:name:v1", contributor_match_key(display_name))
    base = f"{slug}-{name_digest[:12]}" if slug else name_digest[:12]
    if distinct_seed is None:
        yield assume_contributor_handle(base)
        return
    if isinstance(distinct_seed, KeyDistinctSeed):
        digest = _digest(
            b"nexus:contributor-handle:key-distinct:v1",
            distinct_seed.authority,
            distinct_seed.canonical_key,
        )
    else:
        digest = _digest(
            b"nexus:contributor-handle:manual-distinct:v1",
            distinct_seed.user_id,
            distinct_seed.media_id,
            distinct_seed.client_mutation_id,
            str(distinct_seed.row_index),
        )
    for length in (12, 16, 24, 32):
        yield assume_contributor_handle(f"{base}-{digest[:length]}")
