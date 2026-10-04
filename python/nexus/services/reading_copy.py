"""One offline reading copy: the hosted reader's own payloads and objects, zipped.

``reader.json`` holds ``media``, ``navigation``, ``fragments`` (web article) or
``epubFragments`` (epub), each serialized exactly as its hosted route serializes
it, so the Android shelf parses them with the hosted reader's parsers. The zip
also carries ``document.pdf`` (pdf) or ``assets/{asset_key}`` (epub). The only
change to hosted html: web article images become text placeholders (offline
web articles are text-only).
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
from nexus.services import epub_read, reader_navigation, reader_publication
from nexus.services import media as media_service
from nexus.services.image_placeholder import replace_image_with_placeholder
from nexus.storage.client import StorageError, get_storage_client


def build_reading_copy(db: Session, *, viewer_id: UUID, media_id: UUID, path: Path) -> int:
    """Write ``viewer_id``'s copy of ``media_id`` to ``path``; return its generation.

    Every read happens in the caller's repeatable-read snapshot, so the payloads
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
    kind = str(row.kind)
    reader: dict[str, object] = {
        "media": {"id": str(media_id), "title": str(row.title), "kind": kind},
        "navigation": None,
        "fragments": None,
        "epubFragments": None,
    }
    objects: list[tuple[str, str]] = []
    if kind == "pdf":
        source = db.scalar(
            text("SELECT storage_path FROM media_file WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        objects.append(("document.pdf", str(source)))
    else:
        navigation = reader_navigation.get_media_navigation_for_viewer(db, viewer_id, media_id)
        reader["navigation"] = navigation.model_dump(mode="json", by_alias=True)
        if kind == "web_article":
            reader["fragments"] = [
                {
                    **fragment.model_dump(mode="json", by_alias=True),
                    "html_sanitized": _without_images(fragment.html_sanitized),
                }
                for fragment in media_service.list_fragments_for_viewer(db, viewer_id, media_id)
            ]
        else:
            reader["epubFragments"] = [
                epub_read.get_epub_fragment_for_viewer(
                    db, viewer_id, media_id, fragment.fragment_id
                ).model_dump(mode="json", by_alias=True)
                for fragment in navigation.fragments
            ]
            objects.extend(
                (f"assets/{asset.asset_key}", str(asset.storage_path))
                for asset in db.execute(
                    text(
                        "SELECT asset_key, storage_path FROM epub_resources"
                        " WHERE media_id = :media_id"
                    ),
                    {"media_id": media_id},
                )
            )
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
