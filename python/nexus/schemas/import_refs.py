"""Import wire identity shared by admission receipts and workspace reads."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter
from pydantic_core import core_schema

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.sealed_handles import UploadSessionHandle

_UPLOAD_REF_PREFIX = "upload:"
_MEDIA_REF_PREFIX = "media:"
_UPLOAD_SESSION_HANDLE = TypeAdapter(UploadSessionHandle)


class InvalidImportRef(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid import ref")


@dataclass(frozen=True, slots=True)
class UploadImportRef:
    """One import whose identity is its upload session, published or not."""

    session_handle: UploadSessionHandle


@dataclass(frozen=True, slots=True)
class MediaImportRef:
    """One import whose identity is its media row; it has no upload session."""

    media_id: UUID


type ParsedImportRef = UploadImportRef | MediaImportRef


def _split_import_ref(raw: str) -> ParsedImportRef:
    if raw.startswith(_UPLOAD_REF_PREFIX):
        return UploadImportRef(
            session_handle=_UPLOAD_SESSION_HANDLE.validate_python(
                raw.removeprefix(_UPLOAD_REF_PREFIX)
            )
        )
    if raw.startswith(_MEDIA_REF_PREFIX):
        raw_id = raw.removeprefix(_MEDIA_REF_PREFIX)
        media_id = UUID(raw_id)
        if str(media_id) != raw_id:
            raise ValueError("media import ref must be canonical lowercase UUID text")
        return MediaImportRef(media_id=media_id)
    raise ValueError("import ref must name an upload session or a media row")


class ImportRef(str):
    """The wire identity of one import: validated text, never unsealed here."""

    @classmethod
    def _validate(cls, value: str) -> ImportRef:
        _split_import_ref(value)
        return cls(value)

    @classmethod
    def __get_pydantic_core_schema__(
        cls,
        _source_type: object,
        _handler: object,
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_after_validator_function(
            cls._validate,
            core_schema.str_schema(),
        )


def parse_import_ref(raw: str) -> ParsedImportRef:
    """Untrusted ingress: narrow one URL-decoded ref into its owning identity."""
    try:
        return _split_import_ref(raw)
    except ValueError as exc:
        raise InvalidImportRef from exc


def format_import_ref(ref: ParsedImportRef) -> ImportRef:
    match ref:
        case UploadImportRef():
            return ImportRef(f"{_UPLOAD_REF_PREFIX}{ref.session_handle}")
        case MediaImportRef():
            return ImportRef(f"{_MEDIA_REF_PREFIX}{ref.media_id}")
