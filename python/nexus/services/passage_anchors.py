"""Passage-anchor quote normalization and server materialization.

A passage is authored state: its permanent semantic binding and literal capture live
in ``authored_passages`` and ``passage_anchors`` is their projection. An anchor's
owner, normalized quote and ``anchor_key`` are immutable and survive their owner's
deletion. There is no persisted resolution status, daemon, or current-row pointer —
current locators are resolved LIVE against owner text through the shared
``locator_resolver``.

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
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import XPostSource
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services import authored, library_entries, locator_resolver, text_quote
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.text_quote import QuoteStatus

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
) -> ResourceRef:
    """Capture or reuse the authored passage for a quote within one owner.

    The normalized quote must resolve uniquely within its owner via the shared
    resolver; empty, ambiguous, or unmatched quotes are a typed refusal, and locator
    geometry never disambiguates identity. The semantic owner resolves the permanent
    binding or mints its identity and stamps the literal quote capture; its projection
    writes the ``passage_anchors`` row. Flush-only inside the caller's transaction:
    the account head precedes the post's media family lock, as in every authored writer.
    """
    if owner_scheme not in PASSAGE_ANCHOR_OWNER_SCHEMES:
        raise AssertionError(  # justify-defect: callers pass the closed media|note_block set
            f"Invalid passage-anchor owner scheme: {owner_scheme!r}"
        )
    authored.lock_account(db, user_id)

    if (
        owner_scheme == "media"
        and db.scalar(select(XPostSource.id).where(XPostSource.media_id == owner_id)) is not None
    ):
        library_entries.lock_media_for_reference(db, owner_id)
        if not can_read_media(db, user_id, owner_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    quote_exact = normalize_quote_text(exact)
    resolution = locator_resolver.resolve_passage_selector(
        db,
        owner_scheme=owner_scheme,
        owner_id=owner_id,
        exact=quote_exact,
        prefix=normalize_quote_text(prefix or ""),
        suffix=normalize_quote_text(suffix or ""),
        locator_hint=canonical_locator_hint(locator_hint),
    )
    if resolution.status is not QuoteStatus.unique:
        raise ApiError(
            ApiErrorCode.E_LINK_TARGET_AMBIGUOUS,
            _REFUSAL_MESSAGES[resolution.status],
        )
    result = authored.server_command(
        db,
        user_id,
        command={
            "kind": "capture_passage",
            "anchor_id": None,
            "source_ref": f"{owner_scheme}:{owner_id}",
            "exact": quote_exact,
            "prefix": resolution.prefix,
            "suffix": resolution.suffix,
            "capture": {"quote_exact": exact, "publication": None, "locator": None},
        },
        resource_refs=[],
        link_ids=[],
    )
    (passage,) = result.passages
    return ResourceRef(scheme="passage_anchor", id=passage.anchor_id)


_REFUSAL_MESSAGES = {
    QuoteStatus.empty_exact: "Passage quote is empty",
    QuoteStatus.ambiguous: "Passage quote is ambiguous within its owner",
    QuoteStatus.no_match: "Passage quote was not found in its owner",
}
