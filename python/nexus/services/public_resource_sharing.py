"""What an anonymous share-link holder may read.

A link resolves to its grant by equality on the stored raw token, and the grant's subject
passes one readiness gate, the one link creation uses. The gate may only loosen: tightening
it would break links already handed out. A passing share is its summary, the whole reader
document projected through the public allowlist (ordinal unit ids, sanitized html, no
embeds or source issues), its EPUB images by ordinal, and the PDF's bytes; anything else is
one masked 404. The media row is locked FOR SHARE before its facts are read, so teardown
and republication serialize with a read and no read mixes generations.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, NoReturn
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.public_resource_sharing import (
    PublicHighlightOut,
    PublicPdfAnchorOut,
    PublicShareOut,
    PublicTextAnchorOut,
)
from nexus.schemas.reader import PdfPageGeometryTargetOut
from nexus.schemas.reader_document import (
    ReaderPdfDocumentOut,
    ReaderPdfFileOut,
    ReaderPointOut,
    ReaderSectionOut,
    ReaderTextDocumentOut,
    ReaderTocNodeOut,
    ReaderUnitOut,
)
from nexus.services import resource_grants
from nexus.services.capabilities import is_text_document_ready
from nexus.services.contributor_credits import load_current_source_author_bylines
from nexus.services.epub_assets import list_public_epub_asset_sources
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.public_html import sanitize_public_html
from nexus.services.public_source_urls import public_source_url
from nexus.services.reader_document import build_reader_document
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.client import StorageError, get_storage_client, read_object_checked

Readiness = Literal["ProjectionNotReady", "ProjectionUnsupported"]
_UNSUPPORTED: Readiness = "ProjectionUnsupported"

# Every fact the gate reads, in one statement after the lock: no section or asset read.
_FACTS_SQL = """
    SELECT m.kind, m.title, m.processing_status, mts.transcript_state, mts.transcript_coverage,
           mts.transcript_origin, f.storage_path, f.content_type, f.size_bytes,
           EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id = m.id) AS tearing_down,
           EXISTS (SELECT 1 FROM fragments fr WHERE fr.media_id = m.id) AS has_text,
           EXISTS (SELECT 1 FROM media_source_attempts e WHERE e.media_id = m.id
                   AND e.status = 'succeeded' AND e.source_type IN
                   ('remote_epub_url', 'uploaded_epub_file', 'browser_epub_capture')) AS epub_source,
           a.id AS attempt_id, a.source_type, a.provider, a.provider_target_ref,
           a.canonical_source_url, a.requested_url
    FROM media m
    LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    LEFT JOIN media_file f ON f.media_id = m.id
    LEFT JOIN LATERAL (
        SELECT * FROM media_source_attempts WHERE media_id = m.id AND status = 'succeeded'
        ORDER BY attempt_no DESC, id DESC LIMIT 1
    ) a ON TRUE
    WHERE m.id = :media_id
"""


@dataclass(frozen=True, slots=True)
class _Share:
    media_id: UUID
    kind: str
    title: str
    source_url: str | None
    highlight: PublicHighlightOut | None
    pdf: tuple[str, int] | None  # (storage path, size) of a readable PDF


def _gone() -> NoReturn:
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable")


def _load(db: Session, scheme: str, subject_id: UUID) -> _Share | Readiness:
    """The one readiness gate; a passing subject's facts."""
    media = (
        ":id" if scheme == "media" else "(SELECT anchor_media_id FROM highlights WHERE id = :id)"
    )
    lock = text(f"SELECT m.id FROM media m WHERE m.id = {media} FOR SHARE OF m")
    media_id = db.execute(lock, {"id": subject_id}).scalar()
    if media_id is None:
        return _UNSUPPORTED
    facts = db.execute(text(_FACTS_SQL), {"media_id": media_id}).mappings().one()
    kind = facts["kind"]
    if facts["tearing_down"]:
        return _UNSUPPORTED
    if not is_text_document_ready(
        kind, facts["processing_status"], facts["transcript_state"], facts["transcript_coverage"]
    ):
        return "ProjectionNotReady"
    source_url = public_source_url(facts)
    pdf = kind == "pdf" and facts["content_type"] == "application/pdf" and facts["size_bytes"] > 0
    if (
        facts["attempt_id"] is None
        or (kind == "podcast_episode" and facts["transcript_origin"] != "Publisher")
        or (kind == "video" and (facts["source_type"] != "youtube_video" or source_url is None))
        or (kind == "epub" and not facts["epub_source"])
        or (kind == "pdf" and not pdf)
        or (kind != "pdf" and not facts["has_text"])
    ):
        return _UNSUPPORTED
    highlight = _highlight(db, subject_id) if scheme == "highlight" else None
    if scheme == "highlight" and highlight is None:
        return _UNSUPPORTED
    return _Share(
        media_id=media_id,
        kind=kind,
        title=facts["title"],
        source_url=source_url,
        highlight=highlight,
        pdf=(facts["storage_path"], facts["size_bytes"]) if pdf else None,
    )


def _highlight(db: Session, highlight_id: UUID) -> PublicHighlightOut | None:
    """The shared highlight's quote, color and id-free anchor, or None if it does not resolve."""
    target = resolve_highlight_reader_target(db, highlight_id=highlight_id)
    if target is None:
        return None
    on_pdf = isinstance(target, PdfPageGeometryTargetOut)
    row = db.execute(
        text(
            "SELECT h.exact, h.color, f.idx FROM highlights h LEFT JOIN fragments f"
            " ON f.id = :fragment_id AND f.media_id = h.anchor_media_id WHERE h.id = :id"
        ),
        {"id": highlight_id, "fragment_id": None if on_pdf else target.fragment_id},
    ).one_or_none()
    if row is None:
        return None
    if isinstance(target, PdfPageGeometryTargetOut):
        anchor = PublicPdfAnchorOut(page_number=target.page_number, quads=target.quads)
    elif row.idx is None:
        return None
    else:
        start, end = target.start_offset, target.end_offset
        anchor = PublicTextAnchorOut(ordinal=row.idx, start_offset=start, end_offset=end)
    return PublicHighlightOut(quote=row.exact or None, color=row.color, anchor=anchor)


def _open(db: Session, token: str) -> _Share:
    grant = resource_grants.link_grant(db, token)
    share = None if grant is None else _load(db, grant.subject_scheme, grant.subject_id)
    if not isinstance(share, _Share):
        _gone()
    return share


def link_readiness(db: Session, subject: ResourceRef) -> Readiness | None:
    """Why a link to the subject would not open now, or None when it would."""
    share = _load(db, subject.scheme, subject.id)
    return None if isinstance(share, _Share) else share


def read_share(db: Session, token: str) -> PublicShareOut:
    share = _open(db, token)
    return PublicShareOut(
        title=share.title,
        bylines=load_current_source_author_bylines(db, media_id=share.media_id),
        source_url=share.source_url,
        highlight=share.highlight,
    )


def read_document(db: Session, token: str) -> ReaderTextDocumentOut | ReaderPdfDocumentOut:
    """The shared media's reader document, rebuilt field by field: an allowlist, so a field
    the private read gains never crosses unseen. Units are addressed by ordinal, html passes
    the public policy, EPUB images carry their ordinal, embeds and source issues stay out."""
    share = _open(db, token)
    try:
        document = build_reader_document(
            db,
            media_id=share.media_id,
            viewer_id=None,
            pdf_file=lambda: ReaderPdfFileOut(
                url="/api/public/resource-share/file", expires_at=None
            ),
        )
    except ApiError:
        _gone()
    if isinstance(document, ReaderPdfDocumentOut):
        return ReaderPdfDocumentOut(
            kind="pdf",
            identity=document.identity,
            title=document.title,
            page_count=document.page_count,
            file=document.file,
        )
    epub = share.kind == "epub"
    images = list_public_epub_asset_sources(db, media_id=share.media_id) if epub else []
    assets = {image.asset_key: str(image.ordinal) for image in images}
    ordinals = {unit.id: str(unit.idx) for unit in document.units}

    def point(at: ReaderPointOut) -> ReaderPointOut:
        return ReaderPointOut(unit_id=ordinals[at.unit_id], offset=at.offset)

    def node(toc: ReaderTocNodeOut) -> ReaderTocNodeOut:
        return ReaderTocNodeOut(
            id=toc.id,
            label=toc.label,
            at=None if toc.at is None else point(toc.at),
            section_id=toc.section_id,
            children=[node(child) for child in toc.children],
        )

    return ReaderTextDocumentOut(
        kind=document.kind,
        identity=document.identity,
        title=document.title,
        units=[
            ReaderUnitOut(
                id=ordinals[unit.id],
                idx=unit.idx,
                html_sanitized=sanitize_public_html(
                    unit.html_sanitized, units=ordinals, assets=assets
                ),
                canonical_text=unit.canonical_text,
                char_count=unit.char_count,
                href_path=None,
                t_start_ms=unit.t_start_ms,
                t_end_ms=unit.t_end_ms,
                speaker_label=unit.speaker_label,
            )
            for unit in document.units
        ],
        sections=[
            ReaderSectionOut(
                id=section.id,
                label=section.label,
                depth=section.depth,
                at=point(section.at),
                anchor_id=section.anchor_id,
            )
            for section in document.sections
        ],
        toc_nodes=[node(toc) for toc in document.toc_nodes],
        source_issues=[],
        embeds=[],
    )


def read_asset(db: Session, token: str, ordinal: str) -> tuple[bytes, str]:
    """An EPUB image's bytes and content type, by its ordinal in the public image list.

    Published EPUB content is immutable, so an ordinal names one image for as long as the
    link lives."""
    share = _open(db, token)
    if share.kind != "epub" or not re.fullmatch(r"[0-9]{1,9}", ordinal):
        _gone()
    images = list_public_epub_asset_sources(db, media_id=share.media_id)
    if int(ordinal) >= len(images):
        _gone()
    image = images[int(ordinal)]
    try:
        storage = get_storage_client()
        data = read_object_checked(storage, image.storage_path, expected_size=image.size_bytes)
    except StorageError:
        _gone()
    return data, image.content_type


def pdf_source(db: Session, token: str) -> tuple[str, int]:
    """The shared PDF's storage path and size; the caller streams it."""
    share = _open(db, token)
    if share.pdf is None:
        _gone()
    return share.pdf
