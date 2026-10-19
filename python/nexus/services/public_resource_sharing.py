"""What an anonymous share-link holder may read.

A link resolves to its grant by equality on the stored raw token, and the grant's subject
passes one readiness gate, the one link creation uses. The gate may only loosen: tightening
it would break links already handed out. A passing share is its summary, the whole reader
document projected through the public allowlist (ordinal unit ids, sanitized html,
source links for unrendered X embeds, no private bindings or source issues), its EPUB
images by ordinal, and the PDF's bytes; anything else is one masked 404. The media row
is locked FOR SHARE before its facts are read, so teardown and republication serialize
with a read and no read mixes generations.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, NoReturn
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.document_embeds import (
    DocumentEmbedDisplayActionOut,
    DocumentEmbedDisplayOut,
    DocumentEmbedLocatorOut,
    DocumentEmbedOut,
    DocumentEmbedProviderRefOut,
    DocumentEmbedTargetOut,
    DocumentEmbedTextOut,
    DocumentEmbedUrlOut,
)
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
    ReaderXCaptureOut,
    ReaderXPostOut,
    ReaderXReferenceOut,
)
from nexus.services import resource_grants
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.capabilities import is_text_document_ready
from nexus.services.contributor_credits import load_current_source_author_bylines
from nexus.services.epub_assets import list_public_epub_asset_sources
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.public_html import sanitize_public_html
from nexus.services.public_source_urls import public_source_url
from nexus.services.reader_document import build_reader_document
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.x_identity import (
    canonical_x_article_url,
    classify_x_article_url,
    classify_x_url,
)
from nexus.storage.client import StorageError, get_storage_client

Readiness = Literal["ProjectionNotReady", "ProjectionUnsupported"]
_UNSUPPORTED: Readiness = "ProjectionUnsupported"

# Every fact the gate reads, in one statement after the lock: no section or asset read.
_FACTS_SQL = """
    SELECT m.kind, m.title, m.processing_status, mts.transcript_state, mts.transcript_coverage,
           mts.transcript_origin, f.storage_path, f.content_type, f.size_bytes,
           EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id = m.id) AS tearing_down,
           (EXISTS (SELECT 1 FROM fragments fr WHERE fr.media_id = m.id)
            OR EXISTS (SELECT 1 FROM x_thread_posts xp JOIN fragments fr ON fr.media_id=xp.post_media_id
                       WHERE xp.thread_media_id=m.id)) AS has_text,
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
            "SELECT h.exact, h.color, h.anchor_media_id, f.idx FROM highlights h LEFT JOIN fragments f"
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
        ordinal = row.idx
        if db.scalar(
            text("""SELECT EXISTS (SELECT 1 FROM x_post_sources WHERE media_id=:id)
                    OR EXISTS (SELECT 1 FROM document_embeds WHERE media_id=:id AND provider='x')"""),
            {"id": row.anchor_media_id},
        ):
            document = build_reader_document(
                db,
                media_id=row.anchor_media_id,
                viewer_id=None,
                pdf_file=lambda: ReaderPdfFileOut(
                    url="/api/public/resource-share/file", expires_at=None
                ),
            )
            if not isinstance(document, ReaderTextDocumentOut):
                return None
            unit = next(
                (
                    unit
                    for unit in document.units
                    if unit.id == str(target.fragment_id)
                    or (
                        unit.x_post is not None
                        and unit.x_post.relation == "primary"
                        and unit.x_post.owner is not None
                        and unit.x_post.owner.fragment_id == target.fragment_id
                    )
                ),
                None,
            )
            if unit is None:
                return None
            ordinal = unit.idx
        anchor = PublicTextAnchorOut(ordinal=ordinal, start_offset=start, end_offset=end)
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
    the public policy, EPUB images carry their ordinal, and X source links retain no
    private binding. Other embeds and source issues stay out."""
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
    section_ids = {section.id: f"s{index}" for index, section in enumerate(document.sections)}
    slots = {
        unit.x_post.embed_occurrence_key: f"x{unit.idx}"
        for unit in document.units
        if unit.x_post is not None and unit.x_post.embed_occurrence_key is not None
    }
    for unit in document.units:
        for key in canonicalize_structure(unit.html_sanitized).x_embed_slots:
            if key not in slots:
                slots[key] = f"x{len(document.units) + len(slots)}"
    rendered_x_slots = {
        (unit.x_post.parent_unit_id, unit.x_post.embed_occurrence_key)
        for unit in document.units
        if unit.x_post is not None and unit.x_post.relation == "embedded"
    }
    embeds: list[DocumentEmbedOut] = []
    for row in db.execute(
        text("""SELECT fragment_id, occurrence_key, source_shape, resolution_status,
                       canonical_source_url, source_url, error_code
                FROM document_embeds WHERE media_id=:id AND provider='x'
                  AND NOT EXISTS (SELECT 1 FROM x_post_sources WHERE media_id=:id)
                ORDER BY ordinal, id"""),
        {"id": share.media_id},
    ):
        if (str(row.fragment_id), row.occurrence_key) in rendered_x_slots:
            continue
        source = classify_x_url(row.canonical_source_url or row.source_url or "")
        if source is None:
            continue
        slot = slots.setdefault(row.occurrence_key, f"x{len(document.units) + len(slots)}")
        absent_text = DocumentEmbedTextOut(kind="absent", value=None, reason="not_applicable")
        source_url = DocumentEmbedUrlOut(
            status="present", value=source.canonical_url, error_code=None, reason=None
        )
        embeds.append(
            DocumentEmbedOut(
                id=uuid5(NAMESPACE_URL, f"nexus:public-embed:{len(embeds)}"),
                media_id=None,
                fragment_id=None,
                occurrence_key=slot,
                ordinal=len(embeds),
                provider="x",
                kind="post",
                source_shape=row.source_shape,
                resolution_status=row.resolution_status,
                source_url=source_url,
                canonical_url=source_url,
                provider_target_ref=DocumentEmbedProviderRefOut(
                    kind="present", value=source.provider_id, reason=None
                ),
                title=DocumentEmbedTextOut(kind="present", value="embedded post", reason=None),
                description=absent_text,
                thumbnail_url=DocumentEmbedUrlOut(
                    status="absent", value=None, error_code=None, reason="not_applicable"
                ),
                authored_text=absent_text,
                locator=DocumentEmbedLocatorOut(
                    kind="unanchored",
                    unit_id=None,
                    fragment_id=None,
                    canonical_start_offset=None,
                    canonical_end_offset=None,
                    document_order_key=slot,
                    placeholder_text="",
                ),
                target=DocumentEmbedTargetOut(
                    status="unanchorable",
                    media_id=None,
                    resource_ref=None,
                    href=None,
                    kind=None,
                    title=None,
                    byline=None,
                    x_article_content=None,
                    thumbnail_url=None,
                    playback=None,
                ),
                error_code=absent_text,
                display=DocumentEmbedDisplayOut(
                    mode="pending"
                    if row.resolution_status == "resolving"
                    else "failed"
                    if row.resolution_status == "failed"
                    else "unsupported"
                    if row.resolution_status == "unsupported"
                    else "resolved",
                    label="embedded post",
                    description="post unavailable on x"
                    if row.error_code == "E_X_POST_UNAVAILABLE"
                    else "embedded post",
                    actions=[
                        DocumentEmbedDisplayActionOut(
                            kind="open_original", label="open on x", href=source.canonical_url
                        )
                    ],
                ),
            )
        )

    for embed in document.embeds:
        if embed.provider != "x" or embed.kind != "link_preview":
            continue
        unit_id = embed.locator.unit_id
        if unit_id is None or unit_id not in ordinals:
            # justify-defect: native article projection binds every preview to a reader unit.
            raise AssertionError("Article preview has no carrier occurrence")
        article_id = classify_x_article_url(
            embed.canonical_url.value or embed.source_url.value or ""
        )
        if article_id is None:
            continue
        url = canonical_x_article_url(article_id)
        slot = slots.setdefault(embed.occurrence_key, f"x{len(document.units) + len(slots)}")
        absent_text = DocumentEmbedTextOut(kind="absent", value=None, reason="not_applicable")
        source_url = DocumentEmbedUrlOut(status="present", value=url, error_code=None, reason=None)
        embeds.append(
            DocumentEmbedOut(
                id=uuid5(NAMESPACE_URL, f"nexus:public-embed:{len(embeds)}"),
                media_id=None,
                fragment_id=None,
                occurrence_key=slot,
                ordinal=len(embeds),
                provider="x",
                kind="link_preview",
                source_shape=embed.source_shape,
                resolution_status=None,
                source_url=source_url,
                canonical_url=source_url,
                provider_target_ref=DocumentEmbedProviderRefOut(
                    kind="present", value=f"article:{article_id}", reason=None
                ),
                title=absent_text,
                description=absent_text,
                thumbnail_url=DocumentEmbedUrlOut(
                    status="absent", value=None, error_code=None, reason="not_applicable"
                ),
                authored_text=absent_text,
                locator=DocumentEmbedLocatorOut(
                    kind="unanchored",
                    unit_id=ordinals[unit_id],
                    fragment_id=None,
                    canonical_start_offset=None,
                    canonical_end_offset=None,
                    document_order_key=slot,
                    placeholder_text="x article",
                ),
                target=DocumentEmbedTargetOut(
                    status="unanchorable",
                    media_id=None,
                    resource_ref=None,
                    href=None,
                    kind=None,
                    title=None,
                    byline=None,
                    x_article_content=None,
                    thumbnail_url=None,
                    playback=None,
                ),
                error_code=absent_text,
                display=DocumentEmbedDisplayOut(
                    mode=None,
                    label="x article",
                    description=None,
                    actions=[
                        DocumentEmbedDisplayActionOut(
                            kind="open_original", label="open on x", href=url
                        )
                    ],
                ),
            )
        )

    def point(at: ReaderPointOut) -> ReaderPointOut:
        return ReaderPointOut(unit_id=ordinals[at.unit_id], offset=at.offset)

    def node(toc: ReaderTocNodeOut) -> ReaderTocNodeOut:
        return ReaderTocNodeOut(
            id=toc.id,
            label=toc.label,
            at=None if toc.at is None else point(toc.at),
            section_id=None if toc.section_id is None else section_ids[toc.section_id],
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
                    unit.html_sanitized, units=ordinals, assets=assets, embed_slots=slots
                ),
                canonical_text=unit.canonical_text,
                char_count=unit.char_count,
                href_path=None,
                t_start_ms=unit.t_start_ms,
                t_end_ms=unit.t_end_ms,
                speaker_label=unit.speaker_label,
                x_post=None
                if unit.x_post is None
                else ReaderXPostOut(
                    logical_post_id=unit.x_post.logical_post_id,
                    source_revision_id=unit.x_post.source_revision_id,
                    relation=unit.x_post.relation,
                    parent_unit_id=None
                    if unit.x_post.parent_unit_id is None
                    else ordinals[unit.x_post.parent_unit_id],
                    embed_occurrence_key=None
                    if unit.x_post.embed_occurrence_key is None
                    else slots[unit.x_post.embed_occurrence_key],
                    insertion_offset=unit.x_post.insertion_offset,
                    referenced_revision_id=unit.x_post.referenced_revision_id,
                    checked_in_capture=unit.x_post.checked_in_capture,
                    source_url=unit.x_post.source_url,
                    author=unit.x_post.author,
                    created_at=unit.x_post.created_at,
                    is_edited=unit.x_post.is_edited,
                    availability=unit.x_post.availability,
                    body_captured_at=unit.x_post.body_captured_at,
                    checked_at=unit.x_post.checked_at,
                    references=[
                        ReaderXReferenceOut(
                            relation=reference.relation,
                            referenced_revision_id=reference.referenced_revision_id,
                            source_url=reference.source_url,
                            target_unit_id=ordinals.get(reference.target_unit_id)
                            if reference.target_unit_id is not None
                            else None,
                            availability=reference.availability,
                        )
                        for reference in unit.x_post.references
                    ],
                    owner=None,
                ),
            )
            for unit in document.units
        ],
        sections=[
            ReaderSectionOut(
                id=section_ids[section.id],
                label=section.label,
                depth=section.depth,
                at=point(section.at),
                anchor_id=section.anchor_id,
            )
            for section in document.sections
        ],
        toc_nodes=[node(toc) for toc in document.toc_nodes],
        source_issues=[],
        embeds=embeds,
        x_article_content=document.x_article_content,
        x_capture=None
        if document.x_capture is None
        else ReaderXCaptureOut(
            scope=document.x_capture.scope,
            saved_at=document.x_capture.saved_at,
            primary_post_count=document.x_capture.primary_post_count,
            root_revision_id=document.x_capture.root_revision_id,
            search_exhausted=document.x_capture.search_exhausted,
            limits=document.x_capture.limits,
            unresolved_parent_count=document.x_capture.unresolved_parent_count,
            unchecked_post_count=document.x_capture.unchecked_post_count,
            unavailable_context_count=document.x_capture.unavailable_context_count,
            uncaptured_context_count=document.x_capture.uncaptured_context_count,
        ),
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
        data = get_storage_client().read_object(image.storage_path, expected_size=image.size_bytes)
    except StorageError:
        _gone()
    return data, image.content_type


def pdf_source(db: Session, token: str) -> tuple[str, int]:
    """The shared PDF's storage path and size; the caller streams it."""
    share = _open(db, token)
    if share.pdf is None:
        _gone()
    return share.pdf
