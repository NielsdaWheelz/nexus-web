"""Authorized immutable-member lookup; no source assembly or current aliases."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, ReaderPublication, ReaderPublicationArtifact
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.reader_publication import (
    ReaderPublicationMemberRef,
    ReaderPublicationMemberRole,
)


@dataclass(frozen=True)
class ReaderPublicationMemberSource:
    generation: int
    key: str
    storage_path: str
    media_type: str
    size_bytes: int
    sha256: str


def get_reader_publication_member_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int | None,
    key: str,
    role: ReaderPublicationMemberRole,
) -> ReaderPublicationMemberSource:
    """Select exactly one member while authorizing current media visibility."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    select_current = generation is None
    if generation is None:
        generation = db.scalar(
            select(ReaderPublication.generation).where(
                ReaderPublication.media_id == media_id,
            )
        )
        if generation is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Reader publication is not ready")
    elif generation < 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Generation must be positive")
    row = db.scalar(
        select(ReaderPublicationArtifact).where(
            ReaderPublicationArtifact.media_id == media_id,
            ReaderPublicationArtifact.generation == generation,
            ReaderPublicationArtifact.path == key,
            ReaderPublicationArtifact.role == role,
        )
    )
    if row is None:
        if select_current:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Reader publication is not prepared")
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader publication member not found")
    return ReaderPublicationMemberSource(
        generation=row.generation,
        key=row.path,
        storage_path=row.storage_path,
        media_type=row.media_type,
        size_bytes=row.size_bytes,
        sha256=row.sha256,
    )


@dataclass(frozen=True)
class ReaderPublicationPdfSource:
    """Retained PDF geometry identity: page bound plus the document asset member."""

    page_count: int
    document_asset_ref: ReaderPublicationMemberRef

    @property
    def sha256(self) -> str:
        """The published binary's digest; authored geometry is bound to it."""
        return self.document_asset_ref.sha256


def get_reader_publication_pdf_source_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID, generation: int
) -> ReaderPublicationPdfSource:
    """Select retained geometry identity without reading object bytes or current text."""
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    if db.scalar(select(Media.kind).where(Media.id == media_id)) != "pdf":
        raise ApiError(ApiErrorCode.E_INVALID_KIND, "Operation requires PDF media")
    page_count = db.scalar(
        select(ReaderPublicationArtifact.pdf_page_count).where(
            ReaderPublicationArtifact.media_id == media_id,
            ReaderPublicationArtifact.generation == generation,
            ReaderPublicationArtifact.path == "descriptor.json",
        )
    )
    if page_count is None:
        raise AssertionError("Ready PDF descriptor has no verified page count")
    asset = db.execute(
        select(
            ReaderPublicationArtifact.path,
            ReaderPublicationArtifact.size_bytes,
            ReaderPublicationArtifact.sha256,
        ).where(
            ReaderPublicationArtifact.media_id == media_id,
            ReaderPublicationArtifact.generation == generation,
            ReaderPublicationArtifact.role == "asset",
            ReaderPublicationArtifact.media_type == "application/pdf",
        )
    ).one()
    return ReaderPublicationPdfSource(
        page_count=page_count,
        document_asset_ref=ReaderPublicationMemberRef(
            key=asset.path, bytes=asset.size_bytes, sha256=asset.sha256
        ),
    )
