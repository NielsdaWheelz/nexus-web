"""Reader-visible document publication and generation fencing."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer, sessionmaker

from nexus.db.models import Media, MediaFile, ProcessingStatus, ReaderPublication
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.media import MediaNavigationOut
from nexus.schemas.presence import Presence, absent, present
from nexus.storage.client import StorageClient, StorageError, get_storage_client

ReaderDocumentKind = Literal["pdf", "epub", "web_article"]
_ELIGIBLE_KINDS = frozenset({"pdf", "epub", "web_article"})
_MISSING_OBJECT_CODE = "E_STORAGE_MISSING"


@dataclass(frozen=True)
class ReaderPublicationObjectReference:
    role: Literal["source", "epub_asset"]
    storage_path: str
    content_type: str
    size_bytes: int
    asset_key: str | None = None
    package_href: str | None = None


@dataclass(frozen=True)
class ReaderPublicationSourceFile:
    storage_path: str
    content_type: str
    size_bytes: int
    source_sha256: str


@dataclass(frozen=True)
class ReaderPublicationFragment:
    fragment_id: UUID
    idx: int
    canonical_text: str
    html_sanitized: str
    word_count: int
    created_at: datetime


@dataclass(frozen=True)
class ReaderPublicationEpubFragmentSource:
    fragment_idx: int
    package_href: str
    manifest_item_id: str
    spine_itemref_id: str | None
    media_type: str
    linear: bool
    reading_order: int


@dataclass(frozen=True)
class ReaderPublicationProjection:
    media_id: UUID
    generation: int
    changed_at: datetime
    kind: ReaderDocumentKind
    title: str
    page_count: int | None
    plain_text: str | None
    navigation: Presence[MediaNavigationOut]
    fragments: tuple[ReaderPublicationFragment, ...]
    epub_fragment_sources: tuple[ReaderPublicationEpubFragmentSource, ...]
    object_references: tuple[ReaderPublicationObjectReference, ...]


@dataclass(frozen=True)
class CapturedReaderPublication[T]:
    generation: int
    projection: ReaderPublicationProjection
    value: T


class ReaderPublicationObjectReader:
    def __init__(self, storage_client: StorageClient) -> None:
        self._storage_client = storage_client

    def stream(self, reference: ReaderPublicationObjectReference) -> Iterator[bytes]:
        return self._storage_client.stream_object(reference.storage_path)


def read_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == media_id)
    )
    return None if generation is None else int(generation)


def read_ready_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """The generation of one eligible, currently readable publication."""
    generation = db.scalar(
        text(
            "SELECT rp.generation FROM reader_publications rp JOIN media m ON m.id = rp.media_id"
            " WHERE rp.media_id = :media_id AND m.kind = ANY(:kinds)"
            " AND m.processing_status = 'ready_for_reading'"
        ),
        {"media_id": media_id, "kinds": list(_ELIGIBLE_KINDS)},
    )
    return None if generation is None else int(generation)


def lock_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """Lock the publication row so a republication cannot interleave."""
    generation = db.scalar(
        select(ReaderPublication.generation)
        .where(ReaderPublication.media_id == media_id)
        .with_for_update()
    )
    return None if generation is None else int(generation)


def superseded_reader_source_paths(
    db: Session, *, media_id: UUID, source_file: ReaderPublicationSourceFile | None
) -> list[str]:
    """Objects a pending source replacement supersedes; delete them only after commit."""
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is None or str(current) == source_file.storage_path:
        return []
    return [str(current)]


def unpublished_reader_source_paths(
    db: Session, *, media_id: UUID, source_file: ReaderPublicationSourceFile | None
) -> list[str]:
    """Prepared source objects left unreferenced because the publication was refused."""
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is not None and str(current) == source_file.storage_path:
        return []
    return [source_file.storage_path]


def replace_reader_publication[T](
    db: Session,
    *,
    media_id: UUID,
    expected_kind: ReaderDocumentKind,
    replace_projection: Callable[[Media], T],
    source_file: ReaderPublicationSourceFile | None = None,
) -> T:
    """Lock media, then the publication row, then install the source pointer and bump."""
    if expected_kind not in _ELIGIBLE_KINDS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Reader publication requires PDF, EPUB, or web article media.",
        )
    media = db.scalar(
        select(Media).options(defer(Media.plain_text)).where(Media.id == media_id).with_for_update()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Reader publication kind does not match its media."
        )
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if source_file is not None:
        media_file = db.get(MediaFile, media_id)
        if media_file is None:
            media_file = MediaFile(media_id=media_id)
            db.add(media_file)
        media_file.storage_path = source_file.storage_path
        media_file.content_type = source_file.content_type
        media_file.size_bytes = source_file.size_bytes
        media_file.source_sha256 = source_file.source_sha256
    result = replace_projection(media)
    db.flush()
    if publication is None:
        db.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=1))
    else:
        publication.generation = int(publication.generation) + 1
        publication.changed_at = db.scalar(text("SELECT now()"))
    db.flush()
    return result


def replace_reader_document_title(db: Session, *, media: Media, title: str) -> bool:
    """Publish a new title, bumping the generation; ``False`` if there is no publication."""
    kind = str(media.kind)
    if kind not in _ELIGIBLE_KINDS:
        return False
    locked_id = db.scalar(select(Media.id).where(Media.id == media.id).with_for_update())
    if locked_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if read_publication_generation(db, media_id=locked_id) is None:
        return False

    def replace_projection(published: Media) -> None:
        published.title = title

    replace_reader_publication(
        db,
        media_id=locked_id,
        expected_kind=cast(ReaderDocumentKind, kind),
        replace_projection=replace_projection,
    )
    return True


def ensure_reader_publication(db: Session, *, media_id: UUID) -> bool:
    """Publish one eligible ready document at generation 1; an existing row is left as is."""
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
    if media is None or str(media.kind) not in _ELIGIBLE_KINDS:
        return False
    if media.processing_status != ProcessingStatus.ready_for_reading:
        return False
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        return False
    db.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=1))
    db.flush()
    return True


def delete_reader_publication(db: Session, *, media_id: UUID) -> None:
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        db.delete(publication)
        db.flush()


def capture_current[T](
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    assemble: Callable[[ReaderPublicationProjection, ReaderPublicationObjectReader], T],
    storage_client: StorageClient | None = None,
) -> CapturedReaderPublication[T]:
    """Capture one coherent projection; the seqlock allows exactly one restart."""
    objects = storage_client or get_storage_client()
    for _attempt in range(2):
        projection = _read_projection(session_factory, media_id=media_id)
        try:
            value = assemble(projection, ReaderPublicationObjectReader(objects))
        except StorageError as exc:
            if exc.code != _MISSING_OBJECT_CODE:
                raise
            if _current_generation(session_factory, media_id) == projection.generation:
                raise
            continue
        if _current_generation(session_factory, media_id) == projection.generation:
            return CapturedReaderPublication(projection.generation, projection, value)
    raise ApiError(
        ApiErrorCode.E_READER_PUBLICATION_BUSY,
        "Reader publication is changing; retry the request.",
    )


def _read_projection(
    session_factory: sessionmaker[Session], *, media_id: UUID
) -> ReaderPublicationProjection:
    from nexus.services.reader_navigation import read_media_navigation

    with session_factory() as db:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        row = db.execute(
            text(
                "SELECT rp.generation, rp.changed_at, m.kind, m.title, m.page_count,"
                " m.plain_text, m.processing_status"
                " FROM reader_publications rp JOIN media m ON m.id = rp.media_id"
                " WHERE rp.media_id = :media_id"
            ),
            {"media_id": media_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if str(row.processing_status) != "ready_for_reading":
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
        kind = cast(ReaderDocumentKind, str(row.kind))
        generation = int(row.generation)
        fragments = tuple(
            ReaderPublicationFragment(*fragment)
            for fragment in db.execute(
                text(
                    "SELECT id, idx, canonical_text, html_sanitized, canonical_text_word_count,"
                    " created_at FROM fragments WHERE media_id = :media_id ORDER BY idx"
                ),
                {"media_id": media_id},
            )
        )
        epub_fragment_sources = tuple(
            ReaderPublicationEpubFragmentSource(*source)
            for source in db.execute(
                text(
                    "SELECT f.idx, efs.package_href, efs.manifest_item_id, efs.spine_itemref_id,"
                    " efs.media_type, efs.linear, efs.reading_order"
                    " FROM epub_fragment_sources efs JOIN fragments f ON f.id = efs.fragment_id"
                    " WHERE efs.media_id = :media_id ORDER BY efs.reading_order, f.idx"
                ),
                {"media_id": media_id},
            )
        )
        object_references = tuple(
            ReaderPublicationObjectReference(*reference)
            for reference in db.execute(
                text(
                    "SELECT 'source' AS role, storage_path, content_type, size_bytes,"
                    " NULL::text AS asset_key, NULL::text AS package_href"
                    " FROM media_file WHERE media_id = :media_id"
                    " UNION ALL"
                    " SELECT 'epub_asset', storage_path, content_type, size_bytes,"
                    " asset_key, package_href FROM epub_resources WHERE media_id = :media_id"
                    " ORDER BY role, storage_path"
                ),
                {"media_id": media_id},
            )
        )
        return ReaderPublicationProjection(
            media_id=media_id,
            generation=generation,
            changed_at=row.changed_at,
            kind=kind,
            title=str(row.title),
            page_count=row.page_count,
            plain_text=row.plain_text,
            navigation=present(
                read_media_navigation(db, media_id=media_id, kind=kind, generation=generation)
            )
            if kind in ("epub", "web_article")
            else absent(),
            fragments=fragments,
            epub_fragment_sources=epub_fragment_sources,
            object_references=object_references,
        )


def _current_generation(session_factory: sessionmaker[Session], media_id: UUID) -> int:
    with session_factory() as db:
        generation = db.scalar(
            text(
                "SELECT rp.generation FROM media m"
                " LEFT JOIN reader_publications rp ON rp.media_id = m.id WHERE m.id = :media_id"
            ),
            {"media_id": media_id},
        )
    if generation is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return int(generation)
