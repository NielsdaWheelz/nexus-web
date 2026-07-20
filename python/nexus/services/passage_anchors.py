"""Passage-anchor identity and materialization.

Sole owner of user-owned durable passage identity
(universal-link-authoring-hard-cutover.md, Passage Anchor). An anchor's owner,
selector version, normalized quote, and ``anchor_key`` are immutable; only the
selector's ``locator_hint`` is replaceable. There is no persisted resolution
status, daemon, or current-row pointer — current locators are resolved LIVE
against owner text through the shared ``locator_resolver``.

Quote normalization (identity space): Unicode NFC; CRLF/CR -> LF; every Unicode
whitespace run -> one U+0020; trimmed ends. ``anchor_key`` is sha256 over the
canonical JSON of ``{exact, prefix, suffix}`` only (sorted keys, UTF-8, compact
separators); locator hints never enter it. The server recomputes prefix/suffix
from current owner text as the nearest 64 normalized Unicode scalars per side,
so caller context-window length never changes identity.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import PassageAnchor
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services import locator_resolver, text_quote
from nexus.services.text_quote import QuoteStatus

SELECTOR_VERSION = 1

PASSAGE_ANCHOR_OWNER_SCHEMES = ("media", "note_block")

_QUAD_KEYS = ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4")


def normalize_quote_text(text: str) -> str:
    """Canonical quote normalization: NFC, whitespace runs -> U+0020, trimmed."""
    return text_quote.normalize_for_match(text).text.strip()


def compute_anchor_key(*, exact: str, prefix: str, suffix: str) -> str:
    """sha256 hex over canonical JSON of the already-normalized quote identity."""
    canonical = json.dumps(
        {"exact": exact, "prefix": prefix, "suffix": suffix},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def canonical_locator_hint(hint: dict[str, Any] | None) -> dict[str, Any] | None:
    """Validate and canonically encode a replaceable locator hint.

    Locator integers are base-10 ints; non-integral geometry becomes a fixed
    decimal string without exponent or trailing zero. Hints never enter
    ``anchor_key``.
    """
    if hint is None:
        return None
    kind = hint.get("kind")
    if kind == "text":
        out: dict[str, Any] = {"kind": "text"}
        if hint.get("fragment_id") is not None:
            out["fragment_id"] = str(hint["fragment_id"])
        if hint.get("section_id") is not None:
            out["section_id"] = str(hint["section_id"])
        out["start_offset"] = _canonical_int(hint.get("start_offset"), field="start_offset")
        out["end_offset"] = _canonical_int(hint.get("end_offset"), field="end_offset")
        return out
    if kind == "pdf":
        raw_quads = hint.get("quads")
        quads = [
            {key: _canonical_geometry(quad.get(key), field=key) for key in _QUAD_KEYS}
            for quad in (raw_quads if isinstance(raw_quads, list) else [])
        ]
        out = {
            "kind": "pdf",
            "page_number": _canonical_int(hint.get("page_number"), field="page_number"),
        }
        if quads:
            out["quads"] = quads
        return out
    if kind == "time":
        return {
            "kind": "time",
            "t_start_ms": _canonical_int(hint.get("t_start_ms"), field="t_start_ms"),
            "t_end_ms": _canonical_int(hint.get("t_end_ms"), field="t_end_ms"),
        }
    raise InvalidRequestError(message=f"Unknown locator hint kind: {kind!r}")


def _canonical_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidRequestError(message=f"Locator hint {field} must be a number")
    if isinstance(value, float):
        if not value.is_integer():
            raise InvalidRequestError(message=f"Locator hint {field} must be an integer")
        value = int(value)
    if value < 0:
        raise InvalidRequestError(message=f"Locator hint {field} must be non-negative")
    return value


def _canonical_geometry(value: Any, *, field: str) -> int | str:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidRequestError(message=f"Locator hint quad {field} must be a number")
    if isinstance(value, int) or value.is_integer():
        return int(value)
    return format(Decimal(repr(value)).normalize(), "f")


def materialize_or_reuse(
    db: Session,
    *,
    user_id: UUID,
    owner_scheme: str,
    owner_id: UUID,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    locator_hint: dict[str, Any] | None = None,
) -> PassageAnchor:
    """Create or reuse the passage anchor for a quote within one owner.

    The normalized quote must resolve uniquely within its owner via the shared
    resolver before create/reuse; empty, ambiguous, or unmatched quotes are a
    typed refusal, and locator geometry never disambiguates identity. Reuse
    refreshes only the replaceable ``locator_hint``. Flush-only: composes
    inside the caller-owned (retryable) transaction, whose retry allowlist
    covers the ``uq_passage_anchors_identity`` first-insert race.
    """
    if owner_scheme not in PASSAGE_ANCHOR_OWNER_SCHEMES:
        raise AssertionError(  # justify-defect: callers pass the closed media|note_block set
            f"Invalid passage-anchor owner scheme: {owner_scheme!r}"
        )

    quote_exact = normalize_quote_text(exact)
    quote_prefix = normalize_quote_text(prefix or "")
    quote_suffix = normalize_quote_text(suffix or "")
    hint = canonical_locator_hint(locator_hint)

    resolution = locator_resolver.resolve_passage_selector(
        db,
        owner_scheme=owner_scheme,
        owner_id=owner_id,
        exact=quote_exact,
        prefix=quote_prefix,
        suffix=quote_suffix,
        locator_hint=hint,
    )
    if resolution.status is not QuoteStatus.unique:
        raise ApiError(
            ApiErrorCode.E_LINK_TARGET_AMBIGUOUS,
            _REFUSAL_MESSAGES[resolution.status],
        )

    anchor_key = compute_anchor_key(
        exact=quote_exact, prefix=resolution.prefix, suffix=resolution.suffix
    )
    existing = db.execute(
        select(PassageAnchor).where(
            PassageAnchor.user_id == user_id,
            PassageAnchor.owner_scheme == owner_scheme,
            PassageAnchor.owner_id == owner_id,
            PassageAnchor.selector_version == SELECTOR_VERSION,
            PassageAnchor.anchor_key == anchor_key,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.selector.get("locator_hint") != resolution.locator:
            existing.selector = {**existing.selector, "locator_hint": resolution.locator}
            db.flush()
        return existing

    anchor = PassageAnchor(
        id=uuid4(),
        user_id=user_id,
        owner_scheme=owner_scheme,
        owner_id=owner_id,
        selector_version=SELECTOR_VERSION,
        anchor_key=anchor_key,
        selector={
            "quote": {
                "exact": quote_exact,
                "prefix": resolution.prefix,
                "suffix": resolution.suffix,
            },
            "locator_hint": resolution.locator,
        },
    )
    db.add(anchor)
    db.flush()
    return anchor


_REFUSAL_MESSAGES = {
    QuoteStatus.empty_exact: "Passage quote is empty",
    QuoteStatus.ambiguous: "Passage quote is ambiguous within its owner",
    QuoteStatus.no_match: "Passage quote was not found in its owner",
}


@dataclass(frozen=True, slots=True)
class PassageAnchorLocation:
    """Live current-locator resolution of one anchor (nothing persisted)."""

    anchor_id: UUID
    owner_scheme: str
    owner_id: UUID
    exact: str
    resolved: bool
    locator: dict[str, Any] | None


def resolve_current_location(
    db: Session,
    *,
    viewer_id: UUID,
    passage_anchor_id: UUID,
) -> PassageAnchorLocation | None:
    """Resolve an anchor's quote against current owner text for reader use.

    Fail-closed: returns ``None`` for a missing or non-viewer-owned anchor, and
    ``resolved=False`` (no locator) when the quote no longer resolves uniquely
    — the anchor stays durable but unresolved; it is never mapped to a wrong
    location.
    """
    anchor = db.get(PassageAnchor, passage_anchor_id)
    if anchor is None or anchor.user_id != viewer_id:
        return None
    quote = anchor.selector.get("quote")
    if not isinstance(quote, dict):
        raise AssertionError(  # justify-defect: selector shape is service-owned at write time
            f"Passage anchor {anchor.id} selector has no quote"
        )
    exact = str(quote.get("exact") or "")
    raw_hint = anchor.selector.get("locator_hint")
    resolution = locator_resolver.resolve_passage_selector(
        db,
        owner_scheme=anchor.owner_scheme,
        owner_id=anchor.owner_id,
        exact=exact,
        prefix=str(quote.get("prefix") or ""),
        suffix=str(quote.get("suffix") or ""),
        locator_hint=raw_hint if isinstance(raw_hint, dict) else None,
    )
    resolved = resolution.status is QuoteStatus.unique
    return PassageAnchorLocation(
        anchor_id=anchor.id,
        owner_scheme=anchor.owner_scheme,
        owner_id=anchor.owner_id,
        exact=exact,
        resolved=resolved,
        locator=resolution.locator if resolved else None,
    )
