"""The reader quote: immutable evidence persisted on its user turn.

Every later quote derives from the snapshot, never the live highlight. Its revision
is the sha256 of its sorted compact JSON: the precondition a send compares.
An optional highlight ref separately retains live conversation context. Current
source authority governs disclosure of historical words and attribution.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from uuid import UUID
from xml.sax.saxutils import escape

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MAX_QUOTE_AFFIX,
    MAX_QUOTE_EXACT,
    PassageReaderSelectionInput,
    ReaderSelectionKey,
    ReaderSelectionOut,
    ReaderSelectionPreview,
    ReaderSelectionSnapshot,
)
from nexus.services.generation.policy import policy
from nexus.services.reader_excerpts import quote_parts
from nexus.services.resource_graph.refs import ResourceRef, require_ref


def build_snapshot(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey, expected_capture_revision: str
) -> ReaderSelectionSnapshot:
    """Resolve the highlight (the sender holds its account head) into a snapshot."""

    missing = ApiErrorCode.E_READER_SELECTION_NOT_FOUND
    stored = db.execute(
        text("""SELECT h.authored_visible,h.excerpt_preview->>'capture_revision' AS capture_revision,
        octet_length((r.state #> '{selection,value}')::text) AS capture_size
        FROM highlights h JOIN authored_resources r ON r.account_id=h.user_id AND r.ref='highlight:' || h.id::text
        WHERE h.id=:id"""),
        {"id": key.highlight_id},
    ).first()
    if stored is None or not stored.authored_visible:
        raise ApiError(missing, "Highlight not found")
    if not can_read_highlight(db, viewer_id, key.highlight_id):
        raise ApiError(ApiErrorCode.E_READER_SELECTION_FORBIDDEN, "Highlight not readable")
    if stored.capture_revision != expected_capture_revision:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_STALE, "The selected highlight changed")
    if stored.capture_size > policy("chat").input_max_bytes:
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds the input budget"
        )
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
    if key.capture_id is not None:
        from nexus.schemas.resource_evidence import CapturedPassageTarget
        from nexus.services.x_source import readable_x_capture_ids_sql

        if (
            not isinstance(evidence.target, CapturedPassageTarget)
            or evidence.target.locator.type != "x_capture_offsets"
            or not db.scalar(
                text(f"""SELECT :reading IN ({readable_x_capture_ids_sql()}) AND (
                    :reading=:capture OR EXISTS (
                        SELECT 1 FROM x_post_capture_contexts
                        WHERE capture_id=:reading AND target_capture_id=:capture))"""),
                {
                    "viewer_id": viewer_id,
                    "reading": key.capture_id,
                    "capture": evidence.target.locator.capture_id,
                },
            )
        ):
            raise ApiError(missing, "Highlight is outside the requested capture")
    quote = evidence.quote
    parts = quote_parts(quote) if quote is not None else None
    if parts is None or not parts.exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY,
            "A geometry-only highlight cannot be quoted",
        )
    if (
        len(parts.exact) > MAX_QUOTE_EXACT
        or max(len(parts.prefix), len(parts.suffix)) > MAX_QUOTE_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    return ReaderSelectionSnapshot(highlight_ref=f"highlight:{key.highlight_id}", evidence=evidence)


def capture_snapshot(
    db: Session, *, viewer_id: UUID, selection: PassageReaderSelectionInput
) -> ReaderSelectionSnapshot:
    """An unsaved capture becomes message-owned evidence, never an authored resource."""
    from nexus.services.resource_items.evidence import capture_reader_selection

    capture = selection.capture
    if (
        len(capture.quote_exact) > MAX_QUOTE_EXACT
        or max(len(capture.prefix or ""), len(capture.suffix or "")) > MAX_QUOTE_AFFIX
        or len(capture.model_dump_json().encode()) > policy("chat").input_max_bytes
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    evidence = capture_reader_selection(
        db,
        viewer_id=viewer_id,
        reading_ref=require_ref(selection.reading_ref),
        source_ref=require_ref(selection.source_ref),
        capture=capture,
    )
    parts = quote_parts(evidence.quote)
    if (
        len(parts.exact) > MAX_QUOTE_EXACT
        or max(len(parts.prefix), len(parts.suffix)) > MAX_QUOTE_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    return ReaderSelectionSnapshot(highlight_ref=None, evidence=evidence)


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

    if message_id is None:
        assert (
            snapshot.highlight_ref is not None
        )  # justify-defect: only saved-highlight previews lack a message.
        ref = require_ref(snapshot.highlight_ref)
    else:
        ref = ResourceRef("message", message_id)
    key = (
        ReaderQuoteSourceTargetKey(message_id=message_id)
        if message_id
        else ResourceSourceTargetKey(field=None, resource_ref=ref.uri)
    )
    item = evidence_items(db, viewer_id=viewer_id, occurrences=[(ref, snapshot.evidence, key)])[0]
    return ReaderSelectionOut(item=item)


def reader_quotes(
    db: Session,
    *,
    viewer_id: UUID,
    reading_media_id: UUID | None = None,
    fragment_ids: list[UUID] | None = None,
) -> list[tuple[UUID, ReaderSelectionSnapshot]]:
    """Indexed message-owned quotes; current reading authority bounds every result."""
    from nexus.services.resource_items.evidence import admit_evidence

    if reading_media_id is not None:
        owners = db.scalars(
            text("""WITH source AS (
            SELECT COALESCE(p.source_media_id,m.id) AS id FROM media m
            LEFT JOIN media_parts p ON p.media_id=m.id WHERE m.id=:reading
        ) SELECT 'media:' || id::text FROM source
          UNION SELECT 'media:' || p.media_id::text FROM media_parts p JOIN source s ON s.id=p.source_media_id
        """),
            {"reading": reading_media_id},
        ).all()
    else:
        owners = [f"fragment:{fragment}" for fragment in fragment_ids or []]
    if not owners:
        return []
    rows = db.execute(
        text("""SELECT m.id,m.reader_selection_snapshot FROM messages m
        JOIN conversations c ON c.id=m.conversation_id
        WHERE c.owner_user_id=:viewer AND m.reader_selection_snapshot IS NOT NULL
          AND m.reader_selection_snapshot #>> '{evidence,target,owner_ref}' = ANY(:owners)
        ORDER BY m.created_at,m.id"""),
        {"viewer": viewer_id, "owners": list(owners)},
    )
    result = []
    for row in rows:
        snapshot = decode(row.reader_selection_snapshot)
        evidence = admit_evidence(
            db, viewer_id=viewer_id, evidence=snapshot.evidence, reading_media_id=reading_media_id
        )
        if evidence is not None:
            result.append((row.id, snapshot.model_copy(update={"evidence": evidence})))
    return result


def changed(db: Session, *, viewer_id: UUID, message_ids: Sequence[UUID]) -> None:
    """Invalidate native quote maps in the same transaction as insertion or deletion.

    Media quotes can appear in their source and contained readings. Capture quotes
    use their fragment's lane. The existing account writing hint reaches other devices.
    """
    from nexus.services.resource_items.versions import bump_version

    owners = db.scalars(
        text("""SELECT DISTINCT reader_selection_snapshot #>> '{evidence,target,owner_ref}'
        FROM messages WHERE id=ANY(:ids) AND reader_selection_snapshot IS NOT NULL"""),
        {"ids": message_ids},
    ).all()
    refs = {require_ref(owner) for owner in owners if owner is not None}
    media_ids = [ref.id for ref in refs if ref.scheme == "media"]
    if media_ids:
        refs.update(
            ResourceRef("media", media_id)
            for media_id in db.scalars(
                text("""WITH sources AS (
            SELECT COALESCE(p.source_media_id,m.id) AS id FROM media m
            LEFT JOIN media_parts p ON p.media_id=m.id WHERE m.id=ANY(:ids)
        ) SELECT id FROM sources UNION SELECT p.media_id FROM media_parts p JOIN sources s ON s.id=p.source_media_id
        """),
                {"ids": media_ids},
            )
        )
    for ref in sorted(refs, key=lambda ref: ref.uri):
        bump_version(db, viewer_id=viewer_id, ref=ref, lane="evidence")


def preview(
    db: Session, *, viewer_id: UUID, key: ReaderSelectionKey, expected_capture_revision: str
) -> ReaderSelectionPreview:
    snapshot = build_snapshot(
        db, viewer_id=viewer_id, key=key, expected_capture_revision=expected_capture_revision
    )
    out = selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
    return ReaderSelectionPreview(
        key=key,
        expected_capture_revision=expected_capture_revision,
        revision=revision(snapshot),
        item=out.item,
    )


def quote_block(
    tag: str,
    *,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    source: str | None = None,
    annotation: str | None = None,
    offset_status: str | None = None,
    citation_number: int | None = None,
) -> str:
    """The one XML renderer for quote-shaped prompt blocks."""

    attributes = (f' source="{attribute(source)}"' if source else "") + (
        f' n="{citation_number}"' if citation_number is not None else ""
    )
    lines = [f"<{tag}{attributes}>"]
    if offset_status is not None:
        lines.append(f"<offset_status>{offset_status}</offset_status>")
    if prefix:
        lines.append(f"<prefix>{escape(prefix)}</prefix>")
    lines.append(f"<exact>{escape(exact)}</exact>")
    if suffix:
        lines.append(f"<suffix>{escape(suffix)}</suffix>")
    if annotation:
        lines.append(f"<annotation>{escape(annotation)}</annotation>")
    lines.append(f"</{tag}>")
    return "\n".join(lines)


def attribute(value: str) -> str:
    """``value`` escaped for a double-quoted XML attribute."""

    return escape(value, {'"': "&quot;"})


def snapshot_block(
    db: Session,
    viewer_id: UUID,
    snapshot: ReaderSelectionSnapshot,
    tag: str,
    *,
    citation_number: int | None = None,
) -> str:
    from nexus.services.resource_items.evidence import admit_evidence

    evidence = admit_evidence(db, viewer_id=viewer_id, evidence=snapshot.evidence)
    if evidence is None:
        return f'<{tag} unavailable="true">source unavailable</{tag}>'
    parts = quote_parts(evidence.quote) if evidence.quote else None
    return quote_block(
        tag,
        exact=parts.exact if parts else "",
        prefix=parts.prefix if parts else None,
        suffix=parts.suffix if parts else None,
        source=evidence.source.title,
        citation_number=citation_number,
    )
