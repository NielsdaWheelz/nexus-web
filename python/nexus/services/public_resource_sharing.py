"""What an anonymous share-link holder may read.

A link resolves to its grant by equality on the stored raw token, and the grant's subject
passes one readiness gate, the one link creation uses. The gate may only loosen: tightening
it would break links already handed out. A passing share is its summary, the whole reader
document projected through the public allowlist (ordinal unit ids, sanitized html, no
embeds or source issues), EPUB images fetched by handles sealed to (grant, media, content
revision), and the PDF's bytes; anything else is one masked 404. The media row is locked
FOR SHARE before its facts are read, so teardown and dedupe serialize with a read and no
read mixes generations.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Literal, NoReturn
from uuid import UUID

from sqlalchemy import RowMapping, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceGrant
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.presence import presence_from_nullable
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
from nexus.services.epub_assets import EpubAssetSource, list_public_epub_asset_sources
from nexus.services.epub_read import EpubFragmentSourceContent, list_epub_fragment_sources
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.media_file_access import MediaFileSource, get_media_file_source
from nexus.services.public_html import sanitize_public_html
from nexus.services.public_source_urls import public_source_url
from nexus.services.reader_document import build_reader_document
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import derive_handle_key
from nexus.storage.client import StorageError, get_storage_client, read_object_checked

Readiness = Literal["ProjectionNotReady", "ProjectionUnsupported"]
_HandleDomain = Literal["asset"]
_HANDLE_PREFIX: dict[_HandleDomain, str] = {"asset": "nxpa1_"}
_UNSUPPORTED: Readiness = "ProjectionUnsupported"

_FACTS_SQL = """
    SELECT m.kind, m.title, m.processing_status, mts.transcript_state, mts.transcript_coverage,
           mts.last_request_reason,
           EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id = m.id) AS tearing_down,
           a.id AS attempt_id, a.attempt_no, a.source_type, a.provider, a.provider_target_ref,
           a.canonical_source_url, a.requested_url, e.id AS epub_attempt_id,
           e.attempt_no AS epub_attempt_no, e.source_type AS epub_source_type
    FROM media m
    LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    LEFT JOIN LATERAL (
        SELECT * FROM media_source_attempts WHERE media_id = m.id AND status = 'succeeded'
        ORDER BY attempt_no DESC, id DESC LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
        SELECT * FROM media_source_attempts WHERE media_id = m.id AND status = 'succeeded'
          AND source_type IN ('remote_epub_url', 'uploaded_epub_file', 'browser_epub_capture')
        ORDER BY attempt_no DESC, id DESC LIMIT 1
    ) e ON TRUE
    WHERE m.id = :media_id
"""


@dataclass(frozen=True, slots=True)
class _Share:
    media_id: UUID
    kind: str
    title: str
    source_url: str | None
    highlight: PublicHighlightOut | None
    assets: list[EpubAssetSource]
    epub_digest: bytes
    pdf: MediaFileSource | None


def _gone() -> NoReturn:
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable")


def _load(db: Session, scheme: str, subject_id: UUID) -> _Share | Readiness:
    """The one readiness gate; a passing subject's document facts."""
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
    if (
        facts["attempt_id"] is None
        or (kind == "podcast_episode" and facts["last_request_reason"] != "rss_feed")
        or (kind == "video" and facts["source_type"] not in {"youtube_video", "video_transcript"})
        or (kind == "video" and source_url is None)
    ):
        return _UNSUPPORTED

    assets, epub_digest, pdf = [], b"", None
    if kind == "epub":
        sections = list_epub_fragment_sources(db, media_id=media_id, limit=2**31 - 1)
        if facts["epub_attempt_id"] is None or not sections:
            return _UNSUPPORTED
        assets = list_public_epub_asset_sources(db, media_id=media_id)
        epub_digest = _epub_digest(facts, sections, assets)
    elif kind == "pdf":
        pdf = get_media_file_source(db, media_id=media_id)
        if pdf is None or pdf.content_type != "application/pdf" or pdf.size_bytes < 1:
            return _UNSUPPORTED
    elif not db.scalar(
        text("SELECT EXISTS (SELECT 1 FROM fragments WHERE media_id = :media_id)"),
        {"media_id": media_id},
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
        assets=assets,
        epub_digest=epub_digest,
        pdf=pdf,
    )


def _highlight(db: Session, highlight_id: UUID) -> PublicHighlightOut | None:
    """The shared highlight's quote, color and handle-free anchor, or None if it does not resolve."""
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
    quote = presence_from_nullable(row.exact or None)
    return PublicHighlightOut(quote=quote, color=row.color, anchor=anchor)


def _epub_digest(
    facts: RowMapping, sections: list[EpubFragmentSourceContent], assets: list[EpubAssetSource]
) -> bytes:
    """The EPUB's content revision. Handed-out handles embed it, so its bytes never change."""
    digest = hashlib.sha256()
    parts: list[str | bytes] = [b"epub", facts["last_request_reason"] or ""]
    parts += [str(facts["attempt_id"]), str(facts["attempt_no"]), facts["source_type"]]
    parts += [b"source-owner", str(facts["epub_attempt_id"]), str(facts["epub_attempt_no"])]
    parts += [facts["epub_source_type"], b"sections", str(len(sections))]
    for s in sections:
        parts += [str(s.ordinal), s.label, str(s.depth), s.html_sanitized, s.canonical_text]
    parts += [b"assets", str(len(assets))]
    for a in assets:
        parts += [str(a.ordinal), a.asset_key, a.storage_path, a.content_type, str(a.size_bytes)]
    for part in parts:
        data = part if isinstance(part, bytes) else part.encode()
        digest.update(len(data).to_bytes(8, "big") + data)
    return hashlib.sha256(digest.digest()).digest()[:16]


def _tag(domain: _HandleDomain, grant: ResourceGrant, share: _Share, body: bytes) -> bytes:
    message = b"nexus-public-handle\0" + domain.encode() + b"\0" + b"1" + b"\0"
    message += grant.id.bytes + share.media_id.bytes + body
    return hmac.new(derive_handle_key(domain, "1"), message, hashlib.sha256).digest()[:16]


def _seal(domain: _HandleDomain, grant: ResourceGrant, share: _Share, ordinal: int) -> str:
    body = ordinal.to_bytes(4, "big") + share.epub_digest
    sealed = base64.urlsafe_b64encode(body + _tag(domain, grant, share, body))
    return _HANDLE_PREFIX[domain] + sealed.rstrip(b"=").decode()


def _unseal(domain: _HandleDomain, grant: ResourceGrant, share: _Share, handle: str) -> int:
    match = re.fullmatch(re.escape(_HANDLE_PREFIX[domain]) + r"([A-Za-z0-9_-]{48})", handle)
    if share.kind != "epub" or match is None:
        _gone()
    sealed = base64.urlsafe_b64decode(match[1])
    body = sealed[:4] + share.epub_digest
    if not hmac.compare_digest(sealed, body + _tag(domain, grant, share, body)):
        _gone()
    return int.from_bytes(sealed[:4], "big")


def _open(db: Session, token: str) -> tuple[ResourceGrant, _Share]:
    grant = resource_grants.link_grant(db, token)
    if grant is None:
        _gone()
    share = _load(db, grant.subject_scheme, grant.subject_id)
    if not isinstance(share, _Share):
        _gone()
    return grant, share


def link_readiness(db: Session, subject: ResourceRef) -> Readiness | None:
    """Why a link to the subject would not open now, or None when it would."""
    share = _load(db, subject.scheme, subject.id)
    return None if isinstance(share, _Share) else share


def read_share(db: Session, token: str) -> PublicShareOut:
    _, share = _open(db, token)
    return PublicShareOut(
        title=share.title,
        bylines=load_current_source_author_bylines(db, media_id=share.media_id),
        source_url=presence_from_nullable(share.source_url),
        highlight=presence_from_nullable(share.highlight),
    )


def read_document(db: Session, token: str) -> ReaderTextDocumentOut | ReaderPdfDocumentOut:
    """The shared media's reader document, built field by field: units are addressed by
    ordinal, html passes the public policy, and nothing else of the private read crosses."""
    grant, share = _open(db, token)
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
    handles = {a.asset_key: _seal("asset", grant, share, a.ordinal) for a in share.assets}
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
                html_sanitized=sanitize_public_html(unit.html_sanitized, handles.get),
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


def read_asset(db: Session, token: str, handle: str) -> tuple[bytes, str]:
    """An EPUB image's bytes and content type."""
    grant, share = _open(db, token)
    asset = share.assets[_unseal("asset", grant, share, handle)]
    try:
        data = read_object_checked(
            get_storage_client(), asset.storage_path, expected_size=asset.size_bytes
        )
    except StorageError:
        _gone()
    return data, asset.content_type


def pdf_source(db: Session, token: str) -> MediaFileSource:
    """The shared PDF's authorized storage facts; the caller streams it."""
    _, share = _open(db, token)
    if share.pdf is None:
        _gone()
    return share.pdf
