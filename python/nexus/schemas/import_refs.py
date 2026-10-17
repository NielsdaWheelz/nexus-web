"""Import refs: `upload:<session id>` or `media:<media id>`, canonical lowercase uuid text."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError

ImportRef = str
"""The wire identity of one import (admission receipts, Imports rows); the server writes it."""


@dataclass(frozen=True, slots=True)
class UploadImportRef:
    """An import named by its upload session, published or not."""

    session_id: UUID


@dataclass(frozen=True, slots=True)
class MediaImportRef:
    """An import named by its media; no session of the viewer published it."""

    media_id: UUID


type ParsedImportRef = UploadImportRef | MediaImportRef


def parse_import_ref(raw: str) -> ParsedImportRef:
    """Untrusted ingress; anything but the two canonical forms is a 400."""
    scheme, _, raw_id = raw.partition(":")
    try:
        row_id = UUID(raw_id)
    except ValueError:
        row_id = None
    if row_id is not None and str(row_id) == raw_id:
        if scheme == "upload":
            return UploadImportRef(session_id=row_id)
        if scheme == "media":
            return MediaImportRef(media_id=row_id)
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid import ref")


def format_import_ref(ref: ParsedImportRef) -> ImportRef:
    match ref:
        case UploadImportRef(session_id=session_id):
            return f"upload:{session_id}"
        case MediaImportRef(media_id=media_id):
            return f"media:{media_id}"
