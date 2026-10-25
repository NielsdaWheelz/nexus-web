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
from urllib.parse import parse_qs, urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from lxml.html import fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
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
    PublicApparatusContentOut,
    PublicApparatusOut,
    PublicHighlightOut,
    PublicPdfAnchorOut,
    PublicShareOut,
    PublicTextAnchorOut,
)
from nexus.schemas.reader import PdfPageGeometryTargetOut
from nexus.schemas.reader_document import (
    ReaderPartDocumentOut,
    ReaderPdfDocumentOut,
    ReaderPdfFileOut,
    ReaderPointOut,
    ReaderSectionOut,
    ReaderTextBodyOut,
    ReaderTextDocumentOut,
    ReaderTocNodeOut,
    ReaderTranscriptDocumentOut,
    ReaderUnitOut,
    ReaderXCaptureOut,
    ReaderXPostOut,
    ReaderXReferenceOut,
    TranscriptNavigationOut,
    TranscriptReaderChapterOut,
    TranscriptReaderSearchExtentOut,
)
from nexus.services import library_entries, resource_grants
from nexus.services.canonicalize import canonicalize_structure, generate_canonical_text
from nexus.services.capabilities import is_text_document_ready
from nexus.services.contributor_credits import load_current_source_author_bylines
from nexus.services.epub_assets import list_public_epub_asset_sources
from nexus.services.image_validation import fetch_validated_image
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.media_text_scope import MediaTextScope, html_asset_urls, read_media_text_scope
from nexus.services.public_html import sanitize_public_html
from nexus.services.public_source_urls import public_source_url
from nexus.services.reader_apparatus import read_scoped_apparatus_bodies
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
    source_label: str | None
    highlight: PublicHighlightOut | None
    pdf: tuple[str, int] | None  # (storage path, size) of a readable PDF


def _gone() -> NoReturn:
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable")


def _load(db: Session, scheme: str, subject_id: UUID) -> _Share | Readiness:
    """The one readiness gate; a passing subject's facts."""
    media = (
        ":id" if scheme == "media" else "(SELECT anchor_media_id FROM highlights WHERE id = :id)"
    )
    media_id = db.execute(
        text(f"SELECT m.id FROM media m WHERE m.id = {media}"), {"id": subject_id}
    ).scalar()
    if media_id is None or not library_entries.lock_media_rows_in_order(db, [media_id]):
        return _UNSUPPORTED
    facts = db.execute(text(_FACTS_SQL), {"media_id": media_id}).mappings().one()
    kind = facts["kind"]
    if facts["tearing_down"]:
        return _UNSUPPORTED
    if kind == "text_part":
        try:
            scope = read_media_text_scope(db, media_id)
        except ApiError:
            return "ProjectionNotReady"
        source_title = db.scalar(
            text("SELECT title FROM media WHERE id=:id"), {"id": scope.source_media_id}
        )
        return _Share(
            media_id=media_id,
            kind=kind,
            title=facts["title"],
            source_url=None,
            source_label=source_title,
            highlight=None,
            pdf=None,
        )
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
        source_label=None,
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
            if not isinstance(document, ReaderTextBodyOut):
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
    if grant is None:
        _gone()
    subject = (grant.subject_scheme, grant.subject_id)
    share = _load(db, *subject)
    if not isinstance(share, _Share):
        _gone()
    # Revocation may have committed while _load waited for the subject's family lock.
    current = resource_grants.link_grant(db, token)
    if current is None or (current.subject_scheme, current.subject_id) != subject:
        _gone()
    return share


def link_readiness(db: Session, subject: ResourceRef) -> Readiness | None:
    """Why a link to the subject would not open now, or None when it would."""
    share = _load(db, subject.scheme, subject.id)
    return None if isinstance(share, _Share) else share


def _read_share(db: Session, token: str) -> PublicShareOut:
    share = _open(db, token)
    return PublicShareOut(
        title=share.title,
        bylines=load_current_source_author_bylines(db, media_id=share.media_id),
        source_url=share.source_url,
        source_label=share.source_label,
        highlight=share.highlight,
    )


def _read_document(
    db: Session, token: str
) -> ReaderTextDocumentOut | ReaderTranscriptDocumentOut | ReaderPdfDocumentOut:
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
    manifest = _text_manifest(db, share, document)
    assets = {image.key: str(index) for index, image in enumerate(manifest.assets)}
    ordinals = {unit.id: str(unit.idx) for unit in document.units}
    section_ids = {section.id: f"s{index}" for index, section in enumerate(document.sections)}
    toc_ids: dict[str, str] = {}

    def toc_identity(nodes: list[ReaderTocNodeOut]) -> None:
        for node in nodes:
            toc_ids[node.id] = f"t{len(toc_ids)}"
            toc_identity(node.children)

    toc_identity(document.toc_nodes)
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

    def public_html(html: str) -> str:
        try:
            return sanitize_public_html(
                html,
                units=ordinals,
                assets=assets,
                embed_slots=slots,
                apparatus=manifest.note_ordinals,
                anchors=manifest.anchors,
                expected_identity=document.identity,
            )
        except ValueError:
            _gone()

    def point(at: ReaderPointOut) -> ReaderPointOut:
        return ReaderPointOut(unit_id=ordinals[at.unit_id], offset=at.offset)

    def node(toc: ReaderTocNodeOut) -> ReaderTocNodeOut:
        return ReaderTocNodeOut(
            id=toc_ids[toc.id],
            label=toc.label,
            at=None if toc.at is None else point(toc.at),
            section_id=None if toc.section_id is None else section_ids[toc.section_id],
            children=[node(child) for child in toc.children],
        )

    body = ReaderTextBodyOut(
        identity=document.identity,
        title=document.title,
        units=[
            ReaderUnitOut(
                id=ordinals[unit.id],
                idx=unit.idx,
                html_sanitized=public_html(unit.html_sanitized),
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
                anchor_id=manifest.anchors.get(section.anchor_id)
                if section.anchor_id is not None
                else None,
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

    if isinstance(document, ReaderTranscriptDocumentOut):
        return ReaderTranscriptDocumentOut(
            **body.model_dump(),
            kind="transcript",
            transcript_coverage=document.transcript_coverage,
            transcript_navigation=TranscriptNavigationOut(
                key=document.transcript_navigation.key,
                chapters=[
                    TranscriptReaderChapterOut(
                        id=chapter.id,
                        label=chapter.label,
                        start_ms=chapter.start_ms,
                        end_ms=chapter.end_ms,
                        at=None if chapter.at is None else point(chapter.at),
                        search_extent=None
                        if chapter.search_extent is None
                        else TranscriptReaderSearchExtentOut(
                            start=point(chapter.search_extent.start),
                            end=point(chapter.search_extent.end),
                        ),
                    )
                    for chapter in document.transcript_navigation.chapters
                ],
            ),
        )
    return ReaderTextDocumentOut(
        **body.model_dump(),
        kind=document.source_format if document.kind == "text_part" else document.kind,
    )


@dataclass(frozen=True, slots=True)
class _PublicAsset:
    key: str
    storage_path: str | None
    content_type: str | None
    size_bytes: int | None
    image_url: str | None


@dataclass(frozen=True, slots=True)
class _PublicNoteBody:
    label: str | None
    html: str
    canonical_text: str


@dataclass(frozen=True, slots=True)
class _PublicNote:
    label: str | None
    content: tuple[_PublicNoteBody, ...]


@dataclass(frozen=True, slots=True)
class _TextManifest:
    assets: tuple[_PublicAsset, ...]
    notes: tuple[_PublicNote, ...]
    note_ordinals: dict[str, str]
    anchors: dict[str, str]


def _text_manifest(
    db: Session, share: _Share, document: ReaderTextBodyOut | ReaderPartDocumentOut
) -> _TextManifest:
    """One bounded manifest for every public text document, asset and apparatus read.

    The scope owner admits dependencies. This edge assigns only local ordinals;
    it never authorizes an asset from a caller-supplied source id or URL.
    """
    scope: MediaTextScope | None = None
    if share.kind in {"epub", "web_article", "text_part"}:
        scope = read_media_text_scope(db, share.media_id)
    notes: list[_PublicNote] = []
    note_ordinals: dict[str, str] = {}
    note_html: list[str] = []
    if scope is not None and scope.permitted_apparatus:
        rows = read_scoped_apparatus_bodies(db, scope)
        targets = {
            row.id: row
            for row in rows
            if row.body_html_sanitized is not None and not row.kind.endswith("_ref")
        }
        for row in targets.values():
            html = row.body_html_sanitized
            assert html is not None
            ordinal = str(len(notes))
            note_ordinals[str(row.id)] = ordinal
            note_ordinals[row.stable_key] = ordinal
            notes.append(
                _PublicNote(
                    row.label,
                    (
                        _PublicNoteBody(
                            row.label,
                            html,
                            row.body_text or generate_canonical_text(html),
                        ),
                    ),
                )
            )
            note_html.append(html)
        references: dict[UUID, tuple[str, list[int]]] = {}
        for edge in db.execute(
            text("""
            SELECT marker.id,marker.stable_key,edge.to_item_id FROM reader_apparatus_edges edge
            JOIN reader_apparatus_items marker ON marker.id=edge.from_item_id
            WHERE edge.media_id=:source AND edge.from_item_id=ANY(:ids)
            ORDER BY edge.sort_key,edge.id
        """),
            {"source": scope.source_media_id, "ids": list(scope.permitted_apparatus)},
        ):
            if str(edge.to_item_id) in note_ordinals:
                references.setdefault(edge.id, (edge.stable_key, []))[1].append(
                    int(note_ordinals[str(edge.to_item_id)])
                )
        by_id = {row.id: row for row in rows}
        for marker_id, (stable_key, target_ordinals) in references.items():
            content = tuple(
                body for index in dict.fromkeys(target_ordinals) for body in notes[index].content
            )
            ordinal = str(len(notes))
            notes.append(_PublicNote(by_id[marker_id].label, content))
            note_ordinals[str(marker_id)] = ordinal
            note_ordinals[stable_key] = ordinal
    html_bodies = [unit.html_sanitized for unit in document.units] + note_html
    anchors: dict[str, str] = {}
    for html in html_bodies:
        root = fragment_fromstring(html, create_parent=True)
        for node in root.xpath(".//*[@id]"):
            anchors.setdefault(node.get("id"), f"a{len(anchors)}")
    referenced = sorted(set().union(*(html_asset_urls(html) for html in html_bodies)))
    images = (
        {}
        if scope is None or scope.source_format != "epub"
        else {
            image.asset_key: image
            for image in list_public_epub_asset_sources(db, media_id=scope.source_media_id)
        }
    )
    assets: list[_PublicAsset] = []
    for src in referenced:
        match = re.fullmatch(
            r"/api/media/[0-9a-fA-F-]{36}/assets/([A-Za-z0-9_./-]+)", urlsplit(src).path
        )
        key = match[1] if match else src
        if any(asset.key == key for asset in assets):
            continue
        if key in images:
            image = images[key]
            assets.append(
                _PublicAsset(key, image.storage_path, image.content_type, image.size_bytes, None)
            )
        elif (
            scope is not None
            and scope.source_format == "web_article"
            and src in scope.permitted_assets
        ):
            proxy = urlsplit(src)
            urls = parse_qs(proxy.query).get("url", []) if proxy.path == "/api/media/image" else []
            if len(urls) == 1:
                assets.append(_PublicAsset(src, None, None, None, urls[0]))
    return _TextManifest(tuple(assets), tuple(notes), note_ordinals, anchors)


def _captured_manifest(
    db: Session, token: str, expected_identity: str | None
) -> tuple[ReaderTextBodyOut | ReaderPartDocumentOut, _TextManifest]:
    share = _open(db, token)
    document = build_reader_document(
        db,
        media_id=share.media_id,
        viewer_id=None,
        pdf_file=lambda: ReaderPdfFileOut(url="/api/public/resource-share/file", expires_at=None),
    )
    if expected_identity is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "expected_identity is required")
    if expected_identity != document.identity:
        raise ConflictError(
            ApiErrorCode.E_READER_CONTENT_CHANGED, "this piece changed. reload to continue."
        )
    if not isinstance(document, (ReaderTextBodyOut, ReaderPartDocumentOut)):
        _gone()
    return document, _text_manifest(db, share, document)


def _read_asset(
    db: Session, token: str, ordinal: str, expected_identity: str | None
) -> tuple[bytes, str]:
    """Authenticate, fence the captured body, then resolve its local asset ordinal."""
    _, manifest = _captured_manifest(db, token, expected_identity)
    if not re.fullmatch(r"[0-9]{1,9}", ordinal) or int(ordinal) >= len(manifest.assets):
        _gone()
    image = manifest.assets[int(ordinal)]
    if image.image_url is not None:
        fetched = fetch_validated_image(image.image_url)
        return fetched.data, fetched.content_type
    assert (
        image.storage_path is not None
        and image.size_bytes is not None
        and image.content_type is not None
    )
    try:
        data = get_storage_client().read_object(image.storage_path, expected_size=image.size_bytes)
    except StorageError:
        _gone()
    return data, image.content_type


def _read_apparatus(
    db: Session, token: str, ordinal: str, expected_identity: str | None
) -> PublicApparatusOut:
    document, manifest = _captured_manifest(db, token, expected_identity)
    if not re.fullmatch(r"[0-9]{1,9}", ordinal) or int(ordinal) >= len(manifest.notes):
        _gone()
    note = manifest.notes[int(ordinal)]
    content: list[PublicApparatusContentOut] = []
    for body in note.content:
        try:
            html = sanitize_public_html(
                body.html,
                units={unit.id: str(unit.idx) for unit in document.units},
                assets={image.key: str(index) for index, image in enumerate(manifest.assets)},
                apparatus=manifest.note_ordinals,
                anchors=manifest.anchors,
                expected_identity=document.identity,
            )
        except ValueError:
            _gone()
        content.append(
            PublicApparatusContentOut(
                label=body.label, html_sanitized=html, canonical_text=body.canonical_text
            )
        )
    return PublicApparatusOut(
        ordinal=int(ordinal), identity=document.identity, label=note.label, content=content
    )


def _pdf_source(db: Session, token: str) -> tuple[str, int]:
    """The shared PDF's storage path and size; the caller streams it."""
    share = _open(db, token)
    if share.pdf is None:
        _gone()
    return share.pdf


def read_share(db: Session, token: str) -> PublicShareOut:
    return retry_read_committed(db, "public_share", lambda: _read_share(db, token))


def read_document(
    db: Session, token: str
) -> ReaderTextDocumentOut | ReaderTranscriptDocumentOut | ReaderPdfDocumentOut:
    return retry_read_committed(db, "public_document", lambda: _read_document(db, token))


def read_asset(
    db: Session, token: str, ordinal: str, expected_identity: str | None
) -> tuple[bytes, str]:
    return retry_read_committed(
        db, "public_asset", lambda: _read_asset(db, token, ordinal, expected_identity)
    )


def read_apparatus(
    db: Session, token: str, ordinal: str, expected_identity: str | None
) -> PublicApparatusOut:
    return retry_read_committed(
        db, "public_apparatus", lambda: _read_apparatus(db, token, ordinal, expected_identity)
    )


def pdf_source(db: Session, token: str) -> tuple[str, int]:
    return retry_read_committed(db, "public_file", lambda: _pdf_source(db, token))
