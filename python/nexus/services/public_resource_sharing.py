"""Token-authorized, read-only anonymous media projection."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal, NoReturn
from uuid import UUID

from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.presence import absent, presence_from_nullable
from nexus.schemas.public_resource_sharing import (
    PublicArticleFragmentOut,
    PublicArticleFragmentPageOut,
    PublicArticleReaderOut,
    PublicArticleTextAnchorOut,
    PublicEpubReaderOut,
    PublicEpubTextAnchorOut,
    PublicFragmentPageOut,
    PublicHighlightOut,
    PublicHighlightSubjectOut,
    PublicMediaOut,
    PublicMediaSubjectOut,
    PublicNavigationItemOut,
    PublicNavigationPageOut,
    PublicPageInfo,
    PublicPdfGeometryAnchorOut,
    PublicPdfReaderOut,
    PublicReaderOut,
    PublicSectionOut,
    PublicShareBootstrapOut,
    PublicSubjectOut,
    PublicTimeRangeOut,
    PublicTranscriptReaderOut,
    PublicTranscriptSegmentOut,
    PublicTranscriptSegmentPageOut,
    PublicTranscriptTextAnchorOut,
)
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    PdfPageGeometryTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.services import locator_resolver
from nexus.services.capabilities import is_text_document_ready
from nexus.services.epub_assets import list_public_epub_asset_sources
from nexus.services.epub_read import (
    get_epub_section_source,
    list_epub_section_sources,
)
from nexus.services.media_file_access import (
    MediaFileSource,
    get_media_file_source,
    parse_single_byte_range,
)
from nexus.services.public_html import (
    sanitize_public_article_html,
    sanitize_public_epub_html,
)
from nexus.services.public_share_handles import (
    PublicHandleContext,
    seal_public_handle,
    unseal_public_handle,
)
from nexus.services.public_source_urls import current_public_source_url
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.read import read_object_checked

_MAX_PAGE_BYTES = 8 * 1024 * 1024
_MAX_ARTICLE_FIELD_BYTES = 2 * 1024 * 1024
_MAX_EPUB_FIELD_BYTES = 4 * 1024 * 1024
_MAX_EPUB_ASSET_BYTES = 25 * 1024 * 1024
_DEFAULT_LIMIT = 50
_MAX_LIMIT = 100
_MAX_SAFE_UINT = 2**53 - 1
_PDF_CONTENT_TYPE = "application/pdf"
_PLACEHOLDER_SECTION_HANDLE = "nxps1_" + ("A" * 48)
_PLACEHOLDER_ASSET_HANDLE = "nxpa1_" + ("A" * 48)
_PUBLIC_ASSET_CONTENT_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"}
)
_HANDLE_ADAPTERS = {
    "subject": TypeAdapter(PublicSubjectOut),
    "reader": TypeAdapter(PublicReaderOut),
    "fragments": TypeAdapter(PublicFragmentPageOut),
}


@dataclass(frozen=True, slots=True)
class Available:
    kind: Literal["Available"] = "Available"


@dataclass(frozen=True, slots=True)
class ProjectionNotReady:
    kind: Literal["ProjectionNotReady"] = "ProjectionNotReady"


@dataclass(frozen=True, slots=True)
class ProjectionUnsupported:
    kind: Literal["ProjectionUnsupported"] = "ProjectionUnsupported"


type ProjectionAvailability = Available | ProjectionNotReady | ProjectionUnsupported


@dataclass(frozen=True, slots=True)
class _MediaFacts:
    media_id: UUID
    kind: str
    title: str
    processing_status: str
    transcript_state: str | None
    transcript_coverage: str | None
    transcript_last_request_reason: str | None
    source_attempt_id: UUID | None
    source_attempt_no: int | None
    source_type: str | None
    duration_ms: int | None
    page_count: int | None


@dataclass(frozen=True, slots=True)
class _EpubSourceOwner:
    attempt_id: UUID
    attempt_no: int
    source_type: str


@dataclass(frozen=True, slots=True)
class _Projection:
    grant_id: UUID
    subject: ResourceRef
    media: _MediaFacts
    handle_context: PublicHandleContext
    highlight: PublicHighlightOut | None


@dataclass(frozen=True, slots=True)
class PublicAssetBody:
    data: bytes
    content_type: str


@dataclass(frozen=True, slots=True)
class PublicFileBody:
    chunks: Iterator[bytes]
    status_code: Literal[200, 206]
    content_length: int
    content_range: str | None
    filename: str


class PublicRangeNotSatisfiable(Exception):
    """Authorized PDF request supplied a malformed/unsatisfiable Range."""

    def __init__(self, size_bytes: int):
        self.size_bytes = size_bytes
        super().__init__("Requested range is not satisfiable")


class PublicRequestValidation(Exception):
    """Authorized public request has invalid route-local input."""


def highlight_target_available(db: Session, *, highlight_id: UUID) -> bool:
    """Return whether one highlight has an exact current format-total target."""
    return (
        locator_resolver.resolve_highlight_reader_target(
            db,
            highlight_id=highlight_id,
        )
        is not None
    )


def link_projection_availability(
    db: Session,
    *,
    subject: ResourceRef,
) -> ProjectionAvailability:
    """Return modeled link readiness without authorizing or creating a grant."""
    subject_facts = _load_subject_facts(db, subject=subject)
    if subject_facts is None:
        return ProjectionUnsupported()
    media, highlight_id = subject_facts
    if _media_has_teardown_intent(db, media.media_id):
        return ProjectionUnsupported()
    if not _is_media_ready(media):
        return ProjectionNotReady()
    if not _projection_shape_supported(db, media=media, highlight_id=highlight_id):
        return ProjectionUnsupported()
    return Available()


def get_public_bootstrap(
    db: Session,
    *,
    raw_token: str,
    query_items: list[tuple[str, str]] | None = None,
) -> PublicShareBootstrapOut:
    projection = _resolve_public_projection(db, raw_token=raw_token)
    _require_no_query(query_items)
    source_url = current_public_source_url(db, media_id=projection.media.media_id)
    bylines = _load_bylines(db, media_id=projection.media.media_id)
    media_kind = _public_media_kind(projection.media.kind)
    media_out = PublicMediaOut(
        title=projection.media.title,
        media_kind=media_kind,
        source_url=presence_from_nullable(source_url),
        bylines=bylines,
    )
    reader = _public_reader(projection.media, db=db)
    subject: PublicMediaSubjectOut | PublicHighlightSubjectOut
    if projection.highlight is None:
        subject = PublicMediaSubjectOut()
    else:
        subject = PublicHighlightSubjectOut(highlight=projection.highlight)
    return PublicShareBootstrapOut(
        subject=_HANDLE_ADAPTERS["subject"].validate_python(subject),
        media=media_out,
        reader=_HANDLE_ADAPTERS["reader"].validate_python(reader),
    )


def get_public_fragments(
    db: Session,
    *,
    raw_token: str,
    query_items: list[tuple[str, str]],
) -> PublicArticleFragmentPageOut | PublicTranscriptSegmentPageOut:
    projection = _resolve_public_projection(db, raw_token=raw_token)
    if projection.media.kind not in {"web_article", "video", "podcast_episode"}:
        _masked_not_found()
    raw_cursor, raw_limit = _parse_page_query(query_items)
    after_ordinal = _parse_cursor(raw_cursor, projection=projection)
    limit = _parse_limit(raw_limit)
    rows = (
        db.execute(
            text(
                """
                SELECT idx, html_sanitized, canonical_text,
                       t_start_ms, t_end_ms, speaker_label
                FROM fragments
                WHERE media_id = :media_id
                  AND idx > :after_ordinal
                ORDER BY idx ASC
                LIMIT :fetch_limit
                """
            ),
            {
                "media_id": projection.media.media_id,
                "after_ordinal": after_ordinal,
                "fetch_limit": limit + 1,
            },
        )
        .mappings()
        .all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    if projection.media.kind == "web_article":
        items: list[PublicArticleFragmentOut] = []
        for index, row in enumerate(rows):
            html = sanitize_public_article_html(str(row["html_sanitized"]))
            canonical_text = str(row["canonical_text"])
            candidate = PublicArticleFragmentOut(
                ordinal=int(row["idx"]),
                html_sanitized=html,
                canonical_text=canonical_text,
            )
            candidate_items = [*items, candidate]
            candidate_has_more = has_more or index < len(rows) - 1
            candidate_page = PublicArticleFragmentPageOut(
                items=candidate_items,
                page_info=_page_info(
                    candidate.ordinal if candidate_has_more else None,
                    projection,
                ),
            )
            if _serialized_envelope_size(candidate_page) > _MAX_PAGE_BYTES:
                if not items:
                    _masked_not_found()
                has_more = True
                break
            items.append(candidate)
        result = PublicArticleFragmentPageOut(
            items=items,
            page_info=_page_info(items[-1].ordinal if has_more and items else None, projection),
        )
        if _serialized_envelope_size(result) > _MAX_PAGE_BYTES:
            _masked_not_found()
        return _HANDLE_ADAPTERS["fragments"].validate_python(result)

    transcript_items: list[PublicTranscriptSegmentOut] = []
    for index, row in enumerate(rows):
        canonical_text = str(row["canonical_text"])
        candidate = PublicTranscriptSegmentOut(
            ordinal=int(row["idx"]),
            canonical_text=canonical_text,
            time_range=_time_range_presence(row["t_start_ms"], row["t_end_ms"]),
            speaker=presence_from_nullable(
                str(row["speaker_label"]) if row["speaker_label"] is not None else None
            ),
        )
        candidate_items = [*transcript_items, candidate]
        candidate_has_more = has_more or index < len(rows) - 1
        candidate_page = PublicTranscriptSegmentPageOut(
            items=candidate_items,
            page_info=_page_info(
                candidate.ordinal if candidate_has_more else None,
                projection,
            ),
        )
        if _serialized_envelope_size(candidate_page) > _MAX_PAGE_BYTES:
            if not transcript_items:
                _masked_not_found()
            has_more = True
            break
        transcript_items.append(candidate)
    result = PublicTranscriptSegmentPageOut(
        items=transcript_items,
        page_info=_page_info(
            transcript_items[-1].ordinal if has_more and transcript_items else None,
            projection,
        ),
    )
    if _serialized_envelope_size(result) > _MAX_PAGE_BYTES:
        _masked_not_found()
    return _HANDLE_ADAPTERS["fragments"].validate_python(result)


def get_public_navigation(
    db: Session,
    *,
    raw_token: str,
    query_items: list[tuple[str, str]],
) -> PublicNavigationPageOut:
    projection = _resolve_public_projection(db, raw_token=raw_token)
    if projection.media.kind != "epub":
        _masked_not_found()
    raw_cursor, raw_limit = _parse_page_query(query_items)
    after_ordinal = _parse_cursor(raw_cursor, projection=projection)
    limit = _parse_limit(raw_limit)
    rows = list_epub_section_sources(
        db,
        media_id=projection.media.media_id,
        after_ordinal=after_ordinal,
        limit=limit + 1,
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [
        PublicNavigationItemOut(
            ordinal=row.ordinal,
            label=row.label,
            depth=row.depth,
            section_handle=seal_public_handle(
                "section",
                ordinal=row.ordinal,
                context=projection.handle_context,
            ),
        )
        for row in rows
    ]
    return PublicNavigationPageOut(
        items=items,
        page_info=_page_info(items[-1].ordinal if has_more and items else None, projection),
    )


def get_public_section(
    db: Session,
    *,
    raw_token: str,
    raw_section_handle: str,
    query_items: list[tuple[str, str]] | None = None,
) -> PublicSectionOut:
    projection = _resolve_public_projection(db, raw_token=raw_token)
    _require_no_query(query_items)
    if projection.media.kind != "epub":
        _masked_not_found()
    ordinal = unseal_public_handle(
        "section",
        raw_section_handle,
        context=projection.handle_context,
    )
    if ordinal is None:
        _masked_not_found()
    source = get_epub_section_source(
        db,
        media_id=projection.media.media_id,
        ordinal=ordinal,
    )
    if source is None:
        _masked_not_found()
    assets = list_public_epub_asset_sources(db, media_id=projection.media.media_id)
    asset_handle_by_key = {
        asset.asset_key: seal_public_handle(
            "asset",
            ordinal=asset.ordinal,
            context=projection.handle_context,
        )
        for asset in assets
    }
    html = sanitize_public_epub_html(
        source.html_sanitized,
        asset_handle_for_key=asset_handle_by_key.get,
    )
    try:
        result = PublicSectionOut(
            ordinal=source.ordinal,
            section_handle=raw_section_handle,
            html_sanitized=html,
            canonical_text=source.canonical_text,
        )
        if _serialized_envelope_size(result) > _MAX_PAGE_BYTES:
            _masked_not_found()
        return result
    except ValidationError:
        _masked_not_found()


def get_public_asset(
    db: Session,
    *,
    raw_token: str,
    raw_asset_handle: str,
    query_items: list[tuple[str, str]] | None = None,
    storage_client: StorageClientBase | None = None,
) -> PublicAssetBody:
    projection = _resolve_public_projection(db, raw_token=raw_token)
    _require_no_query(query_items)
    if projection.media.kind != "epub":
        _masked_not_found()
    ordinal = unseal_public_handle(
        "asset",
        raw_asset_handle,
        context=projection.handle_context,
    )
    if ordinal is None:
        _masked_not_found()
    sources = list_public_epub_asset_sources(db, media_id=projection.media.media_id)
    source = next((candidate for candidate in sources if candidate.ordinal == ordinal), None)
    if (
        source is None
        or source.content_type not in _PUBLIC_ASSET_CONTENT_TYPES
        or source.size_bytes < 0
        or source.size_bytes > _MAX_EPUB_ASSET_BYTES
    ):
        _masked_not_found()
    try:
        data = read_object_checked(
            storage_client or get_storage_client(),
            source.storage_path,
            expected_size=source.size_bytes,
        )
    except StorageError:
        _masked_not_found()
    return PublicAssetBody(data=data, content_type=source.content_type)


def get_public_pdf_file(
    db: Session,
    *,
    raw_token: str,
    raw_range: str | None,
    query_items: list[tuple[str, str]] | None = None,
    storage_client: StorageClientBase | None = None,
) -> PublicFileBody:
    """Authorize first, then interpret Range for one private PDF object."""
    projection = _resolve_public_projection(db, raw_token=raw_token)
    _require_no_query(query_items)
    if projection.media.kind != "pdf":
        _masked_not_found()
    storage = storage_client or get_storage_client()
    source = _validated_public_pdf_source(
        db,
        media_id=projection.media.media_id,
        storage_client=storage,
    )
    if source is None:
        _masked_not_found()
    filename = _pdf_filename(projection.media.title)
    if raw_range is None:
        return PublicFileBody(
            chunks=_verified_stream(
                storage.stream_object(source.storage_path),
                expected_length=source.size_bytes,
            ),
            status_code=200,
            content_length=source.size_bytes,
            content_range=None,
            filename=filename,
        )
    try:
        byte_range = parse_single_byte_range(raw_range, size_bytes=source.size_bytes)
    except ValueError as exc:
        raise PublicRangeNotSatisfiable(source.size_bytes) from exc
    return PublicFileBody(
        chunks=_verified_stream(
            storage.stream_object_range(
                source.storage_path,
                start=byte_range.start,
                end_inclusive=byte_range.end,
            ),
            expected_length=byte_range.length,
        ),
        status_code=206,
        content_length=byte_range.length,
        content_range=f"bytes {byte_range.start}-{byte_range.end}/{source.size_bytes}",
        filename=filename,
    )


def _resolve_public_projection(db: Session, *, raw_token: str) -> _Projection:
    try:
        from nexus.services.resource_grants import resolve_link_token

        resolved = resolve_link_token(db, raw_token)
    except (ApiError, ValueError):
        _masked_not_found()
    subject_facts = _load_subject_facts(db, subject=resolved.subject)
    if subject_facts is None:
        _masked_not_found()
    media, highlight_id = subject_facts
    if _media_has_teardown_intent(db, media.media_id) or not _is_media_ready(media):
        _masked_not_found()
    if not _projection_shape_supported(db, media=media, highlight_id=highlight_id):
        _masked_not_found()
    revision_bytes = _source_revision_bytes(db, media=media)
    return _Projection(
        grant_id=resolved.grant_id,
        subject=resolved.subject,
        media=media,
        handle_context=PublicHandleContext(
            grant_id=resolved.grant_id,
            parent_media_id=media.media_id,
            source_revision_bytes=revision_bytes,
        ),
        highlight=_project_highlight(
            db,
            subject=resolved.subject,
            media=media,
            grant_id=resolved.grant_id,
            revision_bytes=revision_bytes,
        ),
    )


def _load_subject_facts(
    db: Session,
    *,
    subject: ResourceRef,
) -> tuple[_MediaFacts, UUID | None] | None:
    if subject.scheme == "media":
        media_id = subject.id
        highlight_id = None
    elif subject.scheme == "highlight":
        media_id = db.execute(
            text("SELECT anchor_media_id FROM highlights WHERE id = :highlight_id"),
            {"highlight_id": subject.id},
        ).scalar()
        if not isinstance(media_id, UUID):
            return None
        highlight_id = subject.id
    else:
        return None
    locked_media_id = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR SHARE"),
        {"media_id": media_id},
    ).scalar()
    if locked_media_id is None:
        return None
    row = (
        db.execute(
            text(
                """
                SELECT m.id, m.kind, m.title, m.processing_status,
                       mts.transcript_state, mts.transcript_coverage,
                       mts.last_request_reason AS transcript_last_request_reason,
                       source_attempt.id AS source_attempt_id,
                       source_attempt.attempt_no AS source_attempt_no,
                       source_attempt.source_type,
                       CASE
                         WHEN m.kind = 'podcast_episode'
                         THEN pe.duration_seconds * 1000
                         ELSE (
                           SELECT max(f.t_end_ms)
                           FROM fragments f
                           WHERE f.media_id = m.id
                         )
                       END AS duration_ms,
                       m.page_count
                FROM media m
                LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
                LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN LATERAL (
                    SELECT msa.id, msa.attempt_no, msa.source_type
                    FROM media_source_attempts msa
                    WHERE msa.media_id = m.id
                      AND msa.status = 'succeeded'
                    ORDER BY msa.attempt_no DESC, msa.id DESC
                    LIMIT 1
                ) source_attempt ON TRUE
                WHERE m.id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return (
        _MediaFacts(
            media_id=UUID(str(row["id"])),
            kind=str(row["kind"]),
            title=str(row["title"]),
            processing_status=str(row["processing_status"]),
            transcript_state=(
                str(row["transcript_state"]) if row["transcript_state"] is not None else None
            ),
            transcript_coverage=(
                str(row["transcript_coverage"]) if row["transcript_coverage"] is not None else None
            ),
            transcript_last_request_reason=(
                str(row["transcript_last_request_reason"])
                if row["transcript_last_request_reason"] is not None
                else None
            ),
            source_attempt_id=(
                UUID(str(row["source_attempt_id"]))
                if row["source_attempt_id"] is not None
                else None
            ),
            source_attempt_no=(
                int(row["source_attempt_no"]) if row["source_attempt_no"] is not None else None
            ),
            source_type=str(row["source_type"]) if row["source_type"] is not None else None,
            duration_ms=int(row["duration_ms"]) if row["duration_ms"] is not None else None,
            page_count=int(row["page_count"]) if row["page_count"] is not None else None,
        ),
        highlight_id,
    )


def _is_media_ready(media: _MediaFacts) -> bool:
    try:
        return is_text_document_ready(
            media.kind,
            media.processing_status,
            media.transcript_state,
            media.transcript_coverage,
        )
    except ValueError:
        return False


def _projection_shape_supported(
    db: Session,
    *,
    media: _MediaFacts,
    highlight_id: UUID | None,
) -> bool:
    if not _bootstrap_shape_supported(db, media=media):
        return False
    if media.source_attempt_id is None or media.source_attempt_no is None or not media.source_type:
        return False
    if media.kind == "podcast_episode" and media.transcript_last_request_reason != "rss_feed":
        return False
    if media.kind == "video" and (
        media.source_type not in {"youtube_video", "video_transcript"}
        or current_public_source_url(db, media_id=media.media_id) is None
    ):
        return False
    if media.kind in {"web_article", "video", "podcast_episode"}:
        rows = db.execute(
            text(
                """
                SELECT idx, html_sanitized, canonical_text,
                       t_start_ms, t_end_ms, speaker_label
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY idx ASC
                """
            ),
            {"media_id": media.media_id},
        ).all()
        if not rows:
            return False
        try:
            for row in rows:
                ordinal = int(row[0])
                canonical_text = str(row[2])
                if media.kind == "web_article":
                    PublicArticleFragmentOut(
                        ordinal=ordinal,
                        html_sanitized=sanitize_public_article_html(str(row[1])),
                        canonical_text=canonical_text,
                    )
                    continue
                start_raw, end_raw = row[3], row[4]
                if (start_raw is None) != (end_raw is None):
                    return False
                PublicTranscriptSegmentOut(
                    ordinal=ordinal,
                    canonical_text=canonical_text,
                    time_range=_time_range_presence(start_raw, end_raw),
                    speaker=presence_from_nullable(str(row[5]) if row[5] is not None else None),
                )
        except (TypeError, ValueError, ValidationError):
            return False
    elif media.kind == "epub":
        if _load_epub_source_owner(db, media_id=media.media_id) is None:
            return False
        sections = list_epub_section_sources(
            db,
            media_id=media.media_id,
            after_ordinal=None,
            limit=2**31 - 1,
        )
        if not sections:
            return False
        if any(
            len(section.html_sanitized.encode("utf-8")) > _MAX_EPUB_FIELD_BYTES
            or len(section.canonical_text.encode("utf-8")) > _MAX_EPUB_FIELD_BYTES
            for section in sections
        ):
            return False
        assets = list_public_epub_asset_sources(db, media_id=media.media_id)
        if any(asset.size_bytes > _MAX_EPUB_ASSET_BYTES for asset in assets):
            return False
        asset_keys = {asset.asset_key for asset in assets}
        try:
            for section in sections:
                PublicNavigationItemOut(
                    ordinal=section.ordinal,
                    label=section.label,
                    depth=section.depth,
                    section_handle=_PLACEHOLDER_SECTION_HANDLE,
                )
            for asset in assets:
                if (
                    not asset.asset_key
                    or not asset.storage_path
                    or asset.content_type not in _PUBLIC_ASSET_CONTENT_TYPES
                    or asset.size_bytes < 0
                    or asset.size_bytes > _MAX_EPUB_ASSET_BYTES
                ):
                    return False
            if any(
                _serialized_envelope_size(
                    PublicSectionOut(
                        ordinal=section.ordinal,
                        section_handle=_PLACEHOLDER_SECTION_HANDLE,
                        html_sanitized=sanitize_public_epub_html(
                            section.html_sanitized,
                            asset_handle_for_key=lambda key: (
                                _PLACEHOLDER_ASSET_HANDLE if key in asset_keys else None
                            ),
                        ),
                        canonical_text=section.canonical_text,
                    )
                )
                > _MAX_PAGE_BYTES
                for section in sections
            ):
                return False
        except (TypeError, ValueError, ValidationError):
            return False
    elif media.kind == "pdf":
        source = get_media_file_source(db, media_id=media.media_id)
        if (
            source is None
            or source.content_type != _PDF_CONTENT_TYPE
            or source.size_bytes < 1
            or source.size_bytes > _MAX_SAFE_UINT
        ):
            return False
    else:
        return False
    if highlight_id is not None:
        return _highlight_shape_supported(
            db,
            media=media,
            highlight_id=highlight_id,
        )
    return True


def _bootstrap_shape_supported(db: Session, *, media: _MediaFacts) -> bool:
    if media.kind not in {
        "web_article",
        "epub",
        "pdf",
        "video",
        "podcast_episode",
    }:
        return False
    bylines = _load_bylines_if_supported(db, media_id=media.media_id)
    if bylines is None:
        return False
    try:
        media_kind = _public_media_kind(media.kind)
        PublicMediaOut(
            title=media.title,
            media_kind=media_kind,
            source_url=presence_from_nullable(
                current_public_source_url(db, media_id=media.media_id)
            ),
            bylines=bylines,
        )
        if media.kind == "web_article":
            PublicArticleReaderOut()
        elif media.kind == "epub":
            PublicEpubReaderOut()
        elif media.kind == "pdf":
            source = _validated_public_pdf_source(
                db,
                media_id=media.media_id,
                storage_client=get_storage_client(),
            )
            if source is None:
                return False
            PublicPdfReaderOut(
                byte_length=source.size_bytes,
                filename=_pdf_filename(media.title),
            )
        elif media.kind in {"video", "podcast_episode"}:
            PublicTranscriptReaderOut(
                source_kind="Video" if media.kind == "video" else "PodcastEpisode",
                duration_ms=presence_from_nullable(media.duration_ms),
            )
        else:
            return False
    except (TypeError, ValueError, ValidationError):
        return False
    return True


def _validated_public_pdf_source(
    db: Session,
    *,
    media_id: UUID,
    storage_client: StorageClientBase,
) -> MediaFileSource | None:
    """Bind public PDF metadata to an object that exists with the exact stored shape."""
    source = get_media_file_source(db, media_id=media_id)
    if (
        source is None
        or source.content_type != _PDF_CONTENT_TYPE
        or source.size_bytes < 1
        or source.size_bytes > _MAX_SAFE_UINT
    ):
        return None
    try:
        metadata = storage_client.head_object(source.storage_path)
    except StorageError:
        return None
    if (
        metadata is None
        or metadata.content_type != source.content_type
        or metadata.size_bytes != source.size_bytes
    ):
        return None
    return source


def _highlight_shape_supported(
    db: Session,
    *,
    media: _MediaFacts,
    highlight_id: UUID,
) -> bool:
    target = locator_resolver.resolve_highlight_reader_target(
        db,
        highlight_id=highlight_id,
    )
    metadata = (
        db.execute(
            text(
                """
                SELECT exact, color
                FROM highlights
                WHERE id = :highlight_id
                  AND anchor_media_id = :media_id
                """
            ),
            {"highlight_id": highlight_id, "media_id": media.media_id},
        )
        .mappings()
        .first()
    )
    if target is None or metadata is None:
        return False
    try:
        if isinstance(target, WebTextOffsetsTargetOut):
            ordinal = db.execute(
                text(
                    """
                    SELECT idx FROM fragments
                    WHERE id = :fragment_id AND media_id = :media_id
                    """
                ),
                {"fragment_id": target.fragment_id, "media_id": media.media_id},
            ).scalar()
            if ordinal is None:
                return False
            anchor = PublicArticleTextAnchorOut(
                fragment_ordinal=int(ordinal),
                start_offset=target.start_offset,
                end_offset=target.end_offset,
            )
        elif isinstance(target, EpubTextOffsetsTargetOut):
            section_ordinal = db.execute(
                text(
                    """
                    SELECT ordinal FROM epub_nav_locations
                    WHERE media_id = :media_id AND location_id = :section_id
                    """
                ),
                {"media_id": media.media_id, "section_id": target.section_id},
            ).scalar()
            if section_ordinal is None:
                return False
            anchor = PublicEpubTextAnchorOut(
                section_handle=_PLACEHOLDER_SECTION_HANDLE,
                start_offset=target.start_offset,
                end_offset=target.end_offset,
            )
        elif isinstance(target, TranscriptTextOffsetsTargetOut):
            ordinal = db.execute(
                text(
                    """
                    SELECT idx FROM fragments
                    WHERE id = :fragment_id AND media_id = :media_id
                    """
                ),
                {"fragment_id": target.fragment_id, "media_id": media.media_id},
            ).scalar()
            if ordinal is None:
                return False
            anchor = PublicTranscriptTextAnchorOut(
                segment_ordinal=int(ordinal),
                start_offset=target.start_offset,
                end_offset=target.end_offset,
                time_range=target.time_range.model_dump(mode="python"),
            )
        elif isinstance(target, PdfPageGeometryTargetOut):
            anchor = PublicPdfGeometryAnchorOut(
                page_number=target.page_number,
                quads=[quad.model_dump(mode="python") for quad in target.quads],
            )
        else:
            return False
        exact = str(metadata["exact"])
        PublicHighlightOut(
            quote=presence_from_nullable(exact if exact else None),
            color=str(metadata["color"]).capitalize(),
            anchor=anchor,
        )
    except (TypeError, ValueError, ValidationError):
        return False
    return True


def _project_highlight(
    db: Session,
    *,
    subject: ResourceRef,
    media: _MediaFacts,
    grant_id: UUID,
    revision_bytes: bytes,
) -> PublicHighlightOut | None:
    if subject.scheme != "highlight":
        return None
    target = locator_resolver.resolve_highlight_reader_target(
        db,
        highlight_id=subject.id,
    )
    metadata = (
        db.execute(
            text(
                """
                SELECT exact, color
                FROM highlights
                WHERE id = :highlight_id
                  AND anchor_media_id = :media_id
                """
            ),
            {"highlight_id": subject.id, "media_id": media.media_id},
        )
        .mappings()
        .first()
    )
    if target is None or metadata is None:
        _masked_not_found()
    handle_context = PublicHandleContext(
        grant_id=grant_id,
        parent_media_id=media.media_id,
        source_revision_bytes=revision_bytes,
    )
    try:
        if isinstance(target, WebTextOffsetsTargetOut):
            ordinal = db.execute(
                text(
                    """
                    SELECT idx FROM fragments
                    WHERE id = :fragment_id AND media_id = :media_id
                    """
                ),
                {"fragment_id": target.fragment_id, "media_id": media.media_id},
            ).scalar()
            if ordinal is None:
                _masked_not_found()
            anchor = PublicArticleTextAnchorOut(
                fragment_ordinal=int(ordinal),
                start_offset=target.start_offset,
                end_offset=target.end_offset,
            )
        elif isinstance(target, EpubTextOffsetsTargetOut):
            section_ordinal = db.execute(
                text(
                    """
                    SELECT ordinal
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = :section_id
                    """
                ),
                {"media_id": media.media_id, "section_id": target.section_id},
            ).scalar()
            if section_ordinal is None:
                _masked_not_found()
            anchor = PublicEpubTextAnchorOut(
                section_handle=seal_public_handle(
                    "section",
                    ordinal=int(section_ordinal),
                    context=handle_context,
                ),
                start_offset=target.start_offset,
                end_offset=target.end_offset,
            )
        elif isinstance(target, TranscriptTextOffsetsTargetOut):
            ordinal = db.execute(
                text(
                    """
                    SELECT idx FROM fragments
                    WHERE id = :fragment_id AND media_id = :media_id
                    """
                ),
                {"fragment_id": target.fragment_id, "media_id": media.media_id},
            ).scalar()
            if ordinal is None:
                _masked_not_found()
            anchor = PublicTranscriptTextAnchorOut(
                segment_ordinal=int(ordinal),
                start_offset=target.start_offset,
                end_offset=target.end_offset,
                time_range=target.time_range.model_dump(mode="python"),
            )
        elif isinstance(target, PdfPageGeometryTargetOut):
            anchor = PublicPdfGeometryAnchorOut(
                page_number=target.page_number,
                quads=[quad.model_dump(mode="python") for quad in target.quads],
            )
        else:
            _masked_not_found()
        exact = str(metadata["exact"])
        return PublicHighlightOut(
            quote=presence_from_nullable(exact if exact else None),
            color=str(metadata["color"]).capitalize(),
            anchor=anchor,
        )
    except (TypeError, ValueError, ValidationError):
        _masked_not_found()


def _source_revision_bytes(db: Session, *, media: _MediaFacts) -> bytes:
    digest = hashlib.sha256()
    _digest_part(digest, media.kind.encode("utf-8"))
    _digest_part(
        digest,
        (media.transcript_last_request_reason or "").encode("utf-8"),
    )
    for value in (
        str(media.source_attempt_id or ""),
        str(media.source_attempt_no or ""),
        media.source_type or "",
    ):
        _digest_part(digest, value.encode("utf-8"))
    if media.kind == "pdf":
        source = get_media_file_source(db, media_id=media.media_id)
        if source is None:
            _masked_not_found()
        for value in (source.storage_path, source.content_type, str(source.size_bytes)):
            _digest_part(digest, value.encode("utf-8"))
        return digest.digest()

    if media.kind == "epub":
        owner = _load_epub_source_owner(db, media_id=media.media_id)
        if owner is None:
            _masked_not_found()
        _digest_part(digest, b"source-owner")
        for value in (
            str(owner.attempt_id),
            str(owner.attempt_no),
            owner.source_type,
        ):
            _digest_part(digest, value.encode("utf-8"))
        sections = list_epub_section_sources(
            db,
            media_id=media.media_id,
            after_ordinal=None,
            limit=2**31 - 1,
        )
        _digest_part(digest, b"sections")
        _digest_part(digest, str(len(sections)).encode("ascii"))
        for section in sections:
            for value in (
                str(section.ordinal),
                section.label,
                str(section.depth),
                section.html_sanitized,
                section.canonical_text,
            ):
                _digest_part(digest, value.encode("utf-8"))
        assets = list_public_epub_asset_sources(db, media_id=media.media_id)
        _digest_part(digest, b"assets")
        _digest_part(digest, str(len(assets)).encode("ascii"))
        for source in assets:
            for value in (
                str(source.ordinal),
                source.asset_key,
                source.storage_path,
                source.content_type,
                str(source.size_bytes),
            ):
                _digest_part(digest, value.encode("utf-8"))
        return digest.digest()

    rows = db.execute(
        text(
            """
            SELECT idx, html_sanitized, canonical_text,
                   t_start_ms, t_end_ms, speaker_label
            FROM fragments
            WHERE media_id = :media_id
            ORDER BY idx ASC
            """
        ),
        {"media_id": media.media_id},
    ).all()
    for row in rows:
        for value in row:
            _digest_part(digest, str(value if value is not None else "").encode("utf-8"))
    return digest.digest()


def _load_epub_source_owner(
    db: Session,
    *,
    media_id: UUID,
) -> _EpubSourceOwner | None:
    row = (
        db.execute(
            text(
                """
                SELECT id, attempt_no, source_type
                FROM media_source_attempts
                WHERE media_id = :media_id
                  AND status = 'succeeded'
                  AND source_type IN (
                    'remote_epub_url',
                    'uploaded_epub_file',
                    'browser_epub_capture'
                  )
                ORDER BY attempt_no DESC, id DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return _EpubSourceOwner(
        attempt_id=UUID(str(row["id"])),
        attempt_no=int(row["attempt_no"]),
        source_type=str(row["source_type"]),
    )


def _digest_part(digest, value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _serialized_envelope_size(model: BaseModel) -> int:
    """Return compact UTF-8 bytes emitted for one public success envelope."""
    payload = {"data": model.model_dump(mode="json")}
    return len(
        json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def _load_bylines(db: Session, *, media_id: UUID) -> list[str]:
    bylines = _load_bylines_if_supported(db, media_id=media_id)
    if bylines is None:
        _masked_not_found()
    return bylines


def _load_bylines_if_supported(
    db: Session,
    *,
    media_id: UUID,
) -> list[str] | None:
    rows = db.execute(
        text(
            """
            WITH current_source AS (
                SELECT source_type
                FROM media_source_attempts
                WHERE media_id = :media_id
                  AND status = 'succeeded'
                ORDER BY attempt_no DESC, id DESC
                LIMIT 1
            )
            SELECT cc.credited_name
            FROM contributor_credits cc
            CROSS JOIN current_source source
            WHERE cc.media_id = :media_id
              AND cc.role = 'author'
              AND (
                (source.source_type = 'generic_web_url'
                 AND cc.source = 'web_article_byline')
                OR (source.source_type = 'browser_article_capture'
                    AND cc.source = 'web_article_capture')
                OR (source.source_type IN ('x_author_thread', 'x_post')
                    AND cc.source IN (
                      'x_api_author_thread',
                      'x_api_post',
                      'x_api_quoted_post'
                    ))
                OR (source.source_type IN ('youtube_video', 'video_transcript')
                    AND cc.source = 'youtube_metadata')
                OR (source.source_type IN (
                      'remote_pdf_url',
                      'uploaded_pdf_file',
                      'browser_pdf_capture'
                    ) AND cc.source = 'pdf_metadata')
                OR (source.source_type IN (
                      'remote_epub_url',
                      'uploaded_epub_file',
                      'browser_epub_capture'
                    ) AND cc.source = 'epub_opf')
                OR (source.source_type = 'podcast_episode_transcript'
                    AND cc.source = 'rss')
              )
            ORDER BY cc.ordinal ASC
            LIMIT 33
            """
        ),
        {"media_id": media_id},
    ).scalars()
    bylines = [str(value).strip() for value in rows if str(value).strip()]
    if len(bylines) > 32 or any(len(value) > 512 for value in bylines):
        return None
    return bylines


def _public_media_kind(kind: str):
    mapping = {
        "web_article": "Article",
        "epub": "Epub",
        "pdf": "Pdf",
        "video": "Video",
        "podcast_episode": "PodcastEpisode",
    }
    try:
        return mapping[kind]
    except KeyError:
        _masked_not_found()


def _public_reader(media: _MediaFacts, *, db: Session):
    if media.kind == "web_article":
        return PublicArticleReaderOut()
    if media.kind == "epub":
        return PublicEpubReaderOut()
    if media.kind == "pdf":
        source = get_media_file_source(db, media_id=media.media_id)
        if source is None:
            _masked_not_found()
        return PublicPdfReaderOut(
            byte_length=source.size_bytes,
            filename=_pdf_filename(media.title),
        )
    if media.kind in {"video", "podcast_episode"}:
        return PublicTranscriptReaderOut(
            source_kind="Video" if media.kind == "video" else "PodcastEpisode",
            duration_ms=presence_from_nullable(media.duration_ms),
        )
    _masked_not_found()


def _parse_limit(raw_limit: str | None) -> int:
    if raw_limit is None:
        return _DEFAULT_LIMIT
    if not re.fullmatch(r"[1-9][0-9]*", raw_limit):
        raise PublicRequestValidation("limit must be an integer from 1 to 100")
    limit = int(raw_limit)
    if limit > _MAX_LIMIT:
        raise PublicRequestValidation("limit must be an integer from 1 to 100")
    return limit


def _parse_cursor(raw_cursor: str | None, *, projection: _Projection) -> int:
    if raw_cursor is None:
        return -1
    ordinal = unseal_public_handle(
        "page-cursor",
        raw_cursor,
        context=projection.handle_context,
    )
    if ordinal is None:
        _masked_not_found()
    return ordinal


def _page_info(last_ordinal: int | None, projection: _Projection) -> PublicPageInfo:
    return PublicPageInfo(
        next_cursor=presence_from_nullable(
            seal_public_handle(
                "page-cursor",
                ordinal=last_ordinal,
                context=projection.handle_context,
            )
            if last_ordinal is not None
            else None
        )
    )


def _time_range_presence(start_raw, end_raw):
    if start_raw is None or end_raw is None:
        return absent()
    return presence_from_nullable(PublicTimeRangeOut(start_ms=int(start_raw), end_ms=int(end_raw)))


def _media_has_teardown_intent(db: Session, media_id: UUID) -> bool:
    return (
        db.execute(
            text("SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).first()
        is not None
    )


def _pdf_filename(title: str) -> str:
    normalized = unicodedata.normalize("NFC", title)
    cleaned = "".join(
        " " if unicodedata.category(char).startswith("C") or char in {"/", "\\", '"'} else char
        for char in normalized
    )
    cleaned = " ".join(cleaned.split()).strip(" .")
    if not cleaned:
        cleaned = "document"
    if not cleaned.lower().endswith(".pdf"):
        cleaned += ".pdf"
    return cleaned[:255].rstrip(" .") or "document.pdf"


def _verified_stream(chunks: Iterator[bytes], *, expected_length: int) -> Iterator[bytes]:
    seen = 0
    for chunk in chunks:
        seen += len(chunk)
        if seen > expected_length:
            raise StorageError("Stored object is larger than persisted metadata")
        yield chunk
    if seen != expected_length:
        raise StorageError("Stored object integrity mismatch")


def _parse_page_query(query_items: list[tuple[str, str]]) -> tuple[str | None, str | None]:
    values: dict[str, str] = {}
    for key, value in query_items:
        if key not in {"cursor", "limit"} or key in values:
            raise PublicRequestValidation("Invalid pagination query")
        values[key] = value
    return values.get("cursor"), values.get("limit")


def _require_no_query(query_items: list[tuple[str, str]] | None) -> None:
    if query_items:
        raise PublicRequestValidation("This endpoint does not accept query parameters")


def _masked_not_found() -> NoReturn:
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable")
