"""Lightweight author deduplication hard cutover.

Revision ID: 0179
Revises: 0178
Create Date: 2026-07-15

Collapses duplicate contributor identities once, salvages one effective credit
list per target/role, rewrites every stored contributor reference to the
survivors, then drops the reconciliation/authority-administration storage and
moves the author tables to their final shape (spec
docs/cutovers/lightweight-author-deduplication-hard-cutover.md sections 4/8).

Phases (all inside the one alembic transaction — any raise rolls back
everything including ``alembic_version``, so a failed run leaves no partial
state):

1. Preflight — SELECT-only validation; ``RuntimeError`` with diagnostics
   before any DDL/DML. Over-limit role slices are REPORTED, never failed.
2. Identity collapse — recompute cleaned literals/match keys with the frozen
   local implementations, classify aliases, mine ``source_ref.x_user_id``,
   union-find with same-authority-key rejection, survivor selection, total
   tombstone/merged disposition, alias dedupe, privacy cleanup.
3. Authority vocabulary migration — canonicalize keeps, ``email`` ->
   ``email_address``, ``youtube`` -> ``youtube_channel`` (proven channel ids
   only), create mined ``x_user`` rows, drop feed/work authorities, drop
   ``external_url``/``source`` and the authority CHECK.
4. Credit salvage — per target per role: preserved manual/user/curated rows
   win, else the source slice with greatest MAX(updated_at) then source name
   ascending; repoint to survivors; dedupe ``(contributor, role)``; combine
   role slices at earliest legacy positions; dense renumber; truncate each
   role slice to 20 (aggregate report); record media manual-pin flags.
5. Reference/graph rewrite — see ``_phase5_rewrite_references`` (owned by
   M2a; the stub below no-ops when there is provably no rewrite work).
6. Destructive DDL + cleanup — reconciliation job rows, reconciliation/event
   tables (before loser deletion; they hold FKs into contributors), loser
   deletion, column/constraint/index disposition per D-19/D-20/D-33, the
   ``media.authors_manually_managed`` column, normalized_* recompute.
7. Postconditions — assert-or-raise over the final state, including the
   canonical fixpoint re-derivation and the full reference-manifest re-scan.

This file is self-contained: the display cleaner, match key, identity-key
canonicalizer, handle grammar, and the email sanitized-local-part rule are
FROZEN LOCAL COPIES, byte-identical in behavior to
``nexus/services/contributor_taxonomy.py`` / ``email_ingest_service.py`` at
this revision (pinned by ``test_contributor_taxonomy_v2.py``). Never import
runtime services here; future drift in the runtime must not change history.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable, Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0179"
down_revision: str | Sequence[str] | None = "0178"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ---------------------------------------------------------------------------
# FROZEN COPIES — byte-identical behavior to nexus/services/contributor_taxonomy.py
# (verified against the pinned vectors in test_contributor_taxonomy_v2.py).
# ---------------------------------------------------------------------------

# Default_Ignorable_Code_Point characters, hardcoded from the published Unicode
# 15.0.0 DerivedCoreProperties.txt. Inclusive, non-overlapping, ascending.
_DEFAULT_IGNORABLE_RANGES: tuple[tuple[int, int], ...] = (
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


def _clean_contributor_display(value: str) -> str:
    """NFC + outer trim + Unicode-whitespace collapse. Preserves everything else."""

    return unicodedata.normalize("NFC", " ".join(value.split()))


def _contributor_match_key(value: str) -> str:
    """toNFKC_Casefold match key: NFKC -> strip default-ignorable -> casefold ->
    NFKC -> trim/collapse Unicode White_Space."""

    text = unicodedata.normalize("NFKC", value)
    text = "".join(ch for ch in text if not _is_default_ignorable(ord(ch)))
    text = text.casefold()
    text = unicodedata.normalize("NFKC", text)
    return " ".join(text.split())


def _orcid_check_digit(base_digits: str) -> str:
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


def _canonicalize_identity_key(authority: str, key: str) -> str | None:
    """Canonical form of an identity key, or ``None`` when invalid (= omit)."""

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


# Handle grammar (frozen copy of the taxonomy brand rules).
_RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS = frozenset({"directory", "reconciliation-candidates"})
_CONTRIBUTOR_HANDLE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MIN_CONTRIBUTOR_HANDLE_LENGTH = 3
_MAX_CONTRIBUTOR_HANDLE_LENGTH = 80


def _is_valid_contributor_handle(value: str) -> bool:
    return (
        _MIN_CONTRIBUTOR_HANDLE_LENGTH <= len(value) <= _MAX_CONTRIBUTOR_HANDLE_LENGTH
        and value not in _RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS
        and _CONTRIBUTOR_HANDLE_RE.match(value) is not None
    )


def _sanitized_email_local_display(address: str) -> str:
    """FROZEN copy of the runtime email adapter's sanitized-local-part rule.

    ``email_ingest_service._parse_from_header`` derives the display as
    ``display_contributor_name(addr.split("@")[0])`` (trim + whitespace
    collapse). The migration applies the same split, through the frozen display
    cleaner (identical for the trim/collapse part; adds NFC so the result is a
    ``_clean_contributor_display`` fixpoint as the postconditions require).
    """

    return _clean_contributor_display(address.split("@")[0])


# ---------------------------------------------------------------------------
# Vocabulary (D-2 / D-17 / spec section 4)
# ---------------------------------------------------------------------------

_ROLE_ORDER: tuple[str, ...] = (
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

_MAX_CREDITS_PER_MANAGED_ROLE = 20
_MAX_NAME_CODE_POINTS = 200
_MAX_RAW_ROLE_LENGTH = 80

# D-17 alias-source classification. Resolving sources bind future identity;
# non-resolving sources stay searchable only. Anything else fails preflight.
_RESOLVING_ALIAS_SOURCES = frozenset({"manual", "user", "curated", "merge", "migration"})
_NON_RESOLVING_ALIAS_SOURCES = frozenset(
    {
        "migration:media_authors",
        "migration:podcasts.author",
        "migration:project_gutenberg_catalog.authors",
        "epub_opf",
        "metadata_enrichment",
        "podcast_index",
        "pdf_metadata",
        "rss",
        "web_article_byline",
        "web_article_capture",
        "x_api_author_thread",
        "x_api_post",
        "x_api_quoted_post",
        "x_oembed_article",
        "youtube_metadata",
        "email",
        "project_gutenberg_catalog",
        "local",
    }
)
_KNOWN_SOURCES = _RESOLVING_ALIAS_SOURCES | _NON_RESOLVING_ALIAS_SOURCES

# Spec section 8 credit salvage: user-owned author-list facts.
_PRESERVED_CREDIT_SOURCES = frozenset({"manual", "user", "curated"})

_LEGACY_AUTHORITIES = frozenset(
    {
        "orcid",
        "isni",
        "viaf",
        "wikidata",
        "openalex",
        "lcnaf",
        "podcast_index",
        "rss",
        "youtube",
        "gutenberg",
        "email",
    }
)
_KEPT_AUTHORITIES = frozenset({"orcid", "isni", "viaf", "wikidata", "openalex", "lcnaf"})
_DROPPED_AUTHORITIES = frozenset({"podcast_index", "rss", "gutenberg"})
_FINAL_AUTHORITIES = _KEPT_AUTHORITIES | frozenset({"email_address", "x_user", "youtube_channel"})

_ACTIVE_STATUSES = frozenset({"unverified", "verified"})

# Privacy: values that must never remain in display/alias text. Spec section 8
# says text "contains no address, URL, or provider key", so the scans use
# CONTAINS semantics: a full email (dotted domain not required), an embedded
# dotted-domain address, an http(s) URL anywhere, or a token starting "www.".
# Accepted residual: schemeless URLs without a www. token ("example.com/~jane")
# are indistinguishable from prose/organization names and are not detected.
_FULL_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+")
_EMBEDDED_EMAIL_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_URL_MARKERS = ("http://", "https://")


def _is_full_email(text: str) -> bool:
    return _FULL_EMAIL_RE.fullmatch(text) is not None


def _contains_email(text: str) -> bool:
    return _is_full_email(text) or _EMBEDDED_EMAIL_RE.search(text) is not None


def _contains_url(text: str) -> bool:
    lowered = text.lower()
    if any(marker in lowered for marker in _URL_MARKERS):
        return True
    return any(token.startswith("www.") for token in lowered.split())


# ---------------------------------------------------------------------------
# Reference-owner manifest (spec section 8 floor + D-18 extensions)
# ---------------------------------------------------------------------------

# Known JSONB reference owners. Phase 1 sweeps EVERY jsonb column in the public
# schema and fails on contributor-shaped content outside this set (plus the
# author-internal columns below); phase 5 rewrites these; phase 7 re-scans them.
_JSONB_REF_MANIFEST: tuple[tuple[str, str], ...] = (
    ("message_retrievals", "context_ref"),
    ("message_retrievals", "result_ref"),
    ("message_retrieval_candidate_ledgers", "result_ref"),
    ("message_tool_calls", "result_refs"),
    ("message_tool_calls", "selected_context_refs"),
    ("chat_prompt_assemblies", "included_context_refs"),
    ("chat_prompt_assemblies", "prompt_block_manifest"),
    ("chat_prompt_assemblies", "dropped_items"),
    ("chat_run_events", "payload"),
    ("resource_edges", "snapshot"),  # D-18.5
    ("resource_mutations", "response_json"),
    ("note_blocks", "body_pm_json"),  # D-18.1
)

# Author-system-internal jsonb columns: contributor-shaped content here is
# expected and consumed/destroyed by this migration itself.
_INTERNAL_JSONB_COLUMNS: frozenset[tuple[str, str]] = frozenset(
    {
        ("contributor_credits", "source_ref"),  # mined in phase 2, dropped in phase 6
        ("contributor_identity_events", "payload"),  # table dropped in phase 6
        ("contributor_reconciliation_candidates", "evidence"),  # table dropped in phase 6
    }
)

# Scalar TEXT columns that carry contributor handles / deep links (section 8).
_SCALAR_REF_COLUMNS: tuple[tuple[str, str], ...] = (
    ("message_retrievals", "source_id"),
    ("message_retrievals", "deep_link"),
    ("message_retrieval_candidate_ledgers", "source_id"),
)

# The D-18 sweep needles: every STRUCTURALLY identifiable contributor-ref shape.
# jsonb::text renders object pairs as '"key": value' and string values quoted:
#   - '"contributor_handle":' hits the podcast credit-blob key anywhere;
#   - '"/authors/' hits any JSON string VALUE that begins with the deep-link
#     prefix (the leading quote anchors to value start, so prose that merely
#     mentions /authors/ mid-sentence cannot match).
# Accepted residual: a BARE handle or uuid in an unlisted column is
# indistinguishable from any other string before the contributor set is known
# and cannot be swept here; the manifest columns get loser-specific bare/exact
# probes in phases 5/7 instead.
_CONTRIBUTOR_SHAPE_NEEDLES: tuple[str, ...] = (
    '"type": "contributor"',
    '"objectType": "contributor"',
    '"contributor:',
    '"contributor_handle":',
    '"/authors/',
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _fail(phase: str, message: str) -> None:
    raise RuntimeError(f"0179 {phase}: {message}")


def _report(message: str) -> None:
    print(f"0179: {message}")


def _uuid_list_sql(ids: Iterable[str]) -> str:
    """Literal SQL uuid list; every element is validated against the uuid grammar."""

    values = sorted(set(ids))
    for value in values:
        if _UUID_RE.fullmatch(value) is None:
            _fail("internal", f"non-uuid value in id list: {value!r}")
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def _chunks(items: Sequence, size: int) -> Iterable[Sequence]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _table_exists(bind, table: str) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables"
                " WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table},
        ).scalar()
    )


def _column_exists(bind, table: str, column: str) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns"
                " WHERE table_schema = 'public' AND table_name = :t AND column_name = :c"
            ),
            {"t": table, "c": column},
        ).scalar()
    )


def _constraint_exists(bind, table: str, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid"
                " JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace"
                " WHERE nsp.nspname = 'public' AND rel.relname = :t AND con.conname = :n"
            ),
            {"t": table, "n": name},
        ).scalar()
    )


def _index_exists(bind, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = :n"),
            {"n": name},
        ).scalar()
    )


def _all_jsonb_columns(bind) -> list[tuple[str, str]]:
    rows = bind.execute(
        sa.text(
            "SELECT c.table_name, c.column_name"
            " FROM information_schema.columns c"
            " JOIN information_schema.tables t"
            "   ON t.table_schema = c.table_schema AND t.table_name = c.table_name"
            " WHERE c.table_schema = 'public' AND c.data_type = 'jsonb'"
            "   AND t.table_type = 'BASE TABLE'"
            " ORDER BY c.table_name, c.column_name"
        )
    ).fetchall()
    return [(row[0], row[1]) for row in rows]


def _scan_columns_for_needles(
    bind,
    columns: Sequence[tuple[str, str]],
    needles: Sequence[str],
) -> list[tuple[str, str, int]]:
    """Shared phase-1/phase-7 scanner: rows in ``table.column`` whose ``::text``
    rendering contains any needle. Needles are bound (never interpolated); none
    of our needles contain LIKE metacharacters."""

    hits: list[tuple[str, str, int]] = []
    if not needles:
        return hits
    for table, column in columns:
        if not _table_exists(bind, table) or not _column_exists(bind, table, column):
            continue  # catalog drift: absent owner has nothing to scan
        total = 0
        for chunk in _chunks(list(needles), 40):
            conds = " OR ".join(
                f"\"{column}\"::text LIKE '%' || :n{i} || '%'" for i in range(len(chunk))
            )
            params = {f"n{i}": needle for i, needle in enumerate(chunk)}
            total += bind.execute(
                sa.text(f'SELECT count(*) FROM "{table}" WHERE {conds}'),  # noqa: S608
                params,
            ).scalar()
        if total:
            hits.append((table, column, total))
    return hits


def _stored_key_privacy_literals(bind) -> set[str]:
    """Every stored external key literal, RAW and CANONICAL, for the privacy
    rule "display/alias text contains no provider key". Raw forms matter
    because phase 3 rewrites keys to canonical form while displays/aliases keep
    whatever literal they carried (an undashed ORCID as a display would slip a
    canonical-only check)."""

    literals: set[str] = set()
    for row in bind.execute(
        sa.text("SELECT authority, external_key FROM contributor_external_ids")
    ).fetchall():
        authority, key = row[0], row[1]
        raw = key.strip()
        if raw:
            literals.add(raw)
        if authority == "email":
            canonical = _canonicalize_email_address(key)
        elif authority == "youtube":
            canonical = _canonicalize_identity_key("youtube_channel", key)
        else:
            canonical = _canonicalize_identity_key(authority, key)
        if canonical:
            literals.add(canonical)
    return literals


def _scan_contributor_source_id_residue(
    bind, handles: Iterable[str]
) -> list[tuple[str, str, int]]:
    """Bare-handle residue in the scalar ``source_id`` columns.

    Contributor retrieval/ledger rows store the BARE handle in ``source_id``
    (map:refs-graph R9), which neither the quoted-handle needle
    (``'"<handle>"'``) nor the ``/authors/<handle>`` deep-link needle can ever
    match — probe contributor rows by exact equality instead (zero false
    positives; mirrors the phase-5 rewrite's own WHERE clause)."""

    unique = sorted(set(handles))
    hits: list[tuple[str, str, int]] = []
    if not unique:
        return hits
    for table, column in (
        ("message_retrievals", "source_id"),
        ("message_retrieval_candidate_ledgers", "source_id"),
    ):
        if not _table_exists(bind, table):
            continue
        total = 0
        for chunk in _chunks(unique, 200):
            conds = " OR ".join(f"{column} = :h{i}" for i in range(len(chunk)))
            params = {f"h{i}": handle for i, handle in enumerate(chunk)}
            total += bind.execute(
                sa.text(
                    f"SELECT count(*) FROM {table}"  # noqa: S608
                    f" WHERE result_type = 'contributor' AND ({conds})"
                ),
                params,
            ).scalar()
        if total:
            hits.append((table, column, total))
    return hits


# ---------------------------------------------------------------------------
# Phase 1 — preflight (SELECT-only; RuntimeError before any DDL/DML)
# ---------------------------------------------------------------------------


def _phase1_preflight(bind) -> None:
    # 1. Alias/credit source vocabulary totality (D-17, incl. x_oembed_article).
    for table in ("contributor_aliases", "contributor_credits"):
        rows = bind.execute(
            sa.text(f"SELECT source, count(*) FROM {table} GROUP BY source ORDER BY source")  # noqa: S608
        ).fetchall()
        unknown = [(row[0], row[1]) for row in rows if row[0] not in _KNOWN_SOURCES]
        if unknown:
            _fail(
                "preflight",
                f"unknown {table}.source values (add a D-17 disposition): {unknown}",
            )

    # 1b. Credit role vocabulary totality (spec section 8 preflight names
    # unclassifiable ROLE salvage; never trust ck_contributor_credits_role —
    # phase 4 indexes into the frozen role order and must not KeyError).
    rows = bind.execute(
        sa.text("SELECT role, count(*) FROM contributor_credits GROUP BY role ORDER BY role")
    ).fetchall()
    unknown = [(row[0], row[1]) for row in rows if row[0] not in _ROLE_ORDER]
    if unknown:
        _fail("preflight", f"unknown contributor_credits.role values: {unknown}")

    # 2. Authority vocabulary totality.
    rows = bind.execute(
        sa.text(
            "SELECT authority, count(*) FROM contributor_external_ids"
            " GROUP BY authority ORDER BY authority"
        )
    ).fetchall()
    unknown = [(row[0], row[1]) for row in rows if row[0] not in _LEGACY_AUTHORITIES]
    if unknown:
        _fail("preflight", f"unknown contributor_external_ids.authority values: {unknown}")

    # 3. Handle grammar / reserved-segment violations.
    bad_handles = [
        (str(row[0]), row[1])
        for row in bind.execute(sa.text("SELECT id, handle FROM contributors")).fetchall()
        if not _is_valid_contributor_handle(row[1])
    ]
    if bad_handles:
        _fail("preflight", f"malformed or reserved contributor handles: {bad_handles[:20]}")

    # 4. Malformed identity keys for kept/renamed authorities. ``youtube`` is
    # exempt (ambiguous values are dropped, not failed); dropped authorities
    # are exempt (deleted wholesale in phase 3).
    bad_keys: list[tuple[str, str]] = []
    for row in bind.execute(
        sa.text("SELECT id, authority, external_key FROM contributor_external_ids")
    ).fetchall():
        authority, key = row[1], row[2]
        if authority in _KEPT_AUTHORITIES:
            canonical = _canonicalize_identity_key(authority, key)
        elif authority == "email":
            canonical = _canonicalize_email_address(key)
        else:
            continue
        if canonical is None:
            bad_keys.append((authority, str(row[0])))
    if bad_keys:
        _fail("preflight", f"malformed identity keys (authority, row id): {bad_keys[:20]}")

    # 5. Invalid credit targets and negative ordinals.
    count = bind.execute(
        sa.text(
            "SELECT count(*) FROM contributor_credits"
            " WHERE num_nonnulls(media_id, podcast_id, project_gutenberg_catalog_ebook_id) <> 1"
        )
    ).scalar()
    if count:
        _fail("preflight", f"{count} contributor_credits rows without exactly one target")
    count = bind.execute(
        sa.text("SELECT count(*) FROM contributor_credits WHERE ordinal < 0")
    ).scalar()
    if count:
        _fail("preflight", f"{count} contributor_credits rows with negative ordinal")

    # 6. Names that cannot survive cleaning: blank displays; displays carrying
    # an address/URL/provider key with no re-derivation rule (only a display
    # that IS a full email re-derives, to the sanitized local part); unusable
    # or still-tainted re-derivations; blank credited names. Key equality is
    # checked against every stored key literal, raw AND canonical.
    key_literals = _stored_key_privacy_literals(bind)
    for row in bind.execute(sa.text("SELECT id, display_name FROM contributors")).fetchall():
        cleaned = _clean_contributor_display(row[1])
        if not cleaned:
            _fail("preflight", f"contributor {row[0]} has a blank display name")
        if _is_full_email(cleaned):
            rederived = _sanitized_email_local_display(cleaned)
            if not rederived:
                _fail(
                    "preflight",
                    f"contributor {row[0]} email display re-derivation yields an unusable name",
                )
            if _contains_email(rederived) or _contains_url(rederived) or rederived in key_literals:
                _fail(
                    "preflight",
                    f"contributor {row[0]} email display re-derivation still carries an"
                    " address/URL/provider key",
                )
        elif _contains_email(cleaned) or _contains_url(cleaned) or cleaned in key_literals:
            _fail(
                "preflight",
                f"contributor {row[0]} display carries an address/URL/provider key"
                " with no re-derivation rule",
            )
    count = bind.execute(sa.text("SELECT count(*) FROM contributor_credits")).scalar()
    if count:
        blank = bind.execute(
            sa.text("SELECT id FROM contributor_credits WHERE btrim(credited_name) = ''")
        ).fetchall()
        if blank:
            _fail("preflight", f"blank credited_name on credit rows {[str(r[0]) for r in blank]}")

    # 7. Unknown contributor-ref JSON owners: sweep every jsonb column in the
    # catalog; contributor-shaped content outside the known manifest blocks.
    known = set(_JSONB_REF_MANIFEST) | set(_INTERNAL_JSONB_COLUMNS)
    unknown_columns = [col for col in _all_jsonb_columns(bind) if col not in known]
    hits = _scan_columns_for_needles(bind, unknown_columns, _CONTRIBUTOR_SHAPE_NEEDLES)
    if hits:
        _fail(
            "preflight",
            "contributor-shaped JSON in reference owners outside the D-18 manifest "
            f"(extend the manifest deliberately, never skip): {hits}",
        )

    # 8. Un-rebindable reference owners. Deep rebind validation (collision
    # winners) is phase 5's job; here we fail on structurally broken refs and
    # report the contributor-endpoint counts phase 5 must handle.
    dangling = bind.execute(
        sa.text(
            "SELECT count(*) FROM resource_edges e"
            " WHERE (e.source_scheme = 'contributor'"
            "        AND NOT EXISTS (SELECT 1 FROM contributors c WHERE c.id = e.source_id))"
            "    OR (e.target_scheme = 'contributor'"
            "        AND NOT EXISTS (SELECT 1 FROM contributors c WHERE c.id = e.target_id))"
        )
    ).scalar()
    if dangling:
        _fail(
            "preflight",
            f"{dangling} resource_edges rows reference nonexistent contributors and cannot"
            " be deterministically repointed",
        )
    folio_contributor_edges = bind.execute(
        sa.text(
            "SELECT count(*) FROM oracle_reading_folios f JOIN resource_edges e"
            " ON e.id = f.edge_id"
            " WHERE e.source_scheme = 'contributor' OR e.target_scheme = 'contributor'"
        )
    ).scalar()
    if folio_contributor_edges:
        _report(
            f"preflight: {folio_contributor_edges} oracle_reading_folios rows depend on"
            " contributor edges (phase 5 MUST rebind each to a valid winner or abort)"
        )
    dangling_cited = bind.execute(
        sa.text(
            "SELECT count(*) FROM message_retrievals r WHERE r.cited_edge_id IS NOT NULL"
            " AND NOT EXISTS (SELECT 1 FROM resource_edges e WHERE e.id = r.cited_edge_id)"
        )
    ).scalar()
    if dangling_cited:
        _report(
            f"preflight: {dangling_cited} message_retrievals.cited_edge_id values dangle"
            " (nullable telemetry; phase 5 may null them)"
        )

    # 9. Over-limit role slices: REPORTED for deterministic truncation, never failed.
    rows = bind.execute(
        sa.text(
            "SELECT CASE WHEN media_id IS NOT NULL THEN 'media'"
            "            WHEN podcast_id IS NOT NULL THEN 'podcast'"
            "            ELSE 'gutenberg' END AS target_type,"
            "       role, count(*) AS slice_size"
            " FROM contributor_credits"
            " GROUP BY 1, 2, media_id, podcast_id, project_gutenberg_catalog_ebook_id"
            f" HAVING count(*) > {_MAX_CREDITS_PER_MANAGED_ROLE}"
        )
    ).fetchall()
    if rows:
        summary: dict[tuple[str, str], int] = {}
        for row in rows:
            summary[(row[0], row[1])] = summary.get((row[0], row[1]), 0) + 1
        _report(f"preflight: over-limit role slices to truncate (target_type, role): {summary}")


# ---------------------------------------------------------------------------
# Phase 2 — identity collapse
# ---------------------------------------------------------------------------


class _UnionFind:
    """Union-find with a same-authority-key rejection rule (spec section 8.4).

    A union is rejected when the two components each carry a same-authority key
    set and neither set contains the other — positive evidence of two distinct
    identities. A component's own pre-existing multi-key state (one contributor
    row owning two keys under one authority) is preserved, not split.
    """

    def __init__(self, nodes: Iterable[str], keys_of_node: dict[str, dict[str, set[str]]]):
        self._parent: dict[str, str] = {node: node for node in nodes}
        self._keys: dict[str, dict[str, set[str]]] = {}
        for node, keys in keys_of_node.items():
            self._keys[node] = {auth: set(values) for auth, values in keys.items()}

    def find(self, node: str) -> str:
        root = node
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[node] != root:
            self._parent[node], node = root, self._parent[node]
        return root

    def try_union(self, a: str, b: str) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return True
        keys_a = self._keys.get(ra, {})
        keys_b = self._keys.get(rb, {})
        for authority in set(keys_a) & set(keys_b):
            set_a, set_b = keys_a[authority], keys_b[authority]
            if not (set_a <= set_b or set_b <= set_a):
                return False
        self._parent[rb] = ra
        merged = {auth: set(values) for auth, values in keys_a.items()}
        for authority, values in keys_b.items():
            merged.setdefault(authority, set()).update(values)
        self._keys[ra] = merged
        self._keys.pop(rb, None)
        return True

    def components(self) -> dict[str, list[str]]:
        grouped: dict[str, list[str]] = {}
        for node in self._parent:
            grouped.setdefault(self.find(node), []).append(node)
        return grouped


class _CollapseResult:
    """Plain value object (alembic loads this module outside ``sys.modules``,
    which breaks dataclass field introspection — keep this a plain class)."""

    def __init__(
        self,
        *,
        survivor_of: dict[str, str | None],
        losers: tuple[str, ...],
        handle_of: dict[str, str],
        mined_x_keys: dict[str, set[str]],
    ) -> None:
        # loser uuid -> retained survivor uuid, or None = "no retained
        # survivor: every reference must be deleted, never repointed" (total
        # disposition of tombstone/merged husks with no active mapping target).
        self.survivor_of = survivor_of
        self.losers = losers
        # uuid -> handle for EVERY contributor that existed at phase-2 start
        # (losers keep their pre-deletion handles; survivors never change).
        self.handle_of = handle_of
        # contributor uuid (pre-collapse) -> mined canonical x_user keys.
        self.mined_x_keys = mined_x_keys


def _phase2_identity_collapse(bind) -> _CollapseResult:
    contributors = bind.execute(
        sa.text(
            "SELECT id, handle, display_name, status, merged_into_contributor_id, created_at"
            " FROM contributors ORDER BY created_at, id"
        )
    ).fetchall()
    ids: list[str] = []
    handle_of: dict[str, str] = {}
    display_of: dict[str, str] = {}
    status_of: dict[str, str] = {}
    merged_into: dict[str, str | None] = {}
    created_of: dict[str, object] = {}
    display_truncated = 0
    display_rederived = 0
    for row in contributors:
        cid = str(row[0])
        ids.append(cid)
        handle_of[cid] = row[1]
        status_of[cid] = row[3]
        merged_into[cid] = str(row[4]) if row[4] is not None else None
        created_of[cid] = row[5]
        display = _clean_contributor_display(row[2])
        if _is_full_email(display):
            display = _sanitized_email_local_display(display)
            display_rederived += 1
            if not display:
                _fail("collapse", f"contributor {cid}: email display re-derivation unusable")
        if len(display) > _MAX_NAME_CODE_POINTS:
            display = display[:_MAX_NAME_CODE_POINTS]
            display_truncated += 1
        display_of[cid] = display
    if display_truncated or display_rederived:
        _report(
            f"collapse: displays cleaned — {display_truncated} truncated to 200 code points,"
            f" {display_rederived} email displays re-derived to sanitized local parts"
        )

    def _row_order(cid: str) -> tuple:
        return (created_of[cid], cid)

    # Additive DDL: the classification column, backfilled by the rewrite below;
    # phase 6 applies NOT NULL and the final constraints/indexes (D-19/D-20).
    op.execute("ALTER TABLE contributor_aliases ADD COLUMN resolves_identity BOOLEAN")

    # Load + clean aliases; classify; apply privacy removal (contains-semantics
    # for addresses/URLs; equality against every stored key literal, raw or
    # canonical — aliases are searchable extras, so removal is always safe).
    external_key_literals = _stored_key_privacy_literals(bind)
    alias_rows = bind.execute(
        sa.text(
            "SELECT id, contributor_id, alias, source, created_at"
            " FROM contributor_aliases ORDER BY created_at, id"
        )
    ).fetchall()
    aliases: list[dict] = []
    alias_removed_privacy = 0
    alias_removed_blank = 0
    alias_truncated = 0
    for row in alias_rows:
        literal = _clean_contributor_display(row[2])
        if len(literal) > _MAX_NAME_CODE_POINTS:
            literal = literal[:_MAX_NAME_CODE_POINTS]
            alias_truncated += 1
        if not literal:
            alias_removed_blank += 1
            continue
        if _contains_email(literal) or _contains_url(literal) or literal in external_key_literals:
            alias_removed_privacy += 1
            continue
        aliases.append(
            {
                "id": str(row[0]),
                "contributor_id": str(row[1]),
                "alias": literal,
                "normalized": _contributor_match_key(literal),
                "resolving": row[3] in _RESOLVING_ALIAS_SOURCES,
                "created_at": row[4],
            }
        )
    if alias_removed_privacy or alias_removed_blank or alias_truncated:
        _report(
            f"collapse: aliases — {alias_removed_privacy} removed for privacy,"
            f" {alias_removed_blank} removed blank, {alias_truncated} truncated"
        )

    # Identity-key seeds: canonicalized kept/renamed stored keys + mined X ids.
    keys_of_node: dict[str, dict[str, set[str]]] = {}

    def _seed_key(cid: str, authority: str, key: str) -> None:
        keys_of_node.setdefault(cid, {}).setdefault(authority, set()).add(key)

    for row in bind.execute(
        sa.text("SELECT contributor_id, authority, external_key FROM contributor_external_ids")
    ).fetchall():
        cid, authority, key = str(row[0]), row[1], row[2]
        if authority in _KEPT_AUTHORITIES:
            canonical = _canonicalize_identity_key(authority, key)
            if canonical is not None:  # preflight guarantees; defensive
                _seed_key(cid, authority, canonical)
        elif authority == "email":
            canonical = _canonicalize_email_address(key)
            if canonical is not None:
                _seed_key(cid, "email_address", canonical)
        elif authority == "youtube":
            canonical = _canonicalize_identity_key("youtube_channel", key)
            if canonical is not None:  # only provable UC... channel ids count
                _seed_key(cid, "youtube_channel", canonical)
        # podcast_index / rss / gutenberg identify feeds/works, never people.

    mined_x_keys: dict[str, set[str]] = {}
    mined_skipped = 0
    for row in bind.execute(
        sa.text(
            "SELECT contributor_id, source_ref->>'x_user_id' FROM contributor_credits"
            " WHERE source_ref ? 'x_user_id'"
        )
    ).fetchall():
        cid, raw = str(row[0]), row[1]
        canonical = _canonicalize_identity_key("x_user", raw or "")
        if canonical is None:
            mined_skipped += 1
            continue
        mined_x_keys.setdefault(cid, set()).add(canonical)
        _seed_key(cid, "x_user", canonical)
    if mined_x_keys or mined_skipped:
        _report(
            f"collapse: mined x_user ids for {len(mined_x_keys)} contributors"
            f" ({mined_skipped} unrecoverable values skipped)"
        )

    # Union-find. Edge groups are processed deterministically: exact-key groups
    # first (an exact key always wins — running name unions first could attach
    # a keyless dupe to one key-owner and then hard-fail the other key group as
    # "contradictory" even though keys-first resolves it), then canonical-name
    # groups, then resolving-alias groups; each group's members in earliest-row
    # order. Two deliberate deviations from a literal reading of spec §8.4,
    # both deterministic and outcome-safe: BETWEEN groups the iteration order
    # is the sorted group key (not global earliest-row), and alias groups
    # anchor on the earliest CONTRIBUTOR row (not the earliest alias row),
    # consistent with name groups and with survivor election.
    uf = _UnionFind(ids, keys_of_node)

    key_groups: dict[tuple[str, str], list[str]] = {}
    for cid, per_auth in keys_of_node.items():
        for authority, keys in per_auth.items():
            for key in keys:
                key_groups.setdefault((authority, key), []).append(cid)
    for group_key in sorted(key_groups):
        members = sorted(set(key_groups[group_key]), key=_row_order)
        anchor = members[0]
        for member in members[1:]:
            if not uf.try_union(anchor, member):
                _fail(
                    "collapse",
                    f"contradictory identity data: contributors {anchor} and {member} share"
                    f" exact key {group_key} but carry different keys under one authority",
                )

    name_groups: dict[str, list[str]] = {}
    for cid in ids:
        name_groups.setdefault(_contributor_match_key(display_of[cid]), []).append(cid)
    for group_key in sorted(name_groups):
        members = sorted(set(name_groups[group_key]), key=_row_order)
        anchor = members[0]
        for member in members[1:]:
            uf.try_union(anchor, member)  # rejection = deliberate distinctness

    alias_groups: dict[str, list[str]] = {}
    for alias in aliases:
        if alias["resolving"]:
            alias_groups.setdefault(alias["normalized"], []).append(alias["contributor_id"])
    for group_key in sorted(alias_groups):
        members = sorted(set(alias_groups[group_key]), key=_row_order)
        anchor = members[0]
        for member in members[1:]:
            uf.try_union(anchor, member)

    # Survivor selection + total disposition.
    survivor_of: dict[str, str | None] = {}
    components = uf.components()
    husk_members: list[str] = []
    for root in sorted(components, key=_row_order):
        members = sorted(components[root], key=_row_order)
        active = [m for m in members if status_of[m] in _ACTIVE_STATUSES]
        if active:
            survivor = active[0]  # earliest created_at, then lowest UUID
            for member in members:
                if member != survivor:
                    survivor_of[member] = survivor
        else:
            husk_members.extend(members)

    def _resolve_retained(cid: str) -> str | None:
        if status_of[cid] in _ACTIVE_STATUSES and cid not in survivor_of:
            return cid
        mapped = survivor_of.get(cid)
        return mapped  # None or a retained survivor

    # Merged husks: fall back to the merged_into chain (component-first rule
    # already handled mixed components above); tombstoned husks map to None.
    # The walk is depth-unbounded on purpose: the ``seen`` set alone guarantees
    # termination (cycles stop, every hop visits a new row), and a legitimate
    # deep legacy chain must still find its survivor rather than silently
    # degrading to a husk whose references would be deleted.
    for member in sorted(husk_members, key=_row_order):
        target: str | None = None
        cursor = merged_into.get(member)
        seen: set[str] = {member}
        while cursor is not None and cursor not in seen:
            resolved = _resolve_retained(cursor)
            if resolved is not None:
                target = resolved
                break
            seen.add(cursor)
            cursor = merged_into.get(cursor)
        survivor_of[member] = target  # None = delete references, never repoint
    none_mapped = sorted(cid for cid, target in survivor_of.items() if target is None)
    if none_mapped:
        _report(
            f"collapse: {len(none_mapped)} tombstoned/merged husks have no retained survivor;"
            " their references will be deleted"
        )
        credit_owners = {
            str(row[0])
            for row in bind.execute(
                sa.text("SELECT DISTINCT contributor_id FROM contributor_credits")
            ).fetchall()
        }
        with_credits = [cid for cid in none_mapped if cid in credit_owners]
        if with_credits:
            _fail(
                "collapse",
                "tombstoned/merged contributors with no retained survivor still own credits"
                f" and cannot be rebound deterministically: {with_credits}",
            )

    losers = tuple(sorted(survivor_of))
    survivors = [cid for cid in ids if cid not in survivor_of]
    _report(
        f"collapse: {len(ids)} contributors -> {len(survivors)} survivors, {len(losers)} losers"
    )

    # Alias consolidation: move mapped losers' aliases to their survivors,
    # drop None-mapped husks' aliases, dedupe per (owner, normalized_alias)
    # with resolving-literal preference then earliest (created_at, id), OR the
    # flag (monotonic), and ensure every survivor display owns a resolving alias.
    final_owner_aliases: dict[str, dict[str, dict]] = {cid: {} for cid in survivors}
    alias_dropped_with_husks = 0
    for alias in aliases:
        owner = alias["contributor_id"]
        if owner in survivor_of:
            mapped = survivor_of[owner]
            if mapped is None:
                alias_dropped_with_husks += 1
                continue
            owner = mapped
        bucket = final_owner_aliases[owner]
        existing = bucket.get(alias["normalized"])
        if existing is None:
            bucket[alias["normalized"]] = dict(alias, contributor_id=owner)
            continue
        # Resolving literal beats non-resolving, else earliest (created_at, id).
        challenger_key = (not alias["resolving"], alias["created_at"], alias["id"])
        incumbent_key = (not existing["resolving"], existing["created_at"], existing["id"])
        if challenger_key < incumbent_key:
            merged_flag = alias["resolving"] or existing["resolving"]
            bucket[alias["normalized"]] = dict(alias, contributor_id=owner, resolving=merged_flag)
        else:
            existing["resolving"] = existing["resolving"] or alias["resolving"]
    display_alias_added = 0
    for cid in survivors:
        display_norm = _contributor_match_key(display_of[cid])
        bucket = final_owner_aliases[cid]
        existing = bucket.get(display_norm)
        if existing is None:
            bucket[display_norm] = {
                "id": None,  # gen_random_uuid() at insert
                "contributor_id": cid,
                "alias": display_of[cid],
                "normalized": display_norm,
                "resolving": True,
                "created_at": None,  # server default now()
            }
            display_alias_added += 1
        else:
            existing["resolving"] = True  # canonical display alias resolves
    if alias_dropped_with_husks or display_alias_added:
        _report(
            f"collapse: aliases — {alias_dropped_with_husks} dropped with husks,"
            f" {display_alias_added} canonical display aliases added"
        )

    # Rewrite the alias table in place (tiny table; total rewrite is the
    # simplest way to satisfy dedupe + repoint + classification at once).
    bind.execute(sa.text("DELETE FROM contributor_aliases"))
    insert_kept = sa.text(
        "INSERT INTO contributor_aliases"
        " (id, contributor_id, alias, normalized_alias, source, resolves_identity, created_at)"
        " VALUES (:id, :owner, :alias, :normalized, 'migration', :resolving, :created_at)"
    )
    insert_new = sa.text(
        "INSERT INTO contributor_aliases"
        " (contributor_id, alias, normalized_alias, source, resolves_identity)"
        " VALUES (:owner, :alias, :normalized, 'migration', :resolving)"
    )
    for cid in survivors:
        for alias in final_owner_aliases[cid].values():
            if alias["id"] is None:
                bind.execute(
                    insert_new,
                    {
                        "owner": alias["contributor_id"],
                        "alias": alias["alias"],
                        "normalized": alias["normalized"],
                        "resolving": alias["resolving"],
                    },
                )
            else:
                bind.execute(
                    insert_kept,
                    {
                        "id": alias["id"],
                        "owner": alias["contributor_id"],
                        "alias": alias["alias"],
                        "normalized": alias["normalized"],
                        "resolving": alias["resolving"],
                        "created_at": alias["created_at"],
                    },
                )

    # Persist cleaned/re-derived survivor displays (losers are deleted later).
    update_display = sa.text("UPDATE contributors SET display_name = :d WHERE id = :id")
    for row in contributors:
        cid = str(row[0])
        if cid in survivor_of:
            continue
        if display_of[cid] != row[2]:
            bind.execute(update_display, {"d": display_of[cid], "id": cid})

    return _CollapseResult(
        survivor_of=survivor_of,
        losers=losers,
        handle_of=handle_of,
        mined_x_keys=mined_x_keys,
    )


# ---------------------------------------------------------------------------
# Phase 3 — authority vocabulary migration
# ---------------------------------------------------------------------------


def _phase3_authority_migration(bind, collapse: _CollapseResult) -> None:
    def _final_owner(cid: str) -> str | None:
        if cid in collapse.survivor_of:
            return collapse.survivor_of[cid]
        return cid

    rows = bind.execute(
        sa.text(
            "SELECT id, contributor_id, authority, external_key, created_at"
            " FROM contributor_external_ids ORDER BY created_at, id"
        )
    ).fetchall()
    final_rows: dict[tuple[str, str], dict] = {}  # (authority, key) is globally unique
    dropped_feed = dropped_ambiguous_youtube = dropped_with_husks = deduped = 0
    for row in rows:
        rid, cid, authority, key = str(row[0]), str(row[1]), row[2], row[3]
        owner = _final_owner(cid)
        if owner is None:
            dropped_with_husks += 1
            continue
        if authority in _DROPPED_AUTHORITIES:
            dropped_feed += 1
            continue
        if authority == "youtube":
            canonical = _canonicalize_identity_key("youtube_channel", key)
            if canonical is None:
                dropped_ambiguous_youtube += 1
                continue
            authority = "youtube_channel"
        elif authority == "email":
            canonical = _canonicalize_email_address(key)
            if canonical is None:  # preflight guarantees; defensive
                _fail("authority", f"email key on row {rid} became uncanonicalizable")
            authority = "email_address"
        else:
            canonical = _canonicalize_identity_key(authority, key)
            if canonical is None:
                _fail("authority", f"kept-authority key on row {rid} became uncanonicalizable")
        unique_key = (authority, canonical)
        if unique_key in final_rows:
            deduped += 1  # earliest (created_at, id) row already holds it
            continue
        final_rows[unique_key] = {
            "id": rid,
            "owner": owner,
            "authority": authority,
            "key": canonical,
            "created_at": row[4],
        }
    for cid, keys in sorted(collapse.mined_x_keys.items()):
        owner = _final_owner(cid)
        if owner is None:
            continue
        for key in sorted(keys):
            unique_key = ("x_user", key)
            if unique_key not in final_rows:
                final_rows[unique_key] = {
                    "id": None,
                    "owner": owner,
                    "authority": "x_user",
                    "key": key,
                    "created_at": None,
                }
    if rows or final_rows:
        _report(
            f"authority: {len(rows)} legacy keys -> {len(final_rows)} final"
            f" ({dropped_feed} feed/work dropped, {dropped_ambiguous_youtube} ambiguous"
            f" youtube dropped, {dropped_with_husks} dropped with husks, {deduped} deduped;"
            f" mined x_user rows created:"
            f" {sum(1 for r in final_rows.values() if r['id'] is None)})"
        )

    # Drop the authority CHECK BEFORE rewriting rows: the final vocabulary
    # (email_address / youtube_channel / x_user) is outside the legacy CHECK.
    # The closed application vocabulary owns validation from here on.
    op.execute(
        "ALTER TABLE contributor_external_ids DROP CONSTRAINT ck_contributor_external_ids_authority"
    )
    bind.execute(sa.text("DELETE FROM contributor_external_ids"))
    insert_kept = sa.text(
        "INSERT INTO contributor_external_ids"
        " (id, contributor_id, authority, external_key, source, created_at)"
        " VALUES (:id, :owner, :authority, :key, 'migration', :created_at)"
    )
    insert_new = sa.text(
        "INSERT INTO contributor_external_ids (contributor_id, authority, external_key, source)"
        " VALUES (:owner, :authority, :key, 'migration')"
    )
    for unique_key in sorted(final_rows):
        row = final_rows[unique_key]
        if row["id"] is None:
            bind.execute(
                insert_new,
                {"owner": row["owner"], "authority": row["authority"], "key": row["key"]},
            )
        else:
            bind.execute(insert_kept, row)

    # Dead provenance columns die with the authority migration (spec section 8).
    op.execute("ALTER TABLE contributor_external_ids DROP COLUMN external_url, DROP COLUMN source")


# ---------------------------------------------------------------------------
# Phase 4 — credit salvage (per target, per role)
# ---------------------------------------------------------------------------


def _phase4_credit_salvage(bind, collapse: _CollapseResult) -> set[str]:
    rows = bind.execute(
        sa.text(
            "SELECT id, contributor_id, media_id, podcast_id,"
            " project_gutenberg_catalog_ebook_id, credited_name, role, raw_role, ordinal,"
            " source, created_at, updated_at"
            " FROM contributor_credits ORDER BY created_at, id"
        )
    ).fetchall()
    by_target: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        if row[2] is not None:
            target = ("media", str(row[2]))
        elif row[3] is not None:
            target = ("podcast", str(row[3]))
        else:
            target = ("gutenberg", str(row[4]))
        by_target.setdefault(target, []).append(
            {
                "id": str(row[0]),
                "contributor_id": str(row[1]),
                "credited_name": row[5],
                "role": row[6],
                "raw_role": row[7],
                "ordinal": row[8],
                "source": row[9],
                "created_at": row[10],
                "updated_at": row[11],
            }
        )

    manual_media_ids: set[str] = set()
    delete_ids: list[str] = []
    updates: list[dict] = []
    truncated_targets = 0
    role_index = {role: i for i, role in enumerate(_ROLE_ORDER)}

    for target in sorted(by_target):
        credits = by_target[target]
        by_role: dict[str, list[dict]] = {}
        for credit in credits:
            by_role.setdefault(credit["role"], []).append(credit)

        surviving_slices: list[tuple[tuple, str, list[dict]]] = []
        target_truncated = False
        for role, slice_rows in by_role.items():
            preserved = [c for c in slice_rows if c["source"] in _PRESERVED_CREDIT_SOURCES]
            if preserved:
                winners = preserved
                if role == "author" and target[0] == "media":
                    manual_media_ids.add(target[1])
            else:
                by_source: dict[str, list[dict]] = {}
                for credit in slice_rows:
                    by_source.setdefault(credit["source"], []).append(credit)
                # Greatest MAX(updated_at) wins, then source name ascending.
                best_source = min(
                    by_source,
                    key=lambda source: (
                        # invert recency for min(): latest slice first
                        -max(c["updated_at"].timestamp() for c in by_source[source]),
                        source,
                    ),
                )
                winners = by_source[best_source]
            winner_ids = {c["id"] for c in winners}
            delete_ids.extend(c["id"] for c in slice_rows if c["id"] not in winner_ids)

            # Repoint to survivors, clean literals, dedupe (contributor, role).
            ordered = sorted(winners, key=lambda c: (c["ordinal"], c["created_at"], c["id"]))
            seen_contributors: set[str] = set()
            kept: list[dict] = []
            for credit in ordered:
                cid = credit["contributor_id"]
                mapped = collapse.survivor_of.get(cid, cid)
                if mapped is None:
                    _fail(
                        "salvage",
                        f"credit {credit['id']} references husk contributor {cid} with no"
                        " retained survivor",
                    )
                credit["final_contributor_id"] = mapped
                if mapped in seen_contributors:
                    delete_ids.append(credit["id"])
                    continue
                seen_contributors.add(mapped)
                cleaned = _clean_contributor_display(credit["credited_name"])
                credit["final_credited_name"] = cleaned[:_MAX_NAME_CODE_POINTS]
                raw_role = credit["raw_role"]
                if raw_role is not None:
                    raw_role = _clean_contributor_display(raw_role)[:_MAX_RAW_ROLE_LENGTH] or None
                credit["final_raw_role"] = raw_role
                kept.append(credit)
            if len(kept) > _MAX_CREDITS_PER_MANAGED_ROLE:
                delete_ids.extend(c["id"] for c in kept[_MAX_CREDITS_PER_MANAGED_ROLE:])
                kept = kept[:_MAX_CREDITS_PER_MANAGED_ROLE]
                target_truncated = True
            if kept:
                anchor = (min(c["ordinal"] for c in kept), role_index[role])
                surviving_slices.append((anchor, role, kept))
        if target_truncated:
            truncated_targets += 1

        # Combine role slices at earliest legacy positions; renumber densely.
        next_ordinal = 0
        for _, _, kept in sorted(surviving_slices, key=lambda item: item[0]):
            for credit in kept:
                updates.append(
                    {
                        "id": credit["id"],
                        "contributor_id": credit["final_contributor_id"],
                        "credited_name": credit["final_credited_name"],
                        "raw_role": credit["final_raw_role"],
                        "ordinal": next_ordinal,
                    }
                )
                next_ordinal += 1

    for chunk in _chunks(sorted(set(delete_ids)), 500):
        bind.execute(
            sa.text(f"DELETE FROM contributor_credits WHERE id IN {_uuid_list_sql(chunk)}")  # noqa: S608
        )
    update_sql = sa.text(
        "UPDATE contributor_credits SET contributor_id = :contributor_id,"
        " credited_name = :credited_name, raw_role = :raw_role, ordinal = :ordinal"
        " WHERE id = :id"
    )
    for update in updates:
        bind.execute(update_sql, update)
    _report(
        f"salvage: {len(rows)} credits -> {len(updates)} kept across {len(by_target)} targets"
        f" ({len(set(delete_ids))} losing rows deleted; {truncated_targets} targets had a role"
        f" slice truncated to {_MAX_CREDITS_PER_MANAGED_ROLE};"
        f" {len(manual_media_ids)} media pinned manual)"
    )
    return manual_media_ids


# ---------------------------------------------------------------------------
# Phase 5 — reference/graph rewrite (M2a)
# ---------------------------------------------------------------------------


def _phase5_rewrite_work_exists(bind, losers: Sequence[str], handle_of: dict[str, str]) -> bool:
    """True when any reference owner still mentions a losing contributor.

    Checked owners: the polymorphic UUID pairs, both resource_edges endpoints,
    synapse suppressions, contributor-scoped mutation memos, the JSONB/scalar
    reference manifest (loser uuid / quoted handle / deep-link needles), and
    the scalar ``source_id`` columns by exact bare-handle equality (a bare
    handle matches neither the quoted nor the deep-link needle).
    """

    if not losers:
        return False
    loser_list = _uuid_list_sql(losers)
    pair_probes = (
        f"SELECT 1 FROM user_pinned_objects WHERE object_type = 'contributor'"
        f" AND object_id IN {loser_list}",
        f"SELECT 1 FROM resource_versions WHERE resource_scheme = 'contributor'"
        f" AND resource_id IN {loser_list}",
        f"SELECT 1 FROM resource_view_states WHERE (surface_scheme = 'contributor'"
        f" AND surface_id IN {loser_list}) OR (target_scheme = 'contributor'"
        f" AND target_id IN {loser_list})",
        f"SELECT 1 FROM chat_run_turn_contexts WHERE (requested_subject_scheme = 'contributor'"
        f" AND requested_subject_id IN {loser_list}) OR (subject_scheme = 'contributor'"
        f" AND subject_id IN {loser_list})",
        f"SELECT 1 FROM resource_edges WHERE (source_scheme = 'contributor'"
        f" AND source_id IN {loser_list}) OR (target_scheme = 'contributor'"
        f" AND target_id IN {loser_list})",
        f"SELECT 1 FROM synapse_suppressions WHERE (source_scheme = 'contributor'"
        f" AND source_id IN {loser_list}) OR (target_scheme = 'contributor'"
        f" AND target_id IN {loser_list})",
    )
    for probe in pair_probes:
        if bind.execute(sa.text(f"{probe} LIMIT 1")).scalar():  # noqa: S608
            return True
    scope_needles = [f"contributor:{loser}" for loser in losers]
    for chunk in _chunks(scope_needles, 40):
        conds = " OR ".join(f"mutation_scope LIKE :n{i} || '%'" for i in range(len(chunk)))
        params = {f"n{i}": needle for i, needle in enumerate(chunk)}
        if bind.execute(
            sa.text(f"SELECT 1 FROM resource_mutations WHERE {conds} LIMIT 1"),  # noqa: S608
            params,
        ).scalar():
            return True
    needles: list[str] = list(losers)  # bare uuid catches typed ids + URI strings
    for loser in losers:
        handle = handle_of.get(loser)
        if handle:
            needles.append(f'"{handle}"')
            needles.append(f"/authors/{handle}")
    if _scan_columns_for_needles(
        bind, list(_JSONB_REF_MANIFEST) + list(_SCALAR_REF_COLUMNS), needles
    ):
        return True
    if _scan_contributor_source_id_residue(
        bind, (handle_of[loser] for loser in losers if handle_of.get(loser))
    ):
        return True
    return False


def _phase5_rewrite_ref_string(
    value: str,
    *,
    uuid_map: dict[str, str],
    handle_map: dict[str, str],
    edge_map: dict[str, str],
) -> str:
    """Rewrite one JSON string leaf.

    A contributor reference only ever takes one of these shapes (map:refs-graph):
    a bare survivor uuid (PM ``objectId``, any polymorphic id), a bare handle
    (typed ``{type:contributor,id:<handle>}`` id, ``contributor_handle``,
    ``source_id``, an ``authors`` filter element, a nested ``contributor.handle``),
    a ``contributor:<uuid>`` URI (prompt-assembly / meta-event), or an
    ``/authors/<handle>`` deep link. A dropped-edge uuid (``context_edge_id`` and
    friends) rebinds to its winner. Every other string is returned unchanged.

    The rewrite keys on the value, not the field name: handles are slug+digest
    and uuids are globally unique, so a string equal to a loser handle/uuid is a
    reference by construction and a coincidental non-reference collision cannot
    occur. This value-keyed uniformity is exactly what makes the phase-7 residue
    re-scan provably clean no matter which JSON key carried the value.
    """

    if value in uuid_map:
        return uuid_map[value]
    if value in handle_map:
        return handle_map[value]
    if value in edge_map:
        return edge_map[value]
    if value.startswith("contributor:"):
        rest = value[len("contributor:") :]
        if rest in uuid_map:
            return "contributor:" + uuid_map[rest]
        return value
    if value.startswith("/authors/"):
        rest = value[len("/authors/") :]
        end = 0
        while end < len(rest) and (
            rest[end] == "-" or (rest[end].isascii() and rest[end].isalnum())
        ):
            end += 1
        segment, tail = rest[:end], rest[end:]
        if segment in handle_map:
            return "/authors/" + handle_map[segment] + tail
    return value


def _phase5_rewrite_ref_json(
    value: object,
    *,
    uuid_map: dict[str, str],
    handle_map: dict[str, str],
    edge_map: dict[str, str],
) -> object:
    """Recursive typed JSON transform: rewrite every string leaf, preserving the
    object/array structure (a contributor reference is never a whole node to
    drop — only ids/handles/links change)."""

    if isinstance(value, dict):
        return {
            key: _phase5_rewrite_ref_json(
                item, uuid_map=uuid_map, handle_map=handle_map, edge_map=edge_map
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _phase5_rewrite_ref_json(
                item, uuid_map=uuid_map, handle_map=handle_map, edge_map=edge_map
            )
            for item in value
        ]
    if isinstance(value, str):
        return _phase5_rewrite_ref_string(
            value, uuid_map=uuid_map, handle_map=handle_map, edge_map=edge_map
        )
    return value


def _phase5_load_json_rows(
    bind, table: str, column: str, needles: Sequence[str]
) -> list[tuple[str, object]]:
    """``(id, jsonb_value)`` for every row whose ``column::text`` contains any
    needle. Needles are bound, never interpolated, and never carry LIKE
    metacharacters (uuids/handles are ``[a-z0-9-]``)."""

    if not needles or not _table_exists(bind, table) or not _column_exists(bind, table, column):
        return []
    found: dict[str, object] = {}
    for chunk in _chunks(list(needles), 40):
        conds = " OR ".join(
            f"\"{column}\"::text LIKE '%' || :n{i} || '%'" for i in range(len(chunk))
        )
        params = {f"n{i}": needle for i, needle in enumerate(chunk)}
        for row in bind.execute(
            sa.text(f'SELECT id, "{column}" FROM "{table}" WHERE {conds}'),  # noqa: S608
            params,
        ).fetchall():
            found[str(row[0])] = row[1]
    return list(found.items())


def _phase5_purge_husk_references(bind, husks: frozenset[str], handle_of: dict[str, str]) -> None:
    """A husk is a losing contributor with NO retained survivor (``survivor_of``
    maps it to ``None``). Its references cannot be repointed, so they are removed:

    * the clean leaf polymorphic owners (pins, versions, view states, turn
      contexts) have the offending row deleted — the ``None`` = suppression
      treatment;
    * a husk reference inside FK-entangled or history-bearing JSON (chat
      retrieval / prompt / event owners) or a note body is a data anomaly that
      must never be silently erased and fails the migration before any
      destructive DDL (spec §8: an owner that cannot be deterministically
      repointed or safely deleted blocks cutover).

    Edges are handled by ``_phase5_rewrite_edges`` (husk endpoint -> dropped, no
    winner); suppressions by the wholesale exemption. ``resource_edges.snapshot``
    and ``resource_mutations.response_json`` are excluded HERE only because rows
    with a legitimate disposition still exist at this point (a husk-endpoint
    edge carries its own snapshot; a husk-scoped memo embeds its own handle);
    they get the same fail-loud scan at the END of phase 5, after those
    dispositions ran (``_phase5_fail_on_deferred_husk_residue``), still before
    phase 6's destructive DDL.
    """

    if not husks:
        return
    husk_list = sorted(husks)
    for chunk in _chunks(husk_list, 500):
        ids = _uuid_list_sql(chunk)
        bind.execute(
            sa.text(
                "DELETE FROM user_pinned_objects WHERE object_type = 'contributor'"  # noqa: S608
                f" AND object_id IN {ids}"
            )
        )
        bind.execute(
            sa.text(
                "DELETE FROM resource_versions WHERE resource_scheme = 'contributor'"  # noqa: S608
                f" AND resource_id IN {ids}"
            )
        )
        bind.execute(
            sa.text(
                "DELETE FROM resource_view_states WHERE (surface_scheme = 'contributor'"  # noqa: S608
                f" AND surface_id IN {ids}) OR (target_scheme = 'contributor'"
                f" AND target_id IN {ids})"
            )
        )
        # A turn context whose requested OR actual pair references a husk loses
        # the WHOLE row: nulling only the husk half would violate the pair
        # CHECKs, so the other (possibly valid) pair's run telemetry is
        # deliberately discarded with it ("None => delete references").
        bind.execute(
            sa.text(
                "DELETE FROM chat_run_turn_contexts WHERE (requested_subject_scheme"  # noqa: S608
                f" = 'contributor' AND requested_subject_id IN {ids})"
                f" OR (subject_scheme = 'contributor' AND subject_id IN {ids})"
            )
        )
    needles = list(husk_list) + [handle_of[h] for h in husk_list if handle_of.get(h)]
    raise_columns = [
        column
        for column in _JSONB_REF_MANIFEST
        if column not in {("resource_edges", "snapshot"), ("resource_mutations", "response_json")}
    ] + list(_SCALAR_REF_COLUMNS)
    hits = _scan_columns_for_needles(bind, raise_columns, needles)
    if hits:
        _fail(
            "reference-rewrite",
            "husk (no-survivor) contributor referenced by FK-entangled or history-bearing"
            f" owners that must not be silently erased: {hits}",
        )
    _report(f"reference-rewrite: purged references to {len(husk_list)} no-survivor husks")


def _phase5_delete_suppressions(bind, losers: Sequence[str]) -> None:
    """Suppression exemption (spec §8): a dismissed synapse pair with a losing
    endpoint is DELETED, never repointed — broadening a negative pair onto the
    survivor is not the user's intent."""

    if not losers:
        return
    deleted = 0
    for chunk in _chunks(sorted(losers), 500):
        ids = _uuid_list_sql(chunk)
        deleted += bind.execute(
            sa.text(
                "DELETE FROM synapse_suppressions WHERE (source_scheme = 'contributor'"  # noqa: S608
                f" AND source_id IN {ids}) OR (target_scheme = 'contributor'"
                f" AND target_id IN {ids})"
            )
        ).rowcount
    if deleted:
        _report(f"reference-rewrite: deleted {deleted} synapse_suppressions with a losing endpoint")


def _phase5_dedupe_and_repoint(
    bind,
    *,
    table: str,
    ref_column: str,
    scheme_predicate: str,
    load_extra: str,
    group_key,
    winner_key,
    repoint,
    reverse: bool = False,
) -> None:
    """Shared post-repoint collision resolver for a polymorphic UUID owner whose
    unique key contains the contributor id column.

    Loads every contributor-scheme row (losers AND survivors so a repointed loser
    that lands on an existing survivor row is seen), groups by ``group_key`` over
    the *post-repoint* id, keeps the best row per group (``winner_key`` ascending,
    or descending when ``reverse``), deletes the rest, then repoints surviving
    losers. Deletes precede repoints so no transient state ever violates the
    unique index.
    """

    rows = bind.execute(
        sa.text(
            f"SELECT id, {ref_column}, {load_extra} FROM {table}"  # noqa: S608
            f" WHERE {scheme_predicate}"
        )
    ).fetchall()
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        old = str(row[1])
        record = {
            "id": str(row[0]),
            "old": old,
            "mapped": repoint.get(old, old),
            "row": row,
        }
        groups.setdefault(group_key(record), []).append(record)
    deletes: list[str] = []
    repoints: list[str] = []
    for members in groups.values():
        members.sort(key=winner_key, reverse=reverse)
        winner = members[0]
        deletes.extend(member["id"] for member in members[1:])
        if winner["mapped"] != winner["old"]:
            repoints.append(winner["id"])
    for chunk in _chunks(sorted(set(deletes)), 500):
        bind.execute(
            sa.text(f"DELETE FROM {table} WHERE id IN {_uuid_list_sql(chunk)}")  # noqa: S608
        )
    winner_repoint = {
        record["id"]: record["mapped"] for group in groups.values() for record in group
    }
    for row_id in repoints:
        bind.execute(
            sa.text(f"UPDATE {table} SET {ref_column} = :ref WHERE id = :id"),  # noqa: S608
            {"ref": winner_repoint[row_id], "id": row_id},
        )


def _phase5_repoint_pins(bind, repoint: dict[str, str]) -> None:
    """``user_pinned_objects``: the unique key covers soft-deleted rows, so a
    repoint can collide with an existing (possibly tombstoned) pin. Keep the
    active row over the soft-deleted one, then the earliest (order_key,
    created_at, id) (map:refs-graph R11)."""

    if not repoint:
        return
    _phase5_dedupe_and_repoint(
        bind,
        table="user_pinned_objects",
        ref_column="object_id",
        scheme_predicate="object_type = 'contributor'",
        load_extra="user_id, surface_key, order_key, created_at, deleted_at",
        group_key=lambda r: (str(r["row"][2]), r["row"][3], r["mapped"]),
        winner_key=lambda r: (r["row"][6] is not None, r["row"][4], r["row"][5], r["id"]),
        repoint=repoint,
    )


def _phase5_repoint_versions(bind, repoint: dict[str, str]) -> None:
    """``resource_versions``: unique per (user, scheme, id, lane). Keep the
    greatest (version, updated_at, id) on collision (spec §8)."""

    if not repoint:
        return
    _phase5_dedupe_and_repoint(
        bind,
        table="resource_versions",
        ref_column="resource_id",
        scheme_predicate="resource_scheme = 'contributor'",
        load_extra="user_id, lane, version, updated_at",
        group_key=lambda r: (str(r["row"][2]), r["mapped"], r["row"][3]),
        # keep the greatest (version, updated_at, id) — descending sort, take [0].
        winner_key=lambda r: (r["row"][4], r["row"][5], r["id"]),
        repoint=repoint,
        reverse=True,
    )


def _phase5_repoint_view_state_pairs(bind, repoint: dict[str, str]) -> None:
    """``resource_view_states`` surface + target contributor pairs. Only the
    surface pair is uniqueness-bearing (per user/surface/edge, edge_id not null);
    keep the latest (updated_at, id). Target is a plain repoint (no unique)."""

    if not repoint:
        return
    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, surface_id, edge_id, updated_at"
            " FROM resource_view_states WHERE surface_scheme = 'contributor'"
        )
    ).fetchall()
    surface_repoints: list[dict] = []
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        old = str(row[2])
        mapped = repoint.get(old, old)
        if row[3] is None:  # no edge -> no uniqueness -> plain repoint
            if mapped != old:
                surface_repoints.append({"id": str(row[0]), "ref": mapped})
            continue
        groups.setdefault((str(row[1]), mapped, str(row[3])), []).append(
            {"id": str(row[0]), "old": old, "mapped": mapped, "updated_at": row[4]}
        )
    for members in groups.values():
        members.sort(key=lambda m: (m["updated_at"], m["id"]), reverse=True)
        winner = members[0]
        for member in members[1:]:
            bind.execute(
                sa.text("DELETE FROM resource_view_states WHERE id = :id"), {"id": member["id"]}
            )
        if winner["mapped"] != winner["old"]:
            surface_repoints.append({"id": winner["id"], "ref": winner["mapped"]})
    for row in surface_repoints:
        bind.execute(
            sa.text("UPDATE resource_view_states SET surface_id = :ref WHERE id = :id"), row
        )
    for old, new in sorted(repoint.items()):
        bind.execute(
            sa.text(
                "UPDATE resource_view_states SET target_id = :new"
                " WHERE target_scheme = 'contributor' AND target_id = :old"
            ),
            {"new": new, "old": old},
        )


def _phase5_repoint_turn_context_subjects(bind, repoint: dict[str, str]) -> None:
    """``chat_run_turn_contexts`` requested/actual subject pairs. One row per run
    (PK is chat_run_id); no collision. ``subject_id`` stays non-null so the
    has-anchor CHECK holds."""

    if not repoint:
        return
    for old, new in sorted(repoint.items()):
        bind.execute(
            sa.text(
                "UPDATE chat_run_turn_contexts SET requested_subject_id = :new"
                " WHERE requested_subject_scheme = 'contributor' AND requested_subject_id = :old"
            ),
            {"new": new, "old": old},
        )
        bind.execute(
            sa.text(
                "UPDATE chat_run_turn_contexts SET subject_id = :new"
                " WHERE subject_scheme = 'contributor' AND subject_id = :old"
            ),
            {"new": new, "old": old},
        )


def _phase5_rebind_view_state_edges(
    bind, dropped_with_winner: dict[str, str], dropped_no_winner: Sequence[str]
) -> None:
    """Rebind ``resource_view_states.edge_id`` off deleted edges (the FK is
    RESTRICT, so this must precede edge deletion). A view state on a winner-less
    removed edge is deleted (runtime edge-cleanup parity); a rebind that collides
    on (user, surface, surface_id, edge_id) keeps the latest (updated_at, id)."""

    for chunk in _chunks(sorted(dropped_no_winner), 500):
        bind.execute(
            sa.text(f"DELETE FROM resource_view_states WHERE edge_id IN {_uuid_list_sql(chunk)}")  # noqa: S608
        )
    if not dropped_with_winner:
        return
    edge_ids = sorted(set(dropped_with_winner) | set(dropped_with_winner.values()))
    rows: list = []
    for chunk in _chunks(edge_ids, 500):
        rows.extend(
            bind.execute(
                sa.text(
                    "SELECT id, user_id, surface_scheme, surface_id, edge_id, updated_at"
                    f" FROM resource_view_states WHERE edge_id IN {_uuid_list_sql(chunk)}"  # noqa: S608
                )
            ).fetchall()
        )
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        current = str(row[4])
        new_edge = dropped_with_winner.get(current, current)
        groups.setdefault((str(row[1]), row[2], str(row[3]), new_edge), []).append(
            {"id": str(row[0]), "current": current, "new_edge": new_edge, "updated_at": row[5]}
        )
    for members in groups.values():
        members.sort(key=lambda m: (m["updated_at"], m["id"]), reverse=True)
        winner = members[0]
        for member in members[1:]:
            bind.execute(
                sa.text("DELETE FROM resource_view_states WHERE id = :id"), {"id": member["id"]}
            )
        if winner["new_edge"] != winner["current"]:
            bind.execute(
                sa.text("UPDATE resource_view_states SET edge_id = :edge WHERE id = :id"),
                {"edge": winner["new_edge"], "id": winner["id"]},
            )


def _phase5_rewrite_edges(bind, repoint: dict[str, str], husks: frozenset[str]) -> dict[str, str]:
    """Rewrite ``resource_edges`` contributor endpoints, remove the self-edges the
    rewrite mints, collapse the four logical edge identities (citation ordinal /
    source order / bare context pair / undirected origin=user pair) keeping the
    earliest (created_at, id), and rebind every edge-id dependent to the winner.

    Loading edges with any contributor endpoint is sufficient to see every
    collision: a post-repoint collision or self-edge requires two edges that
    agree on all endpoints after mapping, and the differing (contributor)
    endpoint maps to the survivor, so both partners carry a contributor endpoint.

    Returns ``{dropped_edge_id: winner_edge_id}`` for the JSON ``context_edge_id``
    rewrite in phase 5.5.
    """

    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, origin, source_scheme, source_id, target_scheme,"
            " target_id, ordinal, source_order_key FROM resource_edges"
            " WHERE source_scheme = 'contributor' OR target_scheme = 'contributor'"
            " ORDER BY created_at, id"
        )
    ).fetchall()
    if not rows:
        return {}

    def _endpoint(scheme: str, raw_id) -> tuple[str, str, bool]:
        sid = str(raw_id)
        if scheme != "contributor":
            return scheme, sid, False
        if sid in husks:
            return scheme, sid, True
        return scheme, repoint.get(sid, sid), False

    kept_identities: dict[tuple, str] = {}
    winner_of: dict[str, str | None] = {}
    endpoint_updates: list[dict] = []
    for row in rows:
        edge_id = str(row[0])
        user, origin = str(row[1]), row[2]
        src_scheme, src_id, src_husk = _endpoint(row[3], row[4])
        tgt_scheme, tgt_id, tgt_husk = _endpoint(row[5], row[6])
        ordinal, source_order_key = row[7], row[8]
        if src_husk or tgt_husk:
            winner_of[edge_id] = None  # husk endpoint -> drop, no winner
            continue
        if src_scheme == tgt_scheme and src_id == tgt_id:
            winner_of[edge_id] = None  # self-edge (CHECK-banned) -> drop, no winner
            continue
        identities: list[tuple] = []
        if ordinal is not None:
            identities.append(("citation", user, src_scheme, src_id, ordinal))
        else:
            identities.append(("bare", user, origin, src_scheme, src_id, tgt_scheme, tgt_id))
            if origin == "user":  # undirected: the reverse pair collides too (§5.4)
                identities.append(("bare", user, origin, tgt_scheme, tgt_id, src_scheme, src_id))
            if source_order_key is not None:
                identities.append(("source_order", user, src_scheme, src_id, source_order_key))
        winner = next((kept_identities[key] for key in identities if key in kept_identities), None)
        if winner is not None:
            winner_of[edge_id] = winner  # earliest (created_at, id) already kept
            continue
        for key in identities:
            kept_identities[key] = edge_id
        if (src_scheme, src_id, tgt_scheme, tgt_id) != (
            row[3],
            str(row[4]),
            row[5],
            str(row[6]),
        ):
            endpoint_updates.append(
                {"id": edge_id, "ss": src_scheme, "si": src_id, "ts": tgt_scheme, "ti": tgt_id}
            )

    dropped_with_winner = {d: w for d, w in winner_of.items() if w is not None}
    dropped_no_winner = sorted(d for d, w in winner_of.items() if w is None)

    if dropped_no_winner:
        for chunk in _chunks(dropped_no_winner, 500):
            blocking = bind.execute(
                sa.text(
                    "SELECT count(*) FROM oracle_reading_folios"  # noqa: S608
                    f" WHERE edge_id IN {_uuid_list_sql(chunk)}"
                )
            ).scalar()
            if blocking:
                _fail(
                    "reference-rewrite",
                    f"{blocking} oracle_reading_folios depend on a removed contributor edge"
                    " with no valid winner (edge_id is REQUIRED and cannot be nulled)",
                )
    for dropped, winner in sorted(dropped_with_winner.items()):
        bind.execute(
            sa.text("UPDATE oracle_reading_folios SET edge_id = :w WHERE edge_id = :d"),
            {"w": winner, "d": dropped},
        )
        bind.execute(
            sa.text("UPDATE message_retrievals SET cited_edge_id = :w WHERE cited_edge_id = :d"),
            {"w": winner, "d": dropped},
        )
        bind.execute(
            sa.text(
                "UPDATE chat_run_turn_contexts SET subject_context_edge_id = :w"
                " WHERE subject_context_edge_id = :d"
            ),
            {"w": winner, "d": dropped},
        )
    for chunk in _chunks(dropped_no_winner, 500):
        # cited_edge_id has no FK; subject_context_edge_id FK is ON DELETE SET NULL.
        bind.execute(
            sa.text(
                "UPDATE message_retrievals SET cited_edge_id = NULL"  # noqa: S608
                f" WHERE cited_edge_id IN {_uuid_list_sql(chunk)}"
            )
        )
    _phase5_rebind_view_state_edges(bind, dropped_with_winner, dropped_no_winner)

    for chunk in _chunks(sorted(winner_of), 500):
        bind.execute(
            sa.text(f"DELETE FROM resource_edges WHERE id IN {_uuid_list_sql(chunk)}")  # noqa: S608
        )
    for update in endpoint_updates:
        bind.execute(
            sa.text(
                "UPDATE resource_edges SET source_scheme = :ss, source_id = :si,"
                " target_scheme = :ts, target_id = :ti WHERE id = :id"
            ),
            update,
        )
    if winner_of or endpoint_updates:
        _report(
            f"reference-rewrite: edges — {len(endpoint_updates)} repointed,"
            f" {len(dropped_with_winner)} collapsed into a winner,"
            f" {len(dropped_no_winner)} self/husk edges removed"
        )
    return dropped_with_winner


def _phase5_rewrite_json_and_scalars(
    bind,
    *,
    repoint: dict[str, str],
    handle_map: dict[str, str],
    edge_map: dict[str, str],
) -> None:
    """Recursive JSON transform over the manifest columns plus the scalar handle /
    deep-link columns. Contributor uuids, handles, ``contributor:`` URIs,
    ``/authors/`` deep links, and collapsed edge ids all rewrite to survivors."""

    if not repoint and not handle_map and not edge_map:
        return
    needles = list(repoint) + list(handle_map) + list(edge_map)
    rewritten_rows = 0
    for table, column in _JSONB_REF_MANIFEST:
        for row_id, value in _phase5_load_json_rows(bind, table, column, needles):
            if isinstance(value, (str, bytes, bytearray)):
                value = json.loads(value)
            rewritten = _phase5_rewrite_ref_json(
                value, uuid_map=repoint, handle_map=handle_map, edge_map=edge_map
            )
            if rewritten != value:
                bind.execute(
                    sa.text(f'UPDATE "{table}" SET "{column}" = CAST(:v AS JSONB) WHERE id = :id'),  # noqa: S608
                    {"v": json.dumps(rewritten), "id": row_id},
                )
                rewritten_rows += 1
    # Scalar handle / deep-link columns carry the handle for contributor rows only
    # (result_type distinguishes them from the uuids every other type stores).
    for old, new in sorted(handle_map.items()):
        bind.execute(
            sa.text(
                "UPDATE message_retrievals SET source_id = :new"
                " WHERE result_type = 'contributor' AND source_id = :old"
            ),
            {"new": new, "old": old},
        )
        bind.execute(
            sa.text(
                "UPDATE message_retrievals SET deep_link = '/authors/' || :new"
                " WHERE result_type = 'contributor' AND deep_link = '/authors/' || :old"
            ),
            {"new": new, "old": old},
        )
        bind.execute(
            sa.text(
                "UPDATE message_retrieval_candidate_ledgers SET source_id = :new"
                " WHERE result_type = 'contributor' AND source_id = :old"
            ),
            {"new": new, "old": old},
        )
    if rewritten_rows:
        _report(f"reference-rewrite: rewrote contributor refs in {rewritten_rows} JSONB rows")


def _phase5_delete_loser_scoped_memos(bind, losers: Sequence[str]) -> None:
    """Delete every ``resource_mutations`` memo whose scope is keyed by a losing
    contributor uuid (``contributor:<uuid>:display-name``). Survivor-scoped memos
    that merely *reference* a loser were rewritten in place above."""

    if not losers:
        return
    deleted = 0
    for chunk in _chunks(sorted(losers), 40):
        conds = " OR ".join(f"mutation_scope LIKE :n{i} || ':%'" for i in range(len(chunk)))
        params = {f"n{i}": f"contributor:{loser}" for i, loser in enumerate(chunk)}
        deleted += bind.execute(
            sa.text(f"DELETE FROM resource_mutations WHERE {conds}"),  # noqa: S608
            params,
        ).rowcount
    if deleted:
        _report(f"reference-rewrite: deleted {deleted} display-name memos for losing contributors")


def _phase5_fail_on_deferred_husk_residue(
    bind, husks: frozenset[str], handle_of: dict[str, str]
) -> None:
    """Late husk fail-loud scan over the two columns the first scan defers.

    ``resource_mutations.response_json`` and ``resource_edges.snapshot`` have
    owning dispositions that run DURING phase 5 (husk-scoped memos are deleted;
    husk-endpoint edges are dropped with their snapshots), so they are scanned
    after those dispositions. Anything still mentioning a husk here is a
    FOREIGN-scoped memo or a foreign edge's snapshot referencing a no-survivor
    contributor — not deterministically repointable or deletable, so it blocks
    cutover BEFORE phase 6's destructive DDL (spec section 8), not as a late
    phase-7 surprise.
    """

    if not husks:
        return
    husk_list = sorted(husks)
    needles = list(husk_list) + [handle_of[h] for h in husk_list if handle_of.get(h)]
    hits = _scan_columns_for_needles(
        bind,
        [("resource_mutations", "response_json"), ("resource_edges", "snapshot")],
        needles,
    )
    if hits:
        _fail(
            "reference-rewrite",
            "husk (no-survivor) contributor still referenced after every owning disposition"
            f" ran; cannot be repointed or safely deleted: {hits}",
        )


def _phase5_rewrite_references(
    bind,
    losers: Sequence[str],
    survivor_of: dict[str, str | None],
    handle_of: dict[str, str],
) -> None:
    """Phase 5 — reference and graph rewrite. M2a OWNS AND FILLS THIS BODY.

    CONTRACT (frozen; the orchestration in ``upgrade()`` and the other phases
    depend on exactly this):

    Inputs
      bind        — the migration connection (``op.get_bind()``); same
                    transaction as every other phase.
      losers      — tuple[str, ...]: lowercase string UUID of every contributor
                    row that phase 6 will DELETE. Their alias / external-id /
                    credit children have already been repointed or removed by
                    phases 2-4; only graph/JSON/polymorphic/memo references
                    remain.
      survivor_of — dict[str, str | None]: loser uuid -> retained survivor
                    uuid. ``None`` means "no retained survivor exists": every
                    reference to that loser must be DELETED (the suppression
                    treatment), never repointed.
      handle_of   — dict[str, str]: uuid -> handle for every contributor that
                    existed at phase-2 start. Losers appear with their old
                    (pre-deletion) handles; survivors keep their handles
                    (survivor handles never change in this migration). The
                    rewrite for a loser L with survivor S therefore is:
                    uuid L -> S; handle handle_of[L] -> handle_of[S];
                    deep link '/authors/{handle_of[L]}' -> '/authors/{handle_of[S]}';
                    URI 'contributor:L' -> 'contributor:S'.

    Obligations (plan S2 phase 5; spec section 8; D-18):
      * polymorphic UUID pairs: ``user_pinned_objects`` (delete the tombstoned
        duplicate before repointing into a unique collision),
        ``resource_versions`` (keep greatest (version, updated_at, id) per
        user/lane), ``resource_view_states`` (surface + target pairs; keep
        latest (updated_at, id) on collision), ``chat_run_turn_contexts``
        (both subject pairs), ``resource_edges`` (both endpoints);
      * ``synapse_suppressions`` rows with a losing endpoint: DELETE + report
        count (explicit exemption — never broaden a negative pair);
      * recursive JSON transform over the manifest columns (incl.
        ``resource_edges.snapshot``, note-block PM ``object_ref``/
        ``object_embed`` nodes, 'contributor:<uuid>' URI strings,
        ``context_edge_id`` edge-uuid rebinds inside prompt assemblies and
        meta events, tool_result ``filters`` handle arrays, and podcast
        ``result_ref.contributors[*]`` credit blobs);
      * scalar columns: ``message_retrievals.source_id`` / ``deep_link`` and
        candidate-ledger ``source_id`` for ``result_type = 'contributor'``;
      * delete ``resource_mutations`` memos whose scope keys a losing
        contributor uuid (after rewriting typed response refs);
      * then: remove self-edges created by endpoint rewrites, collapse logical
        edge collisions (citation / source-order / bare pair / undirected
        origin=user rule) keeping earliest (created_at, id), and rebind the
        dependent edge-id consumers — ``resource_view_states.edge_id``,
        ``chat_run_turn_contexts.subject_context_edge_id`` (null only for a
        removed self-edge with no winner), ``oracle_reading_folios.edge_id``
        (REQUIRED: no valid winner aborts via RuntimeError),
        ``message_retrievals.cited_edge_id`` (nullable telemetry), and typed
        edge ids in chat-run event payloads;
      * unknown contributor-ref shapes inside manifest columns are a
        RuntimeError, never a best-effort skip.

    Runs AFTER credit salvage (phase 4) and BEFORE loser deletion/destructive
    DDL (phase 6). Phase 7 re-scans the manifest for loser residue, so any
    missed rewrite fails the migration (and rolls back everything).
    """

    if not _phase5_rewrite_work_exists(bind, losers, handle_of):
        # No loser is referenced by any owner: nothing to rewrite, no collision
        # is possible, and self-edges are CHECK-banned. This is also the entire
        # production path — every reference owner is empty on prod (S0 preflight).
        return

    repoint = {loser: survivor for loser, survivor in survivor_of.items() if survivor is not None}
    husks = frozenset(loser for loser, survivor in survivor_of.items() if survivor is None)
    handle_map: dict[str, str] = {}
    for loser, survivor in repoint.items():
        loser_handle = handle_of.get(loser)
        survivor_handle = handle_of.get(survivor)
        if loser_handle and survivor_handle:
            handle_map[loser_handle] = survivor_handle

    # 1. Husks (no retained survivor): delete clean references, fail loud on the
    #    unerasable ones. Everything after this repoints repointable losers only.
    _phase5_purge_husk_references(bind, husks, handle_of)
    # 2. Suppression exemption: delete losing-endpoint rows outright.
    _phase5_delete_suppressions(bind, losers)
    # 3. Polymorphic UUID pairs -> survivors (with per-owner collision rules).
    _phase5_repoint_pins(bind, repoint)
    _phase5_repoint_versions(bind, repoint)
    _phase5_repoint_view_state_pairs(bind, repoint)
    _phase5_repoint_turn_context_subjects(bind, repoint)
    # 4. Edge endpoints -> survivors, self-edge removal, 4-identity collision
    #    collapse, and dependent edge-id rebinds. Returns dropped -> winner for 5.
    edge_map = _phase5_rewrite_edges(bind, repoint, husks)
    # 5. Nested JSON transform + scalar handle/deep-link columns (contributor
    #    uuids, handles, contributor:/authors deep links, and collapsed edge ids).
    _phase5_rewrite_json_and_scalars(
        bind, repoint=repoint, handle_map=handle_map, edge_map=edge_map
    )
    # 6. Drop display-name memos scoped to a losing contributor (post ref rewrite).
    _phase5_delete_loser_scoped_memos(bind, losers)
    # 7. Deferred husk fail-loud scan: response_json / snapshot are checked only
    #    now, after their owning dispositions (husk-edge drop / loser-scope memo
    #    delete) have run — any residue is unerasable and blocks before phase 6.
    _phase5_fail_on_deferred_husk_residue(bind, husks, handle_of)


# ---------------------------------------------------------------------------
# Phase 6 — destructive DDL + cleanup
# ---------------------------------------------------------------------------


def _phase6_destructive_ddl(bind, collapse: _CollapseResult, manual_media_ids: set[str]) -> None:
    # 6.1 Reconciliation job rows (every state), then the reconciliation/event
    # tables — they hold five FKs into contributors and MUST drop before loser
    # deletion (candidates first: FK run_id -> runs).
    deleted_jobs = bind.execute(
        sa.text("DELETE FROM background_jobs WHERE kind = 'contributor_reconciliation'")
    ).rowcount
    if deleted_jobs:
        _report(f"cleanup: deleted {deleted_jobs} contributor_reconciliation job rows")
    op.execute("DROP TABLE contributor_reconciliation_candidates")
    op.execute("DROP TABLE contributor_reconciliation_runs")
    op.execute("DROP TABLE contributor_identity_events")

    # 6.2 Loser deletion. Children were repointed/removed in phases 2-4; the
    # residual DELETEs are defensive and must find nothing new.
    if collapse.losers:
        loser_list = _uuid_list_sql(collapse.losers)
        bind.execute(
            sa.text(f"DELETE FROM contributor_aliases WHERE contributor_id IN {loser_list}")  # noqa: S608
        )
        bind.execute(
            sa.text(f"DELETE FROM contributor_external_ids WHERE contributor_id IN {loser_list}")  # noqa: S608
        )
        credit_count = bind.execute(
            sa.text(
                f"SELECT count(*) FROM contributor_credits WHERE contributor_id IN {loser_list}"  # noqa: S608
            )
        ).scalar()
        if credit_count:
            _fail("cleanup", f"{credit_count} credits still reference losing contributors")
        bind.execute(sa.text(f"DELETE FROM contributors WHERE id IN {loser_list}"))  # noqa: S608

    # 6.3 contributors: final five-column shape (D-19/D-20).
    op.execute("DROP INDEX ix_contributors_sort_name")
    op.execute("ALTER TABLE contributors DROP CONSTRAINT ck_contributors_kind")
    op.execute("ALTER TABLE contributors DROP CONSTRAINT ck_contributors_status")
    op.execute(
        "ALTER TABLE contributors"
        " DROP COLUMN sort_name, DROP COLUMN kind, DROP COLUMN status,"
        " DROP COLUMN disambiguation, DROP COLUMN merged_into_contributor_id,"
        " DROP COLUMN merged_at"
    )

    # 6.4 contributor_aliases: recompute normalized_alias with the frozen match
    # key over final literals, then constraints/indexes, then dead columns.
    recompute_alias = sa.text("UPDATE contributor_aliases SET normalized_alias = :n WHERE id = :id")
    for row in bind.execute(
        sa.text("SELECT id, alias, normalized_alias FROM contributor_aliases")
    ).fetchall():
        normalized = _contributor_match_key(row[1])
        if normalized != row[2]:
            bind.execute(recompute_alias, {"n": normalized, "id": str(row[0])})
    duplicate = bind.execute(
        sa.text(
            "SELECT contributor_id, normalized_alias FROM contributor_aliases"
            " GROUP BY contributor_id, normalized_alias HAVING count(*) > 1 LIMIT 5"
        )
    ).fetchall()
    if duplicate:
        _fail("cleanup", f"duplicate (contributor_id, normalized_alias) after dedupe: {duplicate}")
    op.execute("ALTER TABLE contributor_aliases DROP CONSTRAINT ck_contributor_aliases_kind")
    op.execute(
        "ALTER TABLE contributor_aliases"
        " DROP COLUMN sort_name, DROP COLUMN alias_kind, DROP COLUMN locale,"
        " DROP COLUMN script, DROP COLUMN source, DROP COLUMN confidence,"
        " DROP COLUMN is_primary"
    )
    op.execute("ALTER TABLE contributor_aliases ALTER COLUMN resolves_identity SET NOT NULL")
    op.execute(
        "ALTER TABLE contributor_aliases ADD CONSTRAINT uq_contributor_aliases_owner_normalized"
        " UNIQUE (contributor_id, normalized_alias)"
    )
    op.execute(
        "CREATE INDEX ix_contributor_aliases_resolution ON contributor_aliases"
        " (normalized_alias, resolves_identity, contributor_id)"
    )
    op.execute("DROP INDEX ix_contributor_aliases_normalized_alias")

    # 6.5 contributor_credits: recompute normalized_credited_name, drop dead
    # CHECKs/columns/indexes, create the six final partial uniques (D-33).
    recompute_credit = sa.text(
        "UPDATE contributor_credits SET normalized_credited_name = :n WHERE id = :id"
    )
    for row in bind.execute(
        sa.text("SELECT id, credited_name, normalized_credited_name FROM contributor_credits")
    ).fetchall():
        normalized = _contributor_match_key(row[1])
        if normalized != row[2]:
            bind.execute(recompute_credit, {"n": normalized, "id": str(row[0])})
    for name in (
        "ck_contributor_credits_role",
        "ck_contributor_credits_resolution_status",
        "ck_contributor_credits_source_ref",
        "ck_contributor_credits_ordinal",
        "ck_contributor_credits_one_target",
    ):
        op.execute(f"ALTER TABLE contributor_credits DROP CONSTRAINT {name}")
    op.execute(
        "ALTER TABLE contributor_credits"
        " DROP COLUMN source_ref, DROP COLUMN resolution_status, DROP COLUMN confidence"
    )
    op.execute("DROP INDEX ix_contributor_credits_media_id")
    op.execute("DROP INDEX ix_contributor_credits_podcast_id")
    op.execute("DROP INDEX ix_contributor_credits_gutenberg_ebook_id")
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_media_ordinal ON contributor_credits"
        " (media_id, ordinal) WHERE media_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_media_contributor_role"
        " ON contributor_credits (media_id, contributor_id, role) WHERE media_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_podcast_ordinal ON contributor_credits"
        " (podcast_id, ordinal) WHERE podcast_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_podcast_contributor_role"
        " ON contributor_credits (podcast_id, contributor_id, role) WHERE podcast_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_gutenberg_ordinal ON contributor_credits"
        " (project_gutenberg_catalog_ebook_id, ordinal)"
        " WHERE project_gutenberg_catalog_ebook_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_contributor_credits_gutenberg_contributor_role"
        " ON contributor_credits (project_gutenberg_catalog_ebook_id, contributor_id, role)"
        " WHERE project_gutenberg_catalog_ebook_id IS NOT NULL"
    )

    # 6.6 media manual-pin flag (+ phase-4 salvage flags).
    op.execute(
        "ALTER TABLE media ADD COLUMN authors_manually_managed BOOLEAN NOT NULL DEFAULT false"
    )
    for chunk in _chunks(sorted(manual_media_ids), 500):
        bind.execute(
            sa.text(
                "UPDATE media SET authors_manually_managed = true"
                f" WHERE id IN {_uuid_list_sql(chunk)}"  # noqa: S608
            )
        )


# ---------------------------------------------------------------------------
# Phase 7 — postconditions (assert-or-raise; the transaction rolls back on failure)
# ---------------------------------------------------------------------------


def _phase7_postconditions(bind, collapse: _CollapseResult) -> None:
    def _check(condition: bool, message: str) -> None:
        if not condition:
            _fail("postcondition", message)

    # Structural absence: reconciliation/event tables, dead columns, dead
    # constraints, dead indexes.
    for table in (
        "contributor_reconciliation_candidates",
        "contributor_reconciliation_runs",
        "contributor_identity_events",
    ):
        _check(not _table_exists(bind, table), f"table {table} still exists")
    for table, column in (
        ("contributors", "sort_name"),
        ("contributors", "kind"),
        ("contributors", "status"),
        ("contributors", "disambiguation"),
        ("contributors", "merged_into_contributor_id"),
        ("contributors", "merged_at"),
        ("contributor_aliases", "sort_name"),
        ("contributor_aliases", "alias_kind"),
        ("contributor_aliases", "locale"),
        ("contributor_aliases", "script"),
        ("contributor_aliases", "source"),
        ("contributor_aliases", "confidence"),
        ("contributor_aliases", "is_primary"),
        ("contributor_external_ids", "external_url"),
        ("contributor_external_ids", "source"),
        ("contributor_credits", "source_ref"),
        ("contributor_credits", "resolution_status"),
        ("contributor_credits", "confidence"),
    ):
        _check(not _column_exists(bind, table, column), f"column {table}.{column} still exists")
    for table, name in (
        ("contributors", "ck_contributors_kind"),
        ("contributors", "ck_contributors_status"),
        ("contributor_aliases", "ck_contributor_aliases_kind"),
        ("contributor_external_ids", "ck_contributor_external_ids_authority"),
        ("contributor_credits", "ck_contributor_credits_role"),
        ("contributor_credits", "ck_contributor_credits_resolution_status"),
        ("contributor_credits", "ck_contributor_credits_source_ref"),
        ("contributor_credits", "ck_contributor_credits_ordinal"),
        ("contributor_credits", "ck_contributor_credits_one_target"),
    ):
        _check(not _constraint_exists(bind, table, name), f"constraint {name} still exists")
    for name in (
        "ix_contributors_sort_name",
        "ix_contributor_aliases_normalized_alias",
        "ix_contributor_credits_media_id",
        "ix_contributor_credits_podcast_id",
        "ix_contributor_credits_gutenberg_ebook_id",
    ):
        _check(not _index_exists(bind, name), f"index {name} still exists")

    # Structural presence: final constraints/indexes/columns.
    _check(
        _constraint_exists(bind, "contributor_aliases", "uq_contributor_aliases_owner_normalized"),
        "uq_contributor_aliases_owner_normalized missing",
    )
    for name in (
        "ix_contributor_aliases_resolution",
        "ix_contributor_aliases_contributor_id",
        "ix_contributor_external_ids_contributor_id",
        "ix_contributor_credits_contributor_id",
        "uq_contributor_credits_media_ordinal",
        "uq_contributor_credits_media_contributor_role",
        "uq_contributor_credits_podcast_ordinal",
        "uq_contributor_credits_podcast_contributor_role",
        "uq_contributor_credits_gutenberg_ordinal",
        "uq_contributor_credits_gutenberg_contributor_role",
    ):
        _check(_index_exists(bind, name), f"index {name} missing")
    flag_shape = bind.execute(
        sa.text(
            "SELECT is_nullable, column_default FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'media'"
            " AND column_name = 'authors_manually_managed'"
        )
    ).fetchone()
    _check(
        flag_shape is not None
        and flag_shape[0] == "NO"
        and (flag_shape[1] or "").startswith("false"),
        "media.authors_manually_managed missing or not NOT NULL DEFAULT false",
    )
    _check(
        _column_exists(bind, "contributor_aliases", "resolves_identity"),
        "contributor_aliases.resolves_identity missing",
    )
    _check(
        bind.execute(
            sa.text(
                "SELECT count(*) FROM background_jobs WHERE kind = 'contributor_reconciliation'"
            )
        ).scalar()
        == 0,
        "contributor_reconciliation job rows remain",
    )

    # Every legacy loser is gone; every final contributor is a survivor with a
    # canonical display, a grammar-valid non-reserved handle, and a resolving
    # display alias; no address/URL/key in display or alias text (privacy).
    contributor_rows = bind.execute(
        sa.text("SELECT id, handle, display_name FROM contributors")
    ).fetchall()
    final_ids = {str(row[0]) for row in contributor_rows}
    leftover_losers = final_ids & set(collapse.losers)
    _check(not leftover_losers, f"losing contributors survived deletion: {sorted(leftover_losers)}")
    external_key_literals = {
        row[0]
        for row in bind.execute(
            sa.text("SELECT external_key FROM contributor_external_ids")
        ).fetchall()
    }
    resolving_norms: dict[str, set[str]] = {}
    for row in bind.execute(
        sa.text(
            "SELECT contributor_id, alias, normalized_alias, resolves_identity"
            " FROM contributor_aliases"
        )
    ).fetchall():
        owner, alias, normalized, resolving = str(row[0]), row[1], row[2], row[3]
        _check(owner in final_ids, f"alias owner {owner} does not exist")
        _check(
            _clean_contributor_display(alias) == alias,
            f"alias literal not display-clean for contributor {owner}: {alias!r}",
        )
        _check(
            _contributor_match_key(alias) == normalized,
            f"normalized_alias is not the frozen match key for contributor {owner}",
        )
        _check(
            not (_contains_email(alias) or _contains_url(alias) or alias in external_key_literals),
            f"privacy: alias text carries an address/URL/key for contributor {owner}",
        )
        if resolving:
            resolving_norms.setdefault(owner, set()).add(normalized)
    for row in contributor_rows:
        cid, handle, display = str(row[0]), row[1], row[2]
        _check(_is_valid_contributor_handle(handle), f"handle {handle!r} violates the grammar")
        _check(bool(display) and len(display) <= _MAX_NAME_CODE_POINTS, f"display bounds: {cid}")
        _check(
            _clean_contributor_display(display) == display,
            f"display not a clean-display fixpoint: {cid}",
        )
        _check(
            not (
                _contains_email(display)
                or _contains_url(display)
                or display in external_key_literals
            ),
            f"privacy: display text carries an address/URL/key: {cid}",
        )
        _check(
            _contributor_match_key(display) in resolving_norms.get(cid, set()),
            f"display of {cid} has no resolving alias",
        )

    # Authority vocabulary final + canonical-key fixpoint + ownership.
    for row in bind.execute(
        sa.text("SELECT contributor_id, authority, external_key FROM contributor_external_ids")
    ).fetchall():
        owner, authority, key = str(row[0]), row[1], row[2]
        _check(owner in final_ids, f"external id owner {owner} does not exist")
        _check(authority in _FINAL_AUTHORITIES, f"legacy authority survived: {authority}")
        _check(
            _canonicalize_identity_key(authority, key) == key,
            f"external key not canonical: ({authority}, contributor {owner})",
        )

    # Credits: ownership, one target, role vocabulary, cleaned literals,
    # frozen normalized values, dense per-target ordinals, per-role cap, no
    # duplicate (contributor, role) per target.
    credit_rows = bind.execute(
        sa.text(
            "SELECT contributor_id, media_id, podcast_id, project_gutenberg_catalog_ebook_id,"
            " credited_name, normalized_credited_name, role, raw_role, ordinal"
            " FROM contributor_credits"
        )
    ).fetchall()
    per_target_ordinals: dict[tuple, list[int]] = {}
    per_target_role_counts: dict[tuple, dict[str, int]] = {}
    per_target_pairs: dict[tuple, set[tuple[str, str]]] = {}
    for row in credit_rows:
        owner = str(row[0])
        _check(owner in final_ids, f"credit owner {owner} does not exist")
        targets = [value for value in (row[1], row[2], row[3]) if value is not None]
        _check(len(targets) == 1, "credit row without exactly one target")
        target = (
            "media" if row[1] is not None else "podcast" if row[2] is not None else "gutenberg",
            str(targets[0]),
        )
        credited, normalized, role, raw_role, ordinal = row[4], row[5], row[6], row[7], row[8]
        _check(role in _ROLE_ORDER, f"unknown credit role {role!r}")
        _check(
            bool(credited) and len(credited) <= _MAX_NAME_CODE_POINTS,
            f"credited_name bounds on target {target}",
        )
        _check(
            _clean_contributor_display(credited) == credited,
            f"credited_name not display-clean on target {target}",
        )
        _check(
            _contributor_match_key(credited) == normalized,
            f"normalized_credited_name is not the frozen match key on target {target}",
        )
        _check(
            raw_role is None or (0 < len(raw_role) <= _MAX_RAW_ROLE_LENGTH),
            f"raw_role bounds on target {target}",
        )
        per_target_ordinals.setdefault(target, []).append(ordinal)
        per_target_role_counts.setdefault(target, {}).setdefault(role, 0)
        per_target_role_counts[target][role] += 1
        pair = (owner, role)
        pairs = per_target_pairs.setdefault(target, set())
        _check(pair not in pairs, f"duplicate (contributor, role) on target {target}")
        pairs.add(pair)
    for target, ordinals in per_target_ordinals.items():
        _check(
            sorted(ordinals) == list(range(len(ordinals))),
            f"ordinals not dense on target {target}: {sorted(ordinals)}",
        )
    for target, role_counts in per_target_role_counts.items():
        for role, count in role_counts.items():
            _check(
                count <= _MAX_CREDITS_PER_MANAGED_ROLE,
                f"role slice over cap on target {target}: {role} x {count}",
            )

    # Graph identity validity: contributor endpoints and polymorphic refs
    # point at surviving contributors; no self edges; contributor-scoped memos
    # key existing contributors.
    id_list = _uuid_list_sql(final_ids) if final_ids else "('00000000-0000-0000-0000-000000000000')"
    graph_probes = (
        (
            "resource_edges endpoints",
            "SELECT count(*) FROM resource_edges WHERE (source_scheme = 'contributor'"
            f" AND source_id NOT IN {id_list}) OR (target_scheme = 'contributor'"
            f" AND target_id NOT IN {id_list})",
        ),
        (
            "self edges",
            "SELECT count(*) FROM resource_edges"
            " WHERE source_scheme = target_scheme AND source_id = target_id",
        ),
        (
            "user_pinned_objects",
            "SELECT count(*) FROM user_pinned_objects WHERE object_type = 'contributor'"
            f" AND object_id NOT IN {id_list}",
        ),
        (
            "resource_versions",
            "SELECT count(*) FROM resource_versions WHERE resource_scheme = 'contributor'"
            f" AND resource_id NOT IN {id_list}",
        ),
        (
            "resource_view_states",
            "SELECT count(*) FROM resource_view_states WHERE (surface_scheme = 'contributor'"
            f" AND surface_id NOT IN {id_list}) OR (target_scheme = 'contributor'"
            f" AND target_id NOT IN {id_list})",
        ),
        (
            "chat_run_turn_contexts",
            "SELECT count(*) FROM chat_run_turn_contexts"
            " WHERE (requested_subject_scheme = 'contributor'"
            f" AND requested_subject_id NOT IN {id_list}) OR (subject_scheme = 'contributor'"
            f" AND subject_id NOT IN {id_list})",
        ),
        (
            "synapse_suppressions",
            "SELECT count(*) FROM synapse_suppressions WHERE (source_scheme = 'contributor'"
            f" AND source_id NOT IN {id_list}) OR (target_scheme = 'contributor'"
            f" AND target_id NOT IN {id_list})",
        ),
    )
    for label, probe in graph_probes:
        count = bind.execute(sa.text(probe)).scalar()
        _check(count == 0, f"{label}: {count} rows reference non-surviving contributors")
    # Only scopes keyed by a contributor THIS migration deleted are residue; a
    # scope keying an id that never was a contributor is pre-existing junk data
    # outside this migration's contract, never a reason to abort the cutover.
    loser_set = set(collapse.losers)
    for row in bind.execute(
        sa.text(
            "SELECT mutation_scope FROM resource_mutations WHERE mutation_scope LIKE"
            " 'contributor:%'"
        )
    ).fetchall():
        parts = row[0].split(":")
        _check(
            len(parts) < 2 or parts[1] not in loser_set,
            f"memo scope keys a losing contributor: {row[0]}",
        )

    # Full reference-manifest re-scan (shared scanner; incl. resource_edges.
    # snapshot and the scalar handle/deep-link columns): no losing UUID,
    # handle, or deep link anywhere. Scalar source_id columns additionally get
    # exact BARE-handle probes — the quoted/deep-link needles cannot see them.
    if collapse.losers:
        needles: list[str] = list(collapse.losers)
        for loser in collapse.losers:
            handle = collapse.handle_of.get(loser)
            if handle:
                needles.append(f'"{handle}"')
                needles.append(f"/authors/{handle}")
        hits = _scan_columns_for_needles(
            bind,
            list(_JSONB_REF_MANIFEST)
            + list(_SCALAR_REF_COLUMNS)
            + [
                ("resource_mutations", "mutation_scope"),
            ],
            needles,
        )
        hits += _scan_contributor_source_id_residue(
            bind,
            (
                collapse.handle_of[loser]
                for loser in collapse.losers
                if collapse.handle_of.get(loser)
            ),
        )
        _check(not hits, f"losing contributor residue in reference owners: {hits}")

    _report("postconditions: all checks passed")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def upgrade() -> None:
    bind = op.get_bind()
    _phase1_preflight(bind)
    collapse = _phase2_identity_collapse(bind)
    _phase3_authority_migration(bind, collapse)
    manual_media_ids = _phase4_credit_salvage(bind, collapse)
    _phase5_rewrite_references(bind, collapse.losers, collapse.survivor_of, collapse.handle_of)
    _phase6_destructive_ddl(bind, collapse, manual_media_ids)
    _phase7_postconditions(bind, collapse)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0179 is not reversible")
