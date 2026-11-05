"""Message-owned reader quotations: capture, compare, disclosure and source occurrences.

Preview and admission capture the same observed selection. Historical words and
attribution stay frozen; current source authority governs their disclosure.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from uuid import UUID
from xml.sax.saxutils import escape

from pydantic import TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.db.models import Highlight, Media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MAX_QUOTE_AFFIX,
    MAX_QUOTE_EXACT,
    ReaderSelection,
    ReaderSelectionOut,
    ReaderSelectionPreview,
    ReaderSelectionSnapshot,
)
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedSource,
)
from nexus.schemas.resource_items import ReaderQuoteSourceTargetKey, ResourceSourceTargetKey
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.reader_excerpts import plain_excerpt, quote_parts
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.evidence import capture_evidence, evidence_items
from nexus.services.resource_items.items import source_attributions
from nexus.services.resource_items.locations import source_identities

_LOCATOR = TypeAdapter(RetrievalLocator)


def build_snapshot(
    db: Session, *, viewer_id: UUID, selection: ReaderSelection
) -> ReaderSelectionSnapshot:
    """Capture within the exact mounted reading; the sender holds its account head."""
    from nexus.services.reader_document import read_capture_document, read_reader_document
    from nexus.services.reader_publication import read_ready_publication_generation
    from nexus.services.source_excerpt import SourceExcerptRequest, source_excerpts

    scope = selection.scope
    reading_id = scope.media_id if scope.kind == "media" else None
    document = None
    pdf_pages = None
    if scope.kind == "media":
        if not can_read_media(db, viewer_id, scope.media_id):
            raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Reading not found")
        media = db.execute(
            select(Media.kind, Media.page_count).where(Media.id == scope.media_id)
        ).one()
        if media.kind == "pdf":
            generation = read_ready_publication_generation(db, media_id=scope.media_id)
            identity = f"g{generation}" if generation is not None else None
            pdf_pages = media.page_count
        else:
            try:
                document = read_reader_document(db, viewer_id, scope.media_id)
            except ApiError as error:
                if error.code in (
                    ApiErrorCode.E_MEDIA_NOT_READY,
                    ApiErrorCode.E_READER_CONTENT_CHANGED,
                ):
                    raise ApiError(
                        ApiErrorCode.E_READER_SELECTION_STALE, "The reading changed"
                    ) from error
                if error.code in (ApiErrorCode.E_MEDIA_NOT_FOUND, ApiErrorCode.E_INVALID_KIND):
                    raise ApiError(
                        ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Reading not found"
                    ) from error
                raise
            identity = document.identity
    else:
        try:
            document = read_capture_document(db, viewer_id, scope.capture_id)
        except NotFoundError as error:
            raise ApiError(
                ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Capture not found"
            ) from error
        identity = document.identity
    if identity != scope.document_identity:
        raise ApiError(ApiErrorCode.E_READER_SELECTION_STALE, "The reading changed")

    if selection.kind == "highlight":
        highlight = db.get(Highlight, selection.highlight_id)
        if highlight is None or not highlight.authored_visible:
            raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight not found")
        if not can_read_highlight(db, viewer_id, selection.highlight_id):
            raise ApiError(ApiErrorCode.E_READER_SELECTION_FORBIDDEN, "Highlight not readable")
        if highlight.excerpt_preview.get("capture_revision") != selection.expected_capture_revision:
            raise ApiError(ApiErrorCode.E_READER_SELECTION_STALE, "The selected highlight changed")
        try:
            evidence = capture_evidence(
                db,
                viewer_id=viewer_id,
                ref=ResourceRef("highlight", selection.highlight_id),
                reading_media_id=reading_id,
            )
        except NotFoundError as error:
            raise ApiError(
                ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight is outside the reading"
            ) from error
        if scope.kind == "x_capture":
            target = evidence.target
            capture_locator = target.locator if isinstance(target, CapturedPassageTarget) else None
            if (
                not isinstance(target, CapturedPassageTarget)
                or capture_locator is None
                or capture_locator.type != "x_capture_offsets"
                or document is None
                or document.kind == "pdf"
                or not any(
                    unit.x_post is not None
                    and unit.x_post.owner is not None
                    and unit.x_post.owner.capture_id == capture_locator.capture_id
                    and unit.x_post.owner.fragment_id == capture_locator.fragment_id
                    for unit in document.units
                )
            ):
                raise ApiError(
                    ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Highlight is outside the capture"
                )
        snapshot = ReaderSelectionSnapshot(
            evidence=evidence, highlight_ref=f"highlight:{selection.highlight_id}"
        )
    else:
        locator = selection.locator
        words = locator.text_quote_selector
        if not words.exact.strip():
            raise ApiError(
                ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY, "The selection has no quote text"
            )
        if (
            len(words.exact) > (2000 if locator.type == "pdf_page_geometry" else MAX_QUOTE_EXACT)
            or max(len(words.prefix or ""), len(words.suffix or "")) > MAX_QUOTE_AFFIX
        ):
            raise ApiError(
                ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
            )
        if locator.type == "pdf_page_geometry":
            if (
                scope.kind != "media"
                or locator.media_id != scope.media_id
                or document is not None
                or pdf_pages is None
                or locator.page_number > pdf_pages
            ):
                raise ApiError(
                    ApiErrorCode.E_READER_SELECTION_NOT_FOUND,
                    "PDF selection is outside the reading",
                )
            owner = ResourceRef("media", scope.media_id)
            excerpt = plain_excerpt(words.exact, words.prefix, words.suffix)
            source_identity = identity
            label = f"page {locator.page_number}"
        else:
            if document is None or document.kind == "pdf":
                raise ApiError(
                    ApiErrorCode.E_READER_SELECTION_NOT_FOUND,
                    "Text selection is outside the reading",
                )
            if locator.type == "x_capture_offsets":
                unit = next(
                    (
                        unit
                        for unit in document.units
                        if unit.x_post is not None
                        and unit.x_post.owner is not None
                        and unit.x_post.owner.capture_id == locator.capture_id
                        and unit.x_post.owner.fragment_id == locator.fragment_id
                    ),
                    None,
                )
                owner = ResourceRef("fragment", locator.fragment_id)
                source_identity = str(locator.capture_id)
                base = 0
            else:
                canonical_id = (
                    document.provenance.source_media_id
                    if document.kind == "text_part"
                    else reading_id
                )
                source_format = (
                    document.source_format if document.kind == "text_part" else document.kind
                )
                if (
                    locator.media_id != canonical_id
                    or (locator.type == "epub_fragment_offsets") != (source_format == "epub")
                    or reading_id is None
                ):
                    raise ApiError(
                        ApiErrorCode.E_READER_SELECTION_NOT_FOUND,
                        "Selection is outside the reading",
                    )
                unit = next(
                    (unit for unit in document.units if unit.id == str(locator.fragment_id)), None
                )
                owner = ResourceRef("media", reading_id)
                source_identity = source_identities(db, [reading_id]).get(reading_id)
                base = (
                    next(
                        (
                            part.source_start_offset
                            for part in document.units
                            if part.id == str(locator.fragment_id)
                        ),
                        0,
                    )
                    if document.kind == "text_part"
                    else 0
                )
            if unit is None:
                raise ApiError(
                    ApiErrorCode.E_READER_SELECTION_NOT_FOUND,
                    "Selection fragment is outside the reading",
                )
            start, end = locator.start_offset - base, locator.end_offset - base
            prefix, suffix = words.prefix or "", words.suffix or ""
            if (
                not 0 <= start < end <= len(unit.canonical_text)
                or unit.canonical_text[start:end] != words.exact
                or unit.canonical_text[max(0, start - len(prefix)) : start] != prefix
                or unit.canonical_text[end : end + len(suffix)] != suffix
            ):
                raise ApiError(ApiErrorCode.E_READER_SELECTION_STALE, "The selected words changed")
            excerpt = source_excerpts(
                db,
                [
                    SourceExcerptRequest(
                        reading_id=owner.id,
                        fragment_id=locator.fragment_id,
                        start=locator.start_offset,
                        end=locator.end_offset,
                    )
                ],
            )[0]
            label = None
        attribution = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
        if attribution is None:
            raise ApiError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Source not found")
        evidence = CapturedEvidence(
            completion_ref=None,
            quote=CapturedQuote(
                excerpt=excerpt,
                exact=words.exact,
                prefix=words.prefix,
                suffix=words.suffix,
                color=None,
            ),
            source=CapturedSource(
                ref=attribution.ref,
                title=attribution.title,
                media_kind=attribution.media_kind,
                contributors=attribution.contributors,
                attribution_text=attribution.attribution_text,
                location_label=label,
            ),
            target=CapturedPassageTarget(
                field=None,
                owner_ref=owner.uri,
                locator=_LOCATOR.validate_python(locator.model_dump(mode="json")),
                precision="exact",
                source_identity=source_identity,
            ),
        )
        snapshot = ReaderSelectionSnapshot(evidence=evidence, highlight_ref=None)
    parts = quote_parts(snapshot.evidence.quote) if snapshot.evidence.quote is not None else None
    if parts is None or not parts.exact.strip():
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY, "The selection has no quote text"
        )
    if (
        len(parts.exact) > MAX_QUOTE_EXACT
        or max(len(parts.prefix), len(parts.suffix)) > MAX_QUOTE_AFFIX
    ):
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Reader selection exceeds a field limit"
        )
    return snapshot


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
    ref = assert_resource_ref(
        snapshot.highlight_ref
        or snapshot.evidence.target.owner_ref
        or snapshot.evidence.source.ref
        or ""
    )
    key = (
        ReaderQuoteSourceTargetKey(message_id=message_id)
        if message_id
        else ResourceSourceTargetKey(field=None, resource_ref=ref.uri)
    )
    return ReaderSelectionOut(
        item=evidence_items(db, viewer_id=viewer_id, occurrences=[(ref, snapshot.evidence, key)])[0]
    )


def preview(db: Session, *, viewer_id: UUID, selection: ReaderSelection) -> ReaderSelectionPreview:
    snapshot = build_snapshot(db, viewer_id=viewer_id, selection=selection)
    out = selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
    return ReaderSelectionPreview(selection=selection, item=out.item, revision=revision(snapshot))


def source_quotations(
    db: Session, *, viewer_id: UUID, media_id: UUID | None = None, fragment_ids: Sequence[UUID] = ()
) -> list[tuple[ResourceRef, CapturedEvidence]]:
    """All retained message occurrences in this source family; the reader proves scope."""
    rows = db.execute(
        text("""
        SELECT m.id, m.reader_selection_snapshot FROM messages m
        JOIN conversations c ON c.id=m.conversation_id
        WHERE c.owner_user_id=:viewer AND m.reader_selection_snapshot IS NOT NULL AND (
            m.reader_selection_snapshot #>> '{evidence,target,owner_ref}'=ANY(:fragment_refs)
            OR (CAST(:media AS uuid) IS NOT NULL AND (
                m.reader_selection_snapshot #>> '{evidence,target,locator,media_id}'=(
                    SELECT COALESCE(p.source_media_id,media.id)::text FROM media
                    LEFT JOIN media_parts p ON p.media_id=media.id WHERE media.id=:media)
                OR m.reader_selection_snapshot #>> '{evidence,target,owner_ref}' IN (
                    SELECT 'media:' || family.id::text FROM media family
                    LEFT JOIN media_parts fp ON fp.media_id=family.id
                    WHERE COALESCE(fp.source_media_id,family.id)=(
                        SELECT COALESCE(p.source_media_id,media.id) FROM media
                        LEFT JOIN media_parts p ON p.media_id=media.id WHERE media.id=:media)))))
        ORDER BY m.created_at,m.id
    """),
        {
            "viewer": viewer_id,
            "media": media_id,
            "fragment_refs": [f"fragment:{id}" for id in fragment_ids],
        },
    ).yield_per(128)
    return [
        (ResourceRef("message", row.id), decode(row.reader_selection_snapshot).evidence)
        for row in rows
    ]


def invalidate_sources(
    db: Session, *, viewer_id: UUID, snapshots: Sequence[ReaderSelectionSnapshot]
) -> None:
    """Publish source-map changes with the message transaction, independent of context links."""
    from nexus.services.resource_items.versions import bump_version

    refs: set[ResourceRef] = set()
    media_ids: set[UUID] = set()
    for snapshot in snapshots:
        target = snapshot.evidence.target
        if isinstance(target, CapturedPassageTarget) and target.locator.type == "x_capture_offsets":
            refs.add(ResourceRef("fragment", target.locator.fragment_id))
        elif target.owner_ref is not None and target.owner_ref.startswith("media:"):
            media_ids.add(assert_resource_ref(target.owner_ref).id)
    if media_ids:
        for id in db.scalars(
            text("""SELECT m.id FROM media m LEFT JOIN media_parts p ON p.media_id=m.id
            WHERE COALESCE(p.source_media_id,m.id) IN (
                SELECT COALESCE(part.source_media_id,source.id) FROM media source
                LEFT JOIN media_parts part ON part.media_id=source.id WHERE source.id=ANY(:ids))"""),
            {"ids": list(media_ids)},
        ):
            if can_read_media(db, viewer_id, id):
                refs.add(ResourceRef("media", id))
    for ref in sorted(refs, key=lambda ref: ref.uri):
        bump_version(db, viewer_id=viewer_id, ref=ref, lane="evidence")
    if refs:
        db.execute(text("SELECT pg_notify('nexus_writing', :viewer)"), {"viewer": str(viewer_id)})


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
