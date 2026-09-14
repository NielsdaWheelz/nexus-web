"""Sole owner of reader-visible document publication and generation fencing."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Literal, cast
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    Media,
    MediaFile,
    ProcessingStatus,
    ReaderPublication,
    ReaderPublicationAnchor,
    ReaderPublicationApparatusEdge,
    ReaderPublicationApparatusItem,
    ReaderPublicationArtifact,
    ReaderPublicationSearchMap,
    ReaderPublicationSearchSource,
    ReaderPublicationTarget,
    ReaderPublicationUnit,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.media import DocumentEmbedSource, MediaNavigationOut, ReaderNavigationFragmentOut
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client

if TYPE_CHECKING:
    from nexus.services.reader_publication_artifacts import (
        PreparedReaderPublication,
        PreparedReaderPublicationTitle,
    )

ReaderDocumentKind = Literal["pdf", "epub", "web_article"]
_ELIGIBLE_KINDS = frozenset({"pdf", "epub", "web_article"})
_MISSING_OBJECT_CODE = "E_STORAGE_MISSING"


@dataclass(frozen=True)
class ReaderPublicationObjectReference:
    role: Literal["source", "epub_asset"]
    storage_path: str
    content_type: str
    size_bytes: int
    sha256: str | None = None
    asset_key: str | None = None
    package_href: str | None = None


@dataclass(frozen=True)
class ReaderPublicationSourceFile:
    """One immutable object that becomes the reader-visible source file pointer.

    ``source_sha256`` is the verified digest of that exact object; the pointer and
    its digest move together so a reader never sees a file whose recorded digest
    belongs to a superseded object.
    """

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
    document_embeds: tuple[DocumentEmbedSource, ...]


@dataclass(frozen=True)
class ReaderPublicationEpubNavigation:
    location_id: str
    ordinal: int
    label: str
    fragment_idx: int
    href_path: str | None
    href_fragment: str | None
    start_offset: int
    end_offset: int


@dataclass(frozen=True)
class ReaderPublicationEpubTocNode:
    node_id: str
    nav_type: str
    parent_node_id: str | None
    label: str
    href: str | None
    fragment_idx: int | None
    depth: int
    order_key: str


@dataclass(frozen=True)
class ReaderPublicationEpubSection:
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
    fragments: tuple[ReaderPublicationFragment, ...]
    epub_toc: tuple[ReaderPublicationEpubTocNode, ...]
    epub_sections: tuple[ReaderPublicationEpubSection, ...]
    epub_navigation: tuple[ReaderPublicationEpubNavigation, ...]
    object_references: tuple[ReaderPublicationObjectReference, ...]
    web_navigation: MediaNavigationOut | None
    pdf_plain_text: str | None
    pdf_page_spans: tuple[tuple[int, int, int], ...]
    pdf_page_heights: tuple[tuple[int, float | None], ...]


@dataclass(frozen=True)
class CapturedReaderPublication[T]:
    generation: int
    projection: ReaderPublicationProjection
    value: T


class ReaderPublicationBusy(ApiError):
    """The selected canonical state changed during capture or preparation."""

    def __init__(self) -> None:
        super().__init__(
            ApiErrorCode.E_READER_PUBLICATION_BUSY,
            "Reader publication is changing; retry the request.",
        )


class ReaderPublicationObjectReader:
    """Read only the immutable object references captured in one projection."""

    def __init__(
        self,
        storage_client: StorageClientBase,
        references: tuple[ReaderPublicationObjectReference, ...],
    ) -> None:
        self._storage_client = storage_client
        self._references = {reference.storage_path: reference for reference in references}

    def stream(self, reference: ReaderPublicationObjectReference) -> Iterator[bytes]:
        captured = self._references.get(reference.storage_path)
        if captured != reference:
            raise ValueError("object reference is not part of this Reader publication capture")
        return self._storage_client.stream_object(reference.storage_path)


def read_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """Read current generation inside the caller's transaction."""
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == media_id)
    )
    if generation is None:
        return None
    return _positive_generation(generation)


def read_ready_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """Read one eligible, currently readable publication in the caller transaction."""
    generation = db.scalar(
        select(ReaderPublication.generation)
        .join(Media, Media.id == ReaderPublication.media_id)
        .where(
            ReaderPublication.media_id == media_id,
            Media.kind.in_(_ELIGIBLE_KINDS),
            Media.processing_status == ProcessingStatus.ready_for_reading.value,
        )
    )
    if generation is None:
        return None
    return _positive_generation(generation)


def lock_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """Lock/read current generation inside a caller-owned mutation transaction."""
    generation = db.scalar(
        select(ReaderPublication.generation)
        .where(ReaderPublication.media_id == media_id)
        .with_for_update()
    )
    if generation is None:
        return None
    return _positive_generation(generation)


def superseded_reader_source_paths(
    db: Session,
    *,
    media_id: UUID,
    source_file: ReaderPublicationSourceFile | None,
) -> list[str]:
    """Object paths a pending reader-visible source replacement supersedes.

    Read inside the publishing transaction before the pointer is installed. The
    caller deletes the named objects only after that transaction commits, so a
    rolled-back publication never loses the object its pointer still names.
    """
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is None or str(current) == source_file.storage_path:
        return []
    retained = db.scalar(
        select(ReaderPublicationArtifact.path)
        .where(ReaderPublicationArtifact.storage_path == str(current))
        .limit(1)
    )
    if retained is not None:
        return []
    return [str(current)]


def unpublished_reader_source_paths(
    db: Session,
    *,
    media_id: UUID,
    source_file: ReaderPublicationSourceFile | None,
) -> list[str]:
    """Prepared source paths left unreferenced when publication is refused.

    A stale source attempt must not move the reader-visible pointer, but its
    immutable object still needs post-transaction cleanup. If the current pointer
    or a retained generation names that exact path, the object is published and
    must survive.
    """
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is not None and str(current) == source_file.storage_path:
        return []
    retained = db.scalar(
        select(ReaderPublicationArtifact.path)
        .where(ReaderPublicationArtifact.storage_path == source_file.storage_path)
        .limit(1)
    )
    if retained is not None:
        return []
    return [source_file.storage_path]


def replace_reader_publication[T](
    db: Session,
    *,
    media_id: UUID,
    expected_kind: ReaderDocumentKind,
    replace_projection: Callable[[Media], T],
    prepared: PreparedReaderPublication | PreparedReaderPublicationTitle,
    source_file: ReaderPublicationSourceFile | None = None,
) -> T:
    """Atomically replace a document projection and advance its generation once.

    Object writes belong to the immutable preparation phase and must have completed
    before entry, so ``prepared`` is required: a generation can only be published
    together with the members and expected-generation fence it was prepared under.
    The memberless generation-1 row belongs to ``ensure_reader_publication``.
    The callback performs database-only canonical projection writes.
    ``source_file`` is the reader-visible file pointer this publication installs;
    this owner writes it under the publication lock so no replaced pointer can
    commit without its generation bump. Omit it when the publication does not
    replace the source object. The caller owns commit so this composes with
    source-attempt fencing.
    """
    if expected_kind not in _ELIGIBLE_KINDS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Reader publication requires PDF, EPUB, or web article media.",
        )
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Reader publication kind does not match its media.",
        )
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    current_generation = publication.generation if publication is not None else None
    if prepared.media_id != media_id or prepared.descriptor.kind != expected_kind:
        raise ValueError("Prepared reader publication has a different identity")
    if prepared.expected_generation != current_generation:
        raise ReaderPublicationBusy()
    if prepared.descriptor.reader_generation != (current_generation or 0) + 1:
        raise ValueError("Prepared reader publication has a different successor generation")
    if source_file is not None:
        _install_reader_source_file(db, media_id=media_id, source_file=source_file)
    result = replace_projection(media)
    db.flush()
    from nexus.services.reader_publication_artifacts import (
        PreparedReaderPublicationTitle,
        install_prepared_reader_publication,
        install_prepared_reader_title,
    )

    if media.title != prepared.descriptor.title:
        # justify-defect: canonical projection and immutable descriptor were
        # prepared from the same accepted source/title command.
        raise AssertionError("Published media title disagrees with its prepared descriptor")
    if isinstance(prepared, PreparedReaderPublicationTitle):
        install_prepared_reader_title(db, prepared)
    else:
        install_prepared_reader_publication(db, prepared)
    if publication is None:
        db.add(
            ReaderPublication(
                id=new_uuid7(),
                media_id=media_id,
                generation=1,
            )
        )
    else:
        publication.generation = _positive_generation(publication.generation) + 1
        publication.changed_at = db.scalar(text("SELECT now()"))
        if publication.changed_at is None:
            # justify-defect: `SELECT now()` inside an open transaction always returns
            # this transaction's timestamp, so an absent value is a broken database.
            raise AssertionError("PostgreSQL did not supply publication changed_at")
    db.flush()
    return result


def _install_reader_source_file(
    db: Session,
    *,
    media_id: UUID,
    source_file: ReaderPublicationSourceFile,
) -> None:
    """Write the reader-visible source pointer under the held publication lock."""
    media_file = db.get(MediaFile, media_id)
    if media_file is None:
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=source_file.storage_path,
                content_type=source_file.content_type,
                size_bytes=source_file.size_bytes,
                source_sha256=source_file.source_sha256,
            )
        )
        return
    media_file.storage_path = source_file.storage_path
    media_file.content_type = source_file.content_type
    media_file.size_bytes = source_file.size_bytes
    media_file.source_sha256 = source_file.source_sha256


def replace_reader_document_title(
    db: Session, *, media: Media, title: str, prepared: PreparedReaderPublicationTitle | None
) -> bool:
    """Publish a new reader-visible title for one already published document.

    The title is part of the captured package projection, so replacing it on a
    published document is a publication that must bump the generation. The media
    row is locked before the publication row — the owner's lock order — so a
    concurrent first publication cannot appear between the check and the
    replacement. A title identical to the one already published is not a
    replacement: it would retain a second generation holding another copy of the
    document's whole text for no reader-visible change, so this owner refuses it
    here rather than leaving each caller to compare.

    Returns whether this owner published the title. ``False`` means the media is
    not a published reader document, or its published title is already exactly
    this title; either way the caller keeps its own (then redundant) title write.
    """
    kind = str(media.kind)
    if kind not in _ELIGIBLE_KINDS:
        return False
    locked = db.scalar(select(Media).where(Media.id == media.id).with_for_update())
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if read_publication_generation(db, media_id=locked.id) is None:
        return False
    if locked.title == title:
        return False
    if prepared is None:
        raise ValueError("Published reader title requires a prepared descriptor")

    def replace_projection(published: Media) -> None:
        published.title = title

    replace_reader_publication(
        db,
        media_id=locked.id,
        expected_kind=cast(ReaderDocumentKind, kind),
        replace_projection=replace_projection,
        prepared=prepared,
    )
    return True


def ensure_reader_publication(db: Session, *, media_id: UUID) -> bool:
    """Publish one eligible ready document's current projection at generation 1.

    The release preflight uses this to give every already-ready document the
    publication row its offline package needs. It is idempotent: an existing row is
    left exactly as it is, because its generation already fences what it published.
    Media that is missing, ineligible, or not ready for reading is left unpublished.
    Returns whether this call created the row.
    """
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
    if media is None:
        return False
    if str(media.kind) not in _ELIGIBLE_KINDS:
        return False
    if media.processing_status != ProcessingStatus.ready_for_reading:
        return False
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        return False
    db.add(
        ReaderPublication(
            id=new_uuid7(),
            media_id=media_id,
            generation=1,
        )
    )
    db.flush()
    return True


def delete_reader_publication(db: Session, *, media_id: UUID) -> None:
    """Explicitly remove the publication row before its owning Media row."""
    for model in (
        ReaderPublicationSearchMap,
        ReaderPublicationSearchSource,
        ReaderPublicationApparatusEdge,
        ReaderPublicationApparatusItem,
        ReaderPublicationAnchor,
        ReaderPublicationTarget,
        ReaderPublicationUnit,
        ReaderPublicationArtifact,
    ):
        db.execute(delete(model).where(model.media_id == media_id))
    db.flush()
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        db.delete(publication)
        db.flush()


def install_current_reader_publication(db: Session, *, prepared: PreparedReaderPublication) -> bool:
    """Backfill one already published generation; never advance or replace it."""
    from nexus.services.reader_publication_artifacts import install_prepared_reader_publication

    generation = prepared.descriptor.reader_generation
    if prepared.expected_generation != generation:
        raise ValueError("Current-generation preparation requires its exact published generation")
    media = db.scalar(select(Media).where(Media.id == prepared.media_id).with_for_update())
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    publication = db.scalar(
        select(ReaderPublication)
        .where(ReaderPublication.media_id == prepared.media_id)
        .with_for_update()
    )
    if publication is None or publication.generation != generation:
        raise ReaderPublicationBusy()
    if media.kind != prepared.descriptor.kind or media.title != prepared.descriptor.title:
        raise AssertionError("Current publication facts changed without advancing its generation")
    existing = db.get(ReaderPublicationArtifact, (prepared.media_id, generation, "descriptor.json"))
    if existing is not None:
        descriptor_member = next(
            member for member in prepared.members if member.role == "descriptor"
        )
        if existing.sha256 != descriptor_member.ref.sha256:
            raise ReaderPublicationBusy()
        return False
    install_prepared_reader_publication(db, prepared)
    return True


def capture_current[T](
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    assemble: Callable[[ReaderPublicationProjection, ReaderPublicationObjectReader], T],
    storage_client: StorageClientBase | None = None,
) -> CapturedReaderPublication[T]:
    """Capture one coherent projection, restarting once when its seqlock changes."""
    objects = storage_client or get_storage_client()
    for attempt in range(2):
        projection = _read_projection(session_factory, media_id=media_id)
        object_reader = ReaderPublicationObjectReader(objects, projection.object_references)
        value: T | None = None
        assembly_error: StorageError | None = None
        try:
            value = assemble(projection, object_reader)
        except StorageError as exc:
            if exc.code != _MISSING_OBJECT_CODE:
                # Transient object-store failure: the member read that owns the
                # object already retried it, so this capture does not re-run an
                # assembly that writes objects of its own.
                raise
            # A missing object is a captured-projection fact, classified below
            # against the generation this capture read.
            assembly_error = exc

        exists, generation = _read_current_identity(session_factory, media_id=media_id)
        if not exists or generation is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if generation != projection.generation:
            if attempt == 0:
                continue
            raise ReaderPublicationBusy()
        if assembly_error is not None:
            # justify-defect: this capture read the object keys of a generation that
            # never changed, and a published generation only ever names objects that
            # already exist, so the object store lost a live reader-visible object.
            raise AssertionError(
                "Reader publication references a missing object at its unchanged generation"
            ) from assembly_error
        return CapturedReaderPublication(
            generation=projection.generation,
            projection=projection,
            value=cast(T, value),
        )
    # justify-defect: the bounded loop returns, restarts once, or raises on its second
    # pass, so reaching this statement means the capture rules changed shape.
    raise AssertionError("bounded Reader publication capture exhausted without an outcome")


def _read_projection(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
) -> ReaderPublicationProjection:
    db = session_factory()
    try:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        row = (
            db.execute(
                text(
                    """
                SELECT rp.generation, rp.changed_at, m.kind, m.title,
                       m.page_count, m.processing_status
                FROM reader_publications rp
                JOIN media m ON m.id = rp.media_id
                WHERE rp.media_id = :media_id
                """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if str(row["kind"]) not in _ELIGIBLE_KINDS:
            # justify-defect: only this owner creates publication rows and it admits
            # PDF, EPUB, and web articles only, so a row on another kind is corruption.
            raise AssertionError("Reader publication points at ineligible media")
        if str(row["processing_status"]) != "ready_for_reading":
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

        from nexus.services.document_embeds import capture_document_embed_sources

        embed_sources = capture_document_embed_sources(db, media_id=media_id)
        fragments = tuple(
            ReaderPublicationFragment(
                fragment_id=fragment.id,
                idx=int(fragment.idx),
                canonical_text=str(fragment.canonical_text),
                html_sanitized=str(fragment.html_sanitized),
                document_embeds=embed_sources.get(fragment.id, ()),
            )
            for fragment in db.execute(
                text(
                    """
                    SELECT id, idx, canonical_text, html_sanitized
                    FROM fragments
                    WHERE media_id = :media_id
                    ORDER BY idx
                    """
                ),
                {"media_id": media_id},
            )
        )
        navigation = tuple(
            ReaderPublicationEpubNavigation(
                location_id=str(nav.location_id),
                ordinal=int(nav.ordinal),
                label=str(nav.label),
                fragment_idx=int(nav.fragment_idx),
                href_path=str(nav.href_path) if nav.href_path is not None else None,
                href_fragment=(str(nav.href_fragment) if nav.href_fragment is not None else None),
                start_offset=int(nav.start_offset),
                end_offset=int(nav.end_offset),
            )
            for nav in db.execute(
                text(
                    """
                    SELECT location_id, ordinal, label, fragment_idx, href_path,
                           href_fragment, start_offset, end_offset
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                    ORDER BY ordinal
                    """
                ),
                {"media_id": media_id},
            )
        )
        toc = tuple(
            ReaderPublicationEpubTocNode(
                node_id=str(node.node_id),
                nav_type=str(node.nav_type),
                parent_node_id=(
                    str(node.parent_node_id) if node.parent_node_id is not None else None
                ),
                label=str(node.label),
                href=str(node.href) if node.href is not None else None,
                fragment_idx=int(node.fragment_idx) if node.fragment_idx is not None else None,
                depth=int(node.depth),
                order_key=str(node.order_key),
            )
            for node in db.execute(
                text(
                    """
                    SELECT node_id, nav_type, parent_node_id, label, href,
                           fragment_idx, depth, order_key
                    FROM epub_toc_nodes
                    WHERE media_id = :media_id
                    ORDER BY order_key, node_id
                    """
                ),
                {"media_id": media_id},
            )
        )
        sections = tuple(
            ReaderPublicationEpubSection(
                fragment_idx=int(section.fragment_idx),
                package_href=str(section.package_href),
                manifest_item_id=str(section.manifest_item_id),
                spine_itemref_id=(
                    str(section.spine_itemref_id) if section.spine_itemref_id is not None else None
                ),
                media_type=str(section.media_type),
                linear=bool(section.linear),
                reading_order=int(section.reading_order),
            )
            for section in db.execute(
                text(
                    """
                    SELECT f.idx AS fragment_idx, efs.package_href,
                           efs.manifest_item_id, efs.spine_itemref_id,
                           efs.media_type, efs.linear, efs.reading_order
                    FROM epub_fragment_sources efs
                    JOIN fragments f ON f.id = efs.fragment_id
                    WHERE efs.media_id = :media_id
                    ORDER BY efs.reading_order, f.idx
                    """
                ),
                {"media_id": media_id},
            )
        )
        object_rows = db.execute(
            text(
                """
                SELECT 'source' AS role, storage_path, content_type, size_bytes, source_sha256 AS sha256,
                       NULL::text AS asset_key, NULL::text AS package_href
                FROM media_file
                WHERE media_id = :media_id
                UNION ALL
                SELECT 'epub_asset' AS role, storage_path, content_type, size_bytes, NULL::text AS sha256,
                       asset_key, package_href
                FROM epub_resources
                WHERE media_id = :media_id
                ORDER BY role, storage_path
                """
            ),
            {"media_id": media_id},
        )
        references = tuple(
            ReaderPublicationObjectReference(
                role=item.role,
                storage_path=str(item.storage_path),
                content_type=str(item.content_type),
                size_bytes=int(item.size_bytes),
                sha256=str(item.sha256) if item.sha256 is not None else None,
                asset_key=str(item.asset_key) if item.asset_key is not None else None,
                package_href=str(item.package_href) if item.package_href is not None else None,
            )
            for item in object_rows
        )
        web_navigation = None
        if row["kind"] == "web_article":
            from nexus.services.reader_navigation import load_web_navigation_projection

            web_navigation = load_web_navigation_projection(
                db,
                media_id=media_id,
                fragments=[
                    ReaderNavigationFragmentOut(
                        fragment_id=fragment.fragment_id,
                        fragment_idx=fragment.idx,
                        char_count=len(fragment.canonical_text),
                    )
                    for fragment in fragments
                ],
            )
        pdf_plain_text = None
        pdf_page_spans: tuple[tuple[int, int, int], ...] = ()
        pdf_page_heights: tuple[tuple[int, float | None], ...] = ()
        if row["kind"] == "pdf":
            pdf_plain_text = db.scalar(select(Media.plain_text).where(Media.id == media_id)) or ""
            pdf_pages = db.execute(
                text(
                    "SELECT page_number, start_offset, end_offset, page_height FROM pdf_page_text_spans "
                    "WHERE media_id = :media_id ORDER BY page_number"
                ),
                {"media_id": media_id},
            ).all()
            pdf_page_spans = tuple(
                (int(item.page_number), int(item.start_offset), int(item.end_offset))
                for item in pdf_pages
            )
            pdf_page_heights = tuple(
                (int(item.page_number), item.page_height) for item in pdf_pages
            )
        projection = ReaderPublicationProjection(
            media_id=media_id,
            generation=_positive_generation(row["generation"]),
            changed_at=row["changed_at"],
            kind=row["kind"],
            title=str(row["title"]),
            page_count=int(row["page_count"]) if row["page_count"] is not None else None,
            fragments=fragments,
            epub_toc=toc,
            epub_sections=sections,
            epub_navigation=navigation,
            object_references=references,
            web_navigation=web_navigation,
            pdf_plain_text=pdf_plain_text,
            pdf_page_spans=pdf_page_spans,
            pdf_page_heights=pdf_page_heights,
        )
        db.commit()
        return projection
    finally:
        db.close()


def _read_current_identity(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
) -> tuple[bool, int | None]:
    with session_factory() as db:
        row = db.execute(
            text(
                """
                SELECT rp.generation
                FROM media m
                LEFT JOIN reader_publications rp ON rp.media_id = m.id
                WHERE m.id = :media_id
                """
            ),
            {"media_id": media_id},
        ).one_or_none()
        if row is None:
            return False, None
        if row.generation is None:
            return True, None
        return True, _positive_generation(row.generation)


def _positive_generation(value: object) -> int:
    generation = int(value)  # type: ignore[arg-type]
    if generation < 1:
        # justify-defect: this owner writes generation 1 on the first publication and
        # only ever increments it, so a non-positive stored value is corruption.
        raise AssertionError("Reader publication generation must be positive")
    return generation
