"""One offline reading copy: the reader's document and its objects, zipped.

``reader.json`` is ``{"media": {id, title, kind}, "document": ReaderDocumentOut}``,
the document as ``GET /media/{id}/reader`` builds it, except that a pdf's
``file.url`` names the member ``document.pdf`` and web article images become
text placeholders (offline web articles are text-only). The zip also carries
``document.pdf`` (pdf) or ``assets/{asset_key}`` (epub).
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from uuid import UUID

import lxml.etree as etree
from lxml import html
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.reader_document import ReaderPdfFileOut
from nexus.services import reader_publication
from nexus.services.image_placeholder import replace_image_with_placeholder
from nexus.services.reader_document import build_reader_document
from nexus.storage.client import StorageError, get_storage_client


def build_reading_copy(db: Session, *, viewer_id: UUID, media_id: UUID, path: Path) -> int:
    """Write ``viewer_id``'s copy of ``media_id`` to ``path``; return its generation.

    Every read happens in the caller's repeatable-read snapshot, so the document
    and the generation agree. The snapshot is released before object storage is
    read; an object that vanished meanwhile was superseded by a republication.
    """
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    generation = reader_publication.read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    row = db.execute(
        text("SELECT kind, title FROM media WHERE id = :media_id"), {"media_id": media_id}
    ).one()
    document = build_reader_document(
        db,
        media_id=media_id,
        viewer_id=viewer_id,
        pdf_file=lambda: ReaderPdfFileOut(url="document.pdf", expires_at=None),
    )
    objects: list[tuple[str, str]] = []
    if document.kind == "pdf":
        source = db.scalar(
            text("SELECT storage_path FROM media_file WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        objects.append(("document.pdf", str(source)))
    elif document.kind == "web_article":
        document.units = [
            unit.model_copy(update={"html_sanitized": _without_images(unit.html_sanitized)})
            for unit in document.units
        ]
    else:
        objects.extend(
            (f"assets/{asset.asset_key}", str(asset.storage_path))
            for asset in db.execute(
                text(
                    "SELECT asset_key, storage_path FROM epub_resources WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            )
        )
    reader = {
        "media": {"id": str(media_id), "title": str(row.title), "kind": str(row.kind)},
        "document": document.model_dump(mode="json", by_alias=True),
    }
    db.rollback()

    storage = get_storage_client()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("reader.json", json.dumps(reader, ensure_ascii=False))
        for member, storage_path in objects:
            with archive.open(member, "w") as output:
                try:
                    for chunk in storage.stream_object(storage_path):
                        output.write(chunk)
                except StorageError as exc:
                    if exc.code != "E_STORAGE_MISSING":
                        raise
                    raise ConflictError(
                        ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader content changed"
                    ) from exc
    return generation


def _without_images(raw: str) -> str:
    if "<img" not in raw.lower():
        return raw
    container = html.fragment_fromstring(raw, create_parent=True)
    for image in list(container.iter("img")):
        replace_image_with_placeholder(image)
    return (container.text or "") + "".join(
        etree.tostring(child, encoding="unicode", method="html") for child in container
    )
