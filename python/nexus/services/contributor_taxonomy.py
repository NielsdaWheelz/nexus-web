"""Contributor taxonomy: role/status/authority vocabularies and name normalizers.

Pure leaf — no database, no imports from sibling services. Both
``contributors`` (identity) and ``contributor_credits`` (junction) depend on it.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, NewType

# Closed role vocabulary, author first, then by descending precedence for the
# byline. ``CONTRIBUTOR_ROLE_SET`` is the derived membership set for validation;
# ``CONTRIBUTOR_ROLES_ORDERED`` owns ordering for the byline/appending rules.
CONTRIBUTOR_ROLES_ORDERED: Final[tuple[str, ...]] = (
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
)
CONTRIBUTOR_ROLE_SET: Final[frozenset[str]] = frozenset(CONTRIBUTOR_ROLES_ORDERED)


def normalize_contributor_role(value: str | None) -> str:
    role = " ".join(str(value or "author").strip().lower().replace("_", " ").split())
    return role if role in CONTRIBUTOR_ROLE_SET else "unknown"


def display_contributor_name(value: str) -> str:
    return " ".join(value.strip().split())


# One shared adapter/domain/UI cap (per role slice, not per target).
MAX_CREDITS_PER_MANAGED_ROLE: Final = 20
MAX_CONTRIBUTOR_NAME_CODE_POINTS: Final = 200
MAX_RAW_ROLE_LENGTH: Final = 80


# ---------------------------------------------------------------------------
# Identity keys
# ---------------------------------------------------------------------------

# Authority precedence for selecting a single identity key on an observation:
# bibliographic name-authority files first, then stable self-asserted single
# authorities. Lower index wins.
CONTRIBUTOR_KEY_AUTHORITIES: Final[tuple[str, ...]] = (
    "orcid",
    "isni",
    "viaf",
    "wikidata",
    "openalex",
    "lcnaf",
    "email_address",
    "x_user",
    "youtube_channel",
)


def _orcid_check_digit(base_digits: str) -> str:
    # ISO 7064 MOD 11-2 check character over the 15 leading digits.
    total = 0
    for ch in base_digits:
        total = (total + int(ch)) * 2
    result = (12 - total % 11) % 11
    return "X" if result == 10 else str(result)


def _canonicalize_orcid(key: str) -> str | None:
    raw = key.strip().upper().rsplit("/", 1)[-1]
    digits = raw.replace("-", "").replace(" ", "")
    if len(digits) != 16:
        return None
    body, check = digits[:15], digits[15]
    if re.fullmatch(r"[0-9]{15}", body) is None or check not in "0123456789X":
        return None
    if _orcid_check_digit(body) != check:
        return None
    return f"{digits[0:4]}-{digits[4:8]}-{digits[8:12]}-{digits[12:16]}"


def _canonicalize_email_address(key: str) -> str | None:
    normalized = key.strip().lower()
    if normalized.count("@") != 1 or any(ch.isspace() for ch in normalized):
        return None
    local, _, domain = normalized.partition("@")
    if not local or not domain:
        return None
    return normalized


def canonicalize_identity_key(authority: str, key: str) -> str | None:
    """Return the canonical form of an identity key, or ``None`` when invalid.

    ``None`` means "omit this key" — the observation carries no identity claim.
    """

    if authority == "orcid":
        return _canonicalize_orcid(key)
    if authority == "email_address":
        return _canonicalize_email_address(key)
    if authority == "x_user":
        digits = key.strip()
        return digits if re.fullmatch(r"[0-9]+", digits) else None
    if authority == "youtube_channel":
        value = key.strip()
        return value if re.fullmatch(r"UC[0-9A-Za-z_-]{22}", value) else None
    if authority in ("isni", "viaf", "wikidata", "openalex", "lcnaf"):
        trimmed = key.strip()
        return trimmed or None
    return None


# ---------------------------------------------------------------------------
# Names: display cleanup and the single match key
# ---------------------------------------------------------------------------

# Default_Ignorable_Code_Point characters, hardcoded from the published Unicode
# 15.0.0 DerivedCoreProperties.txt (this runtime's ``unicodedata.unidata_version``
# is 15.0.0; this frozen table is authoritative, not derived at runtime). Ranges
# are inclusive and non-overlapping. Stripped from the match key ONLY; display
# cleanup preserves them.
_DEFAULT_IGNORABLE_RANGES: Final[tuple[tuple[int, int], ...]] = (
    (0x00AD, 0x00AD),  # SOFT HYPHEN
    (0x034F, 0x034F),  # COMBINING GRAPHEME JOINER
    (0x061C, 0x061C),  # ARABIC LETTER MARK
    (0x115F, 0x1160),  # HANGUL CHOSEONG/JUNGSEONG FILLER
    (0x17B4, 0x17B5),  # KHMER VOWEL INHERENT AQ/AA
    (0x180B, 0x180F),  # MONGOLIAN FVS 1-3, VOWEL SEPARATOR (180E), FVS 4
    (0x200B, 0x200F),  # ZERO WIDTH SPACE..RIGHT-TO-LEFT MARK
    (0x202A, 0x202E),  # LTR EMBEDDING..RTL OVERRIDE
    (0x2060, 0x206F),  # WORD JOINER..NOMINAL DIGIT SHAPES (incl. reserved 2065)
    (0x3164, 0x3164),  # HANGUL FILLER
    (0xFE00, 0xFE0F),  # VARIATION SELECTOR-1..16
    (0xFEFF, 0xFEFF),  # ZERO WIDTH NO-BREAK SPACE (BOM)
    (0xFFA0, 0xFFA0),  # HALFWIDTH HANGUL FILLER
    (0xFFF0, 0xFFF8),  # reserved FFF0..FFF8
    (0x1BCA0, 0x1BCA3),  # SHORTHAND FORMAT OVERLAP..UP STEP
    (0x1D173, 0x1D17A),  # MUSICAL SYMBOL BEGIN BEAM..END PHRASE
    (0xE0000, 0xE0FFF),  # language tag + variation selector supplement block
)


def _is_default_ignorable(cp: int) -> bool:
    for lo, hi in _DEFAULT_IGNORABLE_RANGES:
        if lo <= cp <= hi:
            return True
        if cp < lo:
            break
    return False


def clean_contributor_display(value: str) -> str:
    """NFC + outer trim + Unicode-whitespace collapse. Preserves everything else.

    Never title-cases, reorders, transliterates, or strips punctuation/diacritics.
    """

    return unicodedata.normalize("NFC", " ".join(value.split()))


def contributor_match_key(value: str) -> str:
    """The single Unicode ``toNFKC_Casefold`` match key (see spec 2.3).

    NFKC -> strip Default_Ignorable_Code_Point -> full casefold -> NFKC ->
    trim/collapse Unicode White_Space. Punctuation, token order, and diacritics
    remain significant; ZWSP/ZWJ/soft-hyphen/BOM and the rest of the
    default-ignorable set are removed from matching only.
    """

    text = unicodedata.normalize("NFKC", value)
    text = "".join(ch for ch in text if not _is_default_ignorable(ord(ch)))
    text = text.casefold()
    text = unicodedata.normalize("NFKC", text)
    return " ".join(text.split())


# ---------------------------------------------------------------------------
# ContributorHandle brand
# ---------------------------------------------------------------------------

RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS: Final[frozenset[str]] = frozenset(
    {"directory", "reconciliation-candidates"}
)
CONTRIBUTOR_HANDLE_RE: Final = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MIN_CONTRIBUTOR_HANDLE_LENGTH: Final = 3
MAX_CONTRIBUTOR_HANDLE_LENGTH: Final = 80

ContributorHandle = NewType("ContributorHandle", str)


def _is_valid_contributor_handle(value: str) -> bool:
    return (
        MIN_CONTRIBUTOR_HANDLE_LENGTH <= len(value) <= MAX_CONTRIBUTOR_HANDLE_LENGTH
        and value not in RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS
        and CONTRIBUTOR_HANDLE_RE.match(value) is not None
    )


def parse_contributor_handle(value: str) -> ContributorHandle:
    """Validate outward handle text once at ingress; raise ``ValueError`` if invalid."""

    if not _is_valid_contributor_handle(value):
        raise ValueError(f"Invalid contributor handle: {value!r}")
    return ContributorHandle(value)


def try_parse_contributor_handle(value: str) -> ContributorHandle | None:
    return ContributorHandle(value) if _is_valid_contributor_handle(value) else None


def assume_contributor_handle(value: str) -> ContributorHandle:
    if not _is_valid_contributor_handle(value):
        # justify-defect: assume* requires an already-canonical handle; a
        # non-canonical value here means an internal producer emitted an invalid
        # handle rather than untrusted input reaching this point.
        raise RuntimeError(f"Non-canonical contributor handle: {value!r}")
    return ContributorHandle(value)


# ---------------------------------------------------------------------------
# Observation values
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ContributorIdentityKey:
    """One exact, canonical identity claim. ``key`` is already canonicalized."""

    authority: str
    key: str


@dataclass(frozen=True, slots=True)
class ContributorObservation:
    credited_name: str
    role: str
    raw_role: str | None
    identity_key: ContributorIdentityKey | None

    def __post_init__(self) -> None:
        if not self.credited_name.strip():
            raise ValueError("ContributorObservation.credited_name must be nonempty")
        if len(self.credited_name) > MAX_CONTRIBUTOR_NAME_CODE_POINTS:
            raise ValueError(
                f"ContributorObservation.credited_name exceeds "
                f"{MAX_CONTRIBUTOR_NAME_CODE_POINTS} code points"
            )
        if self.role not in CONTRIBUTOR_ROLE_SET:
            raise ValueError(f"Unknown contributor role: {self.role!r}")
        if self.raw_role is not None and not (0 < len(self.raw_role) <= MAX_RAW_ROLE_LENGTH):
            raise ValueError("ContributorObservation.raw_role out of bounds")


@dataclass(frozen=True, slots=True)
class ObservedRoleSlices:
    """A completely-observed set of role slices; each managed role owns 1..20 rows."""

    managed_roles: frozenset[str]
    credits: tuple[ContributorObservation, ...]

    def __post_init__(self) -> None:
        if not self.managed_roles:
            raise ValueError("ObservedRoleSlices.managed_roles must be nonempty")
        unknown = self.managed_roles - CONTRIBUTOR_ROLE_SET
        if unknown:
            raise ValueError(f"Unknown managed roles: {sorted(unknown)}")
        counts: dict[str, int] = {}
        for credit in self.credits:
            if credit.role not in self.managed_roles:
                raise ValueError(f"Credit role {credit.role!r} is not a managed role")
            counts[credit.role] = counts.get(credit.role, 0) + 1
        for role in self.managed_roles:
            count = counts.get(role, 0)
            if not (1 <= count <= MAX_CREDITS_PER_MANAGED_ROLE):
                raise ValueError(
                    f"Managed role {role!r} must carry 1..{MAX_CREDITS_PER_MANAGED_ROLE} "
                    f"credits, got {count}"
                )


@dataclass(frozen=True, slots=True)
class NotObserved:
    """This attempt learned nothing; it never erases prior credits."""


NOT_OBSERVED: Final = NotObserved()

ContributorObservationBatch = ObservedRoleSlices | NotObserved


@dataclass(frozen=True, slots=True)
class RawIdentityClaim:
    """An uncanonicalized ``(authority, key)`` candidate from an adapter."""

    authority: str
    key: str


@dataclass(frozen=True, slots=True)
class RawCreditEntry:
    """One raw per-role credit from an adapter, before cleaning/canonicalization."""

    credited_name: str
    raw_role: str | None = None
    identity_claims: tuple[RawIdentityClaim, ...] = ()


def _clean_raw_role(raw_role: str | None) -> str | None:
    if raw_role is None:
        return None
    cleaned = clean_contributor_display(raw_role)
    return cleaned[:MAX_RAW_ROLE_LENGTH] if cleaned else None


def _select_identity_key(
    claims: Sequence[RawIdentityClaim],
) -> ContributorIdentityKey | None:
    best: ContributorIdentityKey | None = None
    best_rank = len(CONTRIBUTOR_KEY_AUTHORITIES)
    for claim in claims:
        if claim.authority not in CONTRIBUTOR_KEY_AUTHORITIES:
            continue
        canonical = canonicalize_identity_key(claim.authority, claim.key)
        if canonical is None:
            continue
        rank = CONTRIBUTOR_KEY_AUTHORITIES.index(claim.authority)
        if rank < best_rank:
            best = ContributorIdentityKey(claim.authority, canonical)
            best_rank = rank
    return best


def build_observation(
    role_to_entries: Mapping[str, Sequence[RawCreditEntry]],
) -> tuple[ContributorObservationBatch, dict[str, int]]:
    """Shared adapter builder: clean, canonicalize one key, dedupe, truncate.

    For each role, cleans display names, selects at most one identity key by
    authority precedence, deduplicates by :func:`contributor_match_key` keeping
    the first occurrence, and truncates to :data:`MAX_CREDITS_PER_MANAGED_ROLE`.
    Returns the batch (``NOT_OBSERVED`` when nothing survives) and per-role
    truncation counts (no names, keys, or addresses).
    """

    managed_roles: set[str] = set()
    credits: list[ContributorObservation] = []
    truncated: dict[str, int] = {}
    for role, entries in role_to_entries.items():
        seen: set[str] = set()
        kept: list[ContributorObservation] = []
        for entry in entries:
            # Hard-truncate to the shared cap so the minted observation honors the
            # §2.1 "max 200 code points" invariant (matches migration D-32); the
            # ContributorObservation value type also enforces it as a defect.
            display = clean_contributor_display(entry.credited_name)[
                :MAX_CONTRIBUTOR_NAME_CODE_POINTS
            ]
            if not display:
                continue
            match_key = contributor_match_key(display)
            if match_key in seen:
                continue
            seen.add(match_key)
            kept.append(
                ContributorObservation(
                    credited_name=display,
                    role=role,
                    raw_role=_clean_raw_role(entry.raw_role),
                    identity_key=_select_identity_key(entry.identity_claims),
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


# ---------------------------------------------------------------------------
# Deterministic handle generation
#
# All suffixes are lowercase-hex SHA-256 prefixes rather than base58 (the
# repo default for opaque suffixes, conventions.md:19-24): the handle grammar
# is [a-z0-9], and base58 includes uppercase, so hex is grammar-forced here.
# This deviation is deliberate; do not "fix" it to base58.
# ---------------------------------------------------------------------------

MAX_SLUG_LENGTH: Final = 32
_HANDLE_DISTINCT_PREFIX_LENGTHS: Final[tuple[int, ...]] = (12, 16, 24, 32)


@dataclass(frozen=True, slots=True)
class KeyDistinctSeed:
    """Automatic forced-distinct seed: a same-authority key conflict."""

    authority: str
    canonical_key: str


@dataclass(frozen=True, slots=True)
class ManualDistinctSeed:
    """Manual forced-distinct seed: an explicit "different author" creation."""

    user_id: str
    media_id: str
    client_mutation_id: str
    row_index: int


def _slug(display_name: str) -> str:
    lowered = clean_contributor_display(display_name).lower()
    return re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")


def _digest(prefix: bytes, *parts: str) -> str:
    # Domain separator per D-7: the version-tagged prefix, then a NUL before the
    # first field and between fields, so the preimage is exactly
    # ``prefix + "\0" + field0 + "\0" + field1 + ...``. The frozen S2 migration
    # copy hashes the same preimage, so the two implementations stay byte-identical.
    payload = prefix + b"\x00" + b"\x00".join(part.encode("utf-8") for part in parts)
    return hashlib.sha256(payload).hexdigest()


def _base_handle(display_name: str) -> str:
    slug = _slug(display_name)[:MAX_SLUG_LENGTH].strip("-")
    name_digest = _digest(b"nexus:contributor-handle:name:v1", contributor_match_key(display_name))[
        :12
    ]
    return f"{slug}-{name_digest}" if slug else name_digest


def contributor_handle_candidates(
    display_name: str,
    *,
    distinct_seed: KeyDistinctSeed | ManualDistinctSeed | None = None,
) -> Iterator[ContributorHandle]:
    """Deterministic handle ladder (see spec 2.3 / D-7).

    ``None`` yields the single base handle (ordinary create). A ``KeyDistinctSeed``
    or ``ManualDistinctSeed`` yields the 12/16/24/32-hex forced-distinct ladder
    over the base; it never yields the bare base. Consumers exhaust the ladder and
    raise a defect on collision — never ``uuid4()``.
    """

    base = _base_handle(display_name)
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
    for length in _HANDLE_DISTINCT_PREFIX_LENGTHS:
        yield assume_contributor_handle(f"{base}-{digest[:length]}")
