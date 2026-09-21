"""The reader-quote snapshot: build, digest, encode/decode, project, render.

A reader quote is captured once, at send, from the locked highlight into an
immutable snapshot persisted on the user message. Every later read derives from
that snapshot, never the live highlight. The encoding is a persisted contract:
only ``ReaderSelectionSnapshot`` fields are serialized, and the revision is
SHA-256 over their sorted compact JSON.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

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
    """Resolve the locked highlight into the immutable snapshot."""
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

    exact = resolved.quote.exact
    if not exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY,
            "A geometry-only highlight cannot be quoted",
        )
    prefix = resolved.quote.prefix or ""
    suffix = resolved.quote.suffix or ""
    source_label = (resolved.quote.source_label or "").strip()
    if not source_label:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight source is unreadable")
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

    return ReaderSelectionSnapshot(
        key=key,
        source_label=source_label,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
        locator=_MEDIA_LOCATOR_ADAPTER.validate_python(
            highlight_locator(
                typed.anchor.model_dump(mode="json"),
                media_kind=media.kind,
                exact=exact,
                prefix=prefix,
                suffix=suffix,
            )
        ),
    )


def encode_reader_selection_snapshot(snapshot: ReaderSelectionSnapshot) -> dict[str, object]:
    """The JSON object persisted in ``messages.reader_selection_snapshot``."""
    return snapshot.model_dump(mode="json", include=set(ReaderSelectionSnapshot.model_fields))


def decode_reader_selection_snapshot(raw: object) -> ReaderSelectionSnapshot:
    """Strict: a non-object or unknown key is a trusted-state defect."""
    if not isinstance(raw, dict):
        raise AssertionError("reader_selection_snapshot must be a JSON object")
    return ReaderSelectionSnapshot.model_validate(raw)


def compute_reader_selection_revision(snapshot: ReaderSelectionSnapshot) -> str:
    """Lowercase SHA-256 over the encoded snapshot: the compare-on-send precondition."""
    canonical = json.dumps(
        encode_reader_selection_snapshot(snapshot), sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def reader_selection_out(
    db: Session, *, viewer_id: UUID, snapshot: ReaderSelectionSnapshot
) -> ReaderSelectionOut:
    """Live readability gates activation; the immutable locator fixes the destination."""
    activation = resource_activation_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ResourceRef(scheme="media", id=snapshot.key.media_id),
        missing=not can_read_highlight(db, viewer_id, snapshot.key.highlight_id),
    )
    return ReaderSelectionOut.model_validate({**dict(snapshot), "activation": activation})


def reader_selection_preview(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey
) -> ReaderSelectionPreview:
    snapshot = build_reader_selection_snapshot(db, viewer_id=viewer_id, key=key)
    out = reader_selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
    return ReaderSelectionPreview.model_validate(
        {**dict(out), "revision": compute_reader_selection_revision(snapshot)}
    )


def render_reader_selection_prompt_block(snapshot: ReaderSelectionSnapshot) -> str:
    return _render_quote(snapshot, "reader_selection")


def render_historical_reader_selection_prompt_block(snapshot: ReaderSelectionSnapshot) -> str:
    return _render_quote(snapshot, "historical_reader_selection")


def _render_quote(snapshot: ReaderSelectionSnapshot, tag: str) -> str:
    return render_quote_block(
        tag,
        exact=snapshot.exact,
        prefix=snapshot.prefix or None,
        suffix=snapshot.suffix or None,
        source_label=snapshot.source_label,
    )


def render_subject_metadata_block(snapshot: ReaderSelectionSnapshot) -> str:
    """Identity and source only: the quote text appears once, in its own block."""
    source_attr = xml_escape(snapshot.source_label, {'"': "&quot;"})
    return (
        f'<subject kind="reader_highlight" source="{source_attr}">\n'
        f"<highlight_id>{snapshot.key.highlight_id}</highlight_id>\n"
        f"<media_id>{snapshot.key.media_id}</media_id>\n"
        "</subject>"
    )
