"""Canonical owner of the reader-quote snapshot: build, revise, encode/decode,
project, and render.

A reader quote is captured once, at send, from the locked Highlight into an
immutable ``ReaderSelectionSnapshot`` persisted on the user message. Every later
read — transcript, reload, branch switch, rerun, and prompt assembly — derives
from that snapshot, never the live Highlight. This module is the sole place the
snapshot is created, JSON-encoded/decoded, digested into a revision, projected
to the wire, and rendered into the prompt. No JSON fallback or version metadata
exists; malformed trusted data is a defect.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.db.models import Highlight, Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.chat_reader_selection import (
    MAX_READER_SELECTION_AFFIX,
    MAX_READER_SELECTION_EXACT,
    MAX_READER_SELECTION_SOURCE_LABEL,
    ReaderSelectionKey,
    ReaderSelectionOut,
    ReaderSelectionPreview,
    ReaderSelectionSnapshot,
)
from nexus.schemas.retrieval import MediaRetrievalLocator
from nexus.services.chat_quote import render_quote_block
from nexus.services.highlights import project_highlight
from nexus.services.reader_locations import highlight_locator
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_ref
from nexus.services.resource_items.routing import resource_activation_for_ref

_MEDIA_LOCATOR_ADAPTER: TypeAdapter[MediaRetrievalLocator] = TypeAdapter(MediaRetrievalLocator)


def build_reader_selection_snapshot(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey
) -> ReaderSelectionSnapshot:
    """Resolve the locked Highlight into the immutable snapshot.

    Raises a typed reader-selection error for an absent/forbidden/mismatched,
    geometry-only, or over-limit Highlight. Callers acquire the Highlight row
    lock (send) before invoking this so the derived fields are consistent with
    the revision they compare against.
    """
    highlight = db.get(Highlight, key.highlight_id)
    if highlight is None:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight not found")
    if not can_read_highlight(db, viewer_id, key.highlight_id):
        raise ApiError(ApiErrorCode.E_READER_SELECTION_FORBIDDEN, "Highlight not readable")
    if highlight.anchor_media_id != key.media_id:
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_NOT_FOUND,
            "media_id does not match the highlight anchor media",
        )

    media = db.get(Media, key.media_id)
    if media is None:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Media not found")

    typed = project_highlight(highlight, viewer_id)
    resolved = resolve_ref(
        db, viewer_id=viewer_id, ref=ResourceRef(scheme="highlight", id=key.highlight_id)
    )
    if resolved.missing or resolved.quote is None:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight quote unresolved")
    quote = resolved.quote

    exact = quote.exact
    if not exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY,
            "A geometry-only highlight cannot be quoted",
        )
    prefix = quote.prefix or ""
    suffix = quote.suffix or ""
    source_label = (quote.source_label or "").strip()
    if not source_label:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight source is unreadable")

    _reject_over_limit(source_label=source_label, exact=exact, prefix=prefix, suffix=suffix)

    locator = _MEDIA_LOCATOR_ADAPTER.validate_python(
        highlight_locator(
            typed.anchor.model_dump(mode="json"),
            media_kind=media.kind,
            exact=exact,
            prefix=prefix,
            suffix=suffix,
        )
    )

    return ReaderSelectionSnapshot(
        key=key,
        source_label=source_label,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
        locator=locator,
    )


def _reject_over_limit(*, source_label: str, exact: str, prefix: str, suffix: str) -> None:
    if (
        len(source_label) > MAX_READER_SELECTION_SOURCE_LABEL
        or len(exact) > MAX_READER_SELECTION_EXACT
        or len(prefix) > MAX_READER_SELECTION_AFFIX
        or len(suffix) > MAX_READER_SELECTION_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE,
            "Reader selection exceeds a bounded field limit",
        )


def compute_reader_selection_revision(snapshot: ReaderSelectionSnapshot) -> str:
    """Lowercase SHA-256 hex over the snapshot's canonical answer/display fields.

    A compare-on-send precondition, never part of the idempotency identity. UUIDs
    serialize lowercase-hyphenated and keys are sorted, so equal snapshots always
    digest equal.
    """
    canonical = json.dumps(
        snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def encode_reader_selection_snapshot(snapshot: ReaderSelectionSnapshot) -> dict[str, object]:
    """Encode the snapshot to the JSON object persisted in
    ``messages.reader_selection_snapshot``."""
    return snapshot.model_dump(mode="json")


def decode_reader_selection_snapshot(raw: object) -> ReaderSelectionSnapshot:
    """Strictly decode a stored snapshot object. JSON ``null`` / non-object /
    unknown-key data is a trusted-state defect, never a soft ``Absent``."""
    if not isinstance(raw, dict):
        raise AssertionError("reader_selection_snapshot must be a JSON object")
    return ReaderSelectionSnapshot.model_validate(raw)


def reader_selection_out(
    db: Session, *, viewer_id: UUID, snapshot: ReaderSelectionSnapshot
) -> ReaderSelectionOut:
    """Project the immutable snapshot to the message wire.

    Live Highlight readability *gates* activation (a deleted/forbidden source
    yields ``kind="none"``), but the immutable locator's media — not the live
    Highlight anchor — *determines the destination*, so an edit that moves the
    Highlight can never redirect a historical quote (Domain Rule 8, AC11). The
    client positions within that media reader from the immutable locator.
    """
    visible = can_read_highlight(db, viewer_id, snapshot.key.highlight_id)
    activation = resource_activation_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ResourceRef(scheme="media", id=snapshot.key.media_id),
        missing=not visible,
    )
    return ReaderSelectionOut(
        key=snapshot.key,
        source_label=snapshot.source_label,
        exact=snapshot.exact,
        prefix=snapshot.prefix,
        suffix=snapshot.suffix,
        locator=snapshot.locator,
        activation=activation,
    )


def reader_selection_preview(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey
) -> ReaderSelectionPreview:
    """Build the pending-quote-card projection for a locked Highlight.

    Resolves the immutable snapshot (raising the typed reader-selection error for
    an absent/forbidden/mismatched, geometry-only, or over-limit Highlight),
    projects it to the wire with current activation, and digests its canonical
    answer/display fields into the compare-on-send ``revision``.
    """
    snapshot = build_reader_selection_snapshot(db, viewer_id=viewer_id, key=key)
    out = reader_selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
    revision = compute_reader_selection_revision(snapshot)
    return ReaderSelectionPreview(
        key=out.key,
        source_label=out.source_label,
        exact=out.exact,
        prefix=out.prefix,
        suffix=out.suffix,
        locator=out.locator,
        activation=out.activation,
        revision=revision,
    )


def render_reader_selection_prompt_block(snapshot: ReaderSelectionSnapshot) -> str:
    """The sole current-turn quote-text block: ``<reader_selection>``."""
    return render_quote_block(
        "reader_selection",
        exact=snapshot.exact,
        prefix=snapshot.prefix or None,
        suffix=snapshot.suffix or None,
        source_label=snapshot.source_label,
    )


def render_historical_reader_selection_prompt_block(snapshot: ReaderSelectionSnapshot) -> str:
    """The bounded quote-text block inserted immediately before a historical
    quoted user turn."""
    return render_quote_block(
        "historical_reader_selection",
        exact=snapshot.exact,
        prefix=snapshot.prefix or None,
        suffix=snapshot.suffix or None,
        source_label=snapshot.source_label,
    )


def render_subject_metadata_block(snapshot: ReaderSelectionSnapshot) -> str:
    """The selection-backed ``<subject>``: identity/source metadata only — the
    quote text lives solely in ``<reader_selection>`` so it appears exactly once."""
    from xml.sax.saxutils import escape as xml_escape

    source_attr = xml_escape(snapshot.source_label, {'"': "&quot;"})
    return (
        f'<subject kind="reader_highlight" source="{source_attr}">\n'
        f"<highlight_id>{snapshot.key.highlight_id}</highlight_id>\n"
        f"<media_id>{snapshot.key.media_id}</media_id>\n"
        "</subject>"
    )
