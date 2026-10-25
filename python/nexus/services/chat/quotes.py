"""The reader quote: an immutable snapshot of a locked highlight, persisted on its user turn.

Every later read derives from the snapshot, never the live highlight. Its revision
is the sha256 of its sorted compact JSON: the precondition a send compares.
The key names the reading identity; canonical highlight anchors may belong to
its source. Capture proves that exact passage within the requested reading scope.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID
from xml.sax.saxutils import escape

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.db.models import Highlight
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MAX_QUOTE_AFFIX,
    MAX_QUOTE_EXACT,
    ReaderSelectionKey,
    ReaderSelectionOut,
    ReaderSelectionPreview,
    ReaderSelectionSnapshot,
)
from nexus.services.resource_graph.refs import ResourceRef


def build_snapshot(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey
) -> ReaderSelectionSnapshot:
    """Resolve the highlight (the sender holds its account head) into a snapshot."""

    missing = ApiErrorCode.E_READER_SELECTION_NOT_FOUND
    highlight = db.get(Highlight, key.highlight_id)
    if highlight is None:
        raise ApiError(missing, "Highlight not found")
    if not can_read_highlight(db, viewer_id, key.highlight_id):
        raise ApiError(ApiErrorCode.E_READER_SELECTION_FORBIDDEN, "Highlight not readable")
    from nexus.services.resource_items.evidence import capture_evidence

    try:
        evidence = capture_evidence(
            db,
            viewer_id=viewer_id,
            ref=ResourceRef("highlight", key.highlight_id),
            reading_media_id=key.media_id,
        )
    except NotFoundError as error:
        raise ApiError(missing, "Highlight is outside the requested reading scope") from error
    quote = evidence.quote
    if quote is None or not quote.exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY,
            "A geometry-only highlight cannot be quoted",
        )
    if (
        len(quote.exact) > MAX_QUOTE_EXACT
        or max(len(quote.prefix or ""), len(quote.suffix or "")) > MAX_QUOTE_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    return ReaderSelectionSnapshot(key=key, evidence=evidence)


def encode(snapshot: ReaderSelectionSnapshot) -> dict[str, object]:
    return snapshot.model_dump(mode="json")


def decode(raw: dict[str, object]) -> ReaderSelectionSnapshot:
    return ReaderSelectionSnapshot.model_validate(raw)


def revision(snapshot: ReaderSelectionSnapshot) -> str:
    canonical = json.dumps(encode(snapshot), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def selection_out(
    db: Session,
    *,
    viewer_id: UUID,
    snapshot: ReaderSelectionSnapshot,
    message_id: UUID | None = None,
) -> ReaderSelectionOut:
    from nexus.schemas.resource_items import ReaderQuoteSourceTargetKey, ResourceSourceTargetKey
    from nexus.services.resource_items.evidence import evidence_items

    ref = ResourceRef("highlight", snapshot.key.highlight_id)
    key = (
        ReaderQuoteSourceTargetKey(message_id=message_id)
        if message_id
        else ResourceSourceTargetKey(resource_ref=ref.uri)
    )
    item = evidence_items(db, viewer_id=viewer_id, occurrences=[(ref, snapshot.evidence, key)])[0]
    if message_id is None and item.activation.kind != "none":
        from nexus.services.resource_items.items import resource_item_out

        item = item.model_copy(
            update={
                "activation": resource_item_out(
                    db, viewer_id=viewer_id, ref=ref, reading_media_id=snapshot.key.media_id
                ).activation
            }
        )
    return ReaderSelectionOut(key=snapshot.key, item=item)


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
        exact=snapshot.evidence.quote.exact if snapshot.evidence.quote else "",
        prefix=snapshot.evidence.quote.prefix if snapshot.evidence.quote else None,
        suffix=snapshot.evidence.quote.suffix if snapshot.evidence.quote else None,
        source=snapshot.evidence.source.title,
    )
