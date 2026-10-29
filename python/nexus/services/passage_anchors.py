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
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import XPostMedia
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_evidence import CapturedEvidence
from nexus.services import authored, library_entries, locator_resolver, text_quote
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.text_quote import QuoteStatus

PASSAGE_ANCHOR_OWNER_SCHEMES = ("media", "note_block", "fragment")


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


def materialize_or_reuse(
    db: Session,
    *,
    user_id: UUID,
    owner_scheme: str,
    owner_id: UUID,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    captured_evidence: CapturedEvidence,
) -> ResourceRef:
    """Capture or reuse the authored passage for a quote within one owner.

    The caller supplies captured passage evidence; no direct text-only capture exists.
    The normalized quote must resolve uniquely within its owner via the shared
    resolver; empty, ambiguous, or unmatched quotes are a typed refusal. The semantic owner resolves the permanent
    binding or mints its identity and stamps the literal quote capture; its projection
    writes the ``passage_anchors`` row. Flush-only inside the caller's transaction:
    the account head precedes the post's media family lock, as in every authored writer.
    """
    if owner_scheme not in PASSAGE_ANCHOR_OWNER_SCHEMES:
        raise AssertionError(  # justify-defect: callers pass the closed media|note_block|fragment set
            f"Invalid passage-anchor owner scheme: {owner_scheme!r}"
        )
    authored.lock_account(db, user_id)

    if (
        owner_scheme == "media"
        and db.scalar(select(XPostMedia.id).where(XPostMedia.media_id == owner_id)) is not None
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
    )
    if resolution.status is not QuoteStatus.unique:
        raise ApiError(
            ApiErrorCode.E_LINK_TARGET_AMBIGUOUS,
            _REFUSAL_MESSAGES[resolution.status],
        )
    assert captured_evidence.quote is not None
    frozen = captured_evidence.quote.excerpt
    target = captured_evidence.target
    if target.kind != "passage" or target.owner_ref != f"{owner_scheme}:{owner_id}":
        raise InvalidRequestError(message="Captured passage owner mismatch")
    locator = target.locator.model_dump(mode="json")
    publication = None
    extent = frozen.source_extent
    if owner_scheme == "fragment":
        if (
            target.locator.type != "x_capture_offsets"
            or target.locator.fragment_id != owner_id
            or target.source_identity != str(target.locator.capture_id)
            or captured_evidence.quote.exact != exact
            or frozen.structure != "captured"
            or extent is None
            or extent.reading_ref != target.owner_ref
            or extent.fragment_id != str(owner_id)
            or extent.document_identity != f"capture:{target.locator.capture_id}"
            or resolution.locator is None
            or resolution.locator.get("fragment_id") != str(owner_id)
        ):
            raise InvalidRequestError(message="Captured x passage identity mismatch")
        publication = {"kind": "x_capture", "capture_id": str(target.locator.capture_id)}
    elif (
        extent is not None
        and extent.reading_ref == target.owner_ref == f"media:{owner_id}"
        and extent.document_identity == target.source_identity
        and str(getattr(target.locator, "media_id", "")) == str(owner_id)
        and target.source_identity is not None
        and target.source_identity.startswith("g")
        and target.source_identity[1:].isdigit()
    ):
        publication = {"kind": "reader", "generation": int(target.source_identity[1:])}
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
            "capture": {
                "quote_exact": exact,
                "publication": publication,
                "locator": locator,
                "excerpt": frozen.model_dump(mode="json"),
            },
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
