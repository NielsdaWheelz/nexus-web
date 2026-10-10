"""The reader quote: an immutable snapshot of a locked highlight, persisted on its user turn.

Every later read derives from the snapshot, never the live highlight. Its revision
is the sha256 of its sorted compact JSON: the precondition a send compares.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID
from xml.sax.saxutils import escape

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.db.models import Highlight, Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.conversation import (
    MAX_QUOTE_AFFIX,
    MAX_QUOTE_EXACT,
    MAX_QUOTE_SOURCE,
    ReaderSelectionKey,
    ReaderSelectionOut,
    ReaderSelectionPreview,
    ReaderSelectionSnapshot,
)
from nexus.services.highlights import project_highlight
from nexus.services.reader_locations import highlight_locator
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_ref
from nexus.services.resource_items.routing import resource_activation_for_ref


def build_snapshot(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey
) -> ReaderSelectionSnapshot:
    """Resolve the highlight (the caller holds its row lock when sending) into a snapshot."""

    missing = ApiErrorCode.E_READER_SELECTION_NOT_FOUND
    highlight = db.get(Highlight, key.highlight_id)
    if highlight is None:
        raise ApiError(missing, "Highlight not found")
    if not can_read_highlight(db, viewer_id, key.highlight_id):
        raise ApiError(ApiErrorCode.E_READER_SELECTION_FORBIDDEN, "Highlight not readable")
    media = db.get(Media, key.media_id)
    if highlight.anchor_media_id != key.media_id or media is None:
        raise ApiError(missing, "media_id does not match the highlight anchor media")
    anchor = project_highlight(highlight, viewer_id).anchor.model_dump(mode="json")
    resolved = resolve_ref(db, viewer_id=viewer_id, ref=ResourceRef("highlight", key.highlight_id))
    if resolved.missing or resolved.quote is None:
        raise ApiError(missing, "Highlight quote unresolved")
    quote = resolved.quote
    exact, prefix, suffix = quote.exact, quote.prefix or "", quote.suffix or ""
    if not exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY,
            "A geometry-only highlight cannot be quoted",
        )
    label = (quote.source_label or "").strip()
    if not label:
        raise ApiError(missing, "Highlight source is unreadable")
    if (
        len(label) > MAX_QUOTE_SOURCE
        or len(exact) > MAX_QUOTE_EXACT
        or max(len(prefix), len(suffix)) > MAX_QUOTE_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    locator = highlight_locator(
        anchor, media_kind=media.kind, exact=exact, prefix=prefix, suffix=suffix
    )
    return ReaderSelectionSnapshot.model_validate(
        {
            "key": key,
            "source_label": label,
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
            "locator": locator,
        }
    )


def encode(snapshot: ReaderSelectionSnapshot) -> dict[str, object]:
    return snapshot.model_dump(mode="json")


def decode(raw: dict[str, object]) -> ReaderSelectionSnapshot:
    return ReaderSelectionSnapshot.model_validate(raw)


def revision(snapshot: ReaderSelectionSnapshot) -> str:
    canonical = json.dumps(encode(snapshot), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def selection_out(
    db: Session, *, viewer_id: UUID, snapshot: ReaderSelectionSnapshot
) -> ReaderSelectionOut:
    """Live readability gates activation; the frozen locator fixes the destination."""

    activation = resource_activation_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ResourceRef("media", snapshot.key.media_id),
        missing=not can_read_highlight(db, viewer_id, snapshot.key.highlight_id),
    )
    return ReaderSelectionOut.model_validate({**dict(snapshot), "activation": activation})


def preview(db: Session, *, viewer_id: UUID, key: ReaderSelectionKey) -> ReaderSelectionPreview:
    snapshot = build_snapshot(db, viewer_id=viewer_id, key=key)
    out = selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
    return ReaderSelectionPreview.model_validate({**dict(out), "revision": revision(snapshot)})


def quote_block(
    tag: str,
    *,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    source: str | None = None,
    note: str | None = None,
    offset_status: str | None = None,
) -> str:
    """The one XML renderer for quote-shaped prompt blocks."""

    lines = [f'<{tag} source="{attribute(source)}">' if source else f"<{tag}>"]
    if offset_status is not None:
        lines.append(f"<offset_status>{offset_status}</offset_status>")
    if prefix:
        lines.append(f"<prefix>{escape(prefix)}</prefix>")
    lines.append(f"<exact>{escape(exact)}</exact>")
    if suffix:
        lines.append(f"<suffix>{escape(suffix)}</suffix>")
    if note:
        lines.append(f"<note>{escape(note)}</note>")
    lines.append(f"</{tag}>")
    return "\n".join(lines)


def attribute(value: str) -> str:
    """``value`` escaped for a double-quoted XML attribute."""

    return escape(value, {'"': "&quot;"})


def snapshot_block(snapshot: ReaderSelectionSnapshot, tag: str) -> str:
    return quote_block(
        tag,
        exact=snapshot.exact,
        prefix=snapshot.prefix,
        suffix=snapshot.suffix,
        source=snapshot.source_label,
    )
