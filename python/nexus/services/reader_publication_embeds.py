"""Current card capabilities for only a selected unit's authored occurrences."""

import hashlib
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    ReaderContentTooLargeError,
)
from nexus.schemas.media import DocumentEmbedOut
from nexus.schemas.reader_publication import (
    ReaderPublicationEmbedsPage,
    ReaderPublicationEmbedsRequest,
    ReaderPublicationUnitBody,
)
from nexus.services.document_embeds import project_document_embed_source
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.storage.client import get_storage_client
from nexus.storage.read import read_object_checked


def _read_unit(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    unit_key: str,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationUnitBody:
    """Read one immutable unit body inside the request's single read snapshot.

    The caller keeps reading current capability state through this session, so
    the snapshot must outlive the object read. The storage client's own connect
    and read timeouts bound that read.
    """
    member = get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key=unit_key,
        role="unit",
    )
    if member.size_bytes > limits.unit_bytes:
        # A re-qualified profile can lower ``unit_bytes`` below a unit already
        # published under the previous one, so this is retained content the
        # current profile cannot serve, not a producer invariant break.
        raise ReaderContentTooLargeError(
            "Reader unit exceeds qualified capacity",
            limit="unit_bytes",
            limit_value=limits.unit_bytes,
            measured=member.size_bytes,
        )
    body = read_object_checked(
        get_storage_client(), member.storage_path, expected_size=member.size_bytes
    )
    if hashlib.sha256(body).hexdigest() != member.sha256:
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Reader unit integrity mismatch")
    unit = ReaderPublicationUnitBody.model_validate_json(body)
    del body
    return unit


def get_reader_publication_embed(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    unit_key: str,
    embed_id: UUID,
    limits: ReaderPublicationLimits,
) -> DocumentEmbedOut:
    unit = _read_unit(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        unit_key=unit_key,
        limits=limits,
    )
    source = next((source for source in unit.document_embeds if source.id == embed_id), None)
    if source is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader embed not found")
    return project_document_embed_source(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        fragment_id=UUID(unit.fragment_id),
        source=source,
    )


def list_reader_publication_embeds(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationEmbedsRequest,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationEmbedsPage:
    unit = _read_unit(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        unit_key=request.unit_key,
        limits=limits,
    )
    if request.after_ordinal is not None and not any(
        item.ordinal == request.after_ordinal for item in unit.document_embeds
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unknown unit embed continuation")
    items = []
    for source in unit.document_embeds:
        if request.after_ordinal is not None and source.ordinal <= request.after_ordinal:
            continue
        projected = project_document_embed_source(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            fragment_id=UUID(unit.fragment_id),
            source=source,
        )
        candidate = ReaderPublicationEmbedsPage(
            items=(*items, projected), next_ordinal=source.ordinal
        )
        page_bytes = len(candidate.model_dump_json().encode("utf-8")) + len(b'{"data":}')
        if page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader embed exceeds qualified capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderPublicationEmbedsPage(items=tuple(items), next_ordinal=items[-1].ordinal)
        items.append(projected)
    return ReaderPublicationEmbedsPage(items=tuple(items), next_ordinal=None)
