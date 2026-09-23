"""Browser-capture wire models: the capture intent, the upload session's input
origin, the article packet an article capture uploads, and the extension
session identity.

The packet is the one immutable object a browser article capture uploads; its
identity is the sha256 of the exact uploaded bytes and ``decode_article_packet``
is the one decoder every reader of those bytes (confirmation, the article
adapter, conversion) shares.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
)
from pydantic_core import PydanticCustomError

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import Presence
from nexus.services.sealed_handles import UserHandle
from nexus.services.url_normalize import validate_requested_url
from nexus.services.web_article_structure import WEB_ARTICLE_HTML_MAX_BYTES

ARTICLE_PACKET_MAX_BYTES = 4 * 1024 * 1024
ARTICLE_SOURCE_HTML_MAX_BYTES = 64 * 1024
_TOO_LARGE = "capture_too_large"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _requested_url(value: str) -> str:
    try:
        validate_requested_url(value)
    except InvalidRequestError as exc:
        raise ValueError(exc.message) from exc
    return value


def _bounded_utf8(max_bytes: int):
    def check(value: str) -> str:
        if len(value.encode("utf-8")) > max_bytes:
            raise PydanticCustomError(
                _TOO_LARGE, "utf-8 length exceeds {max_bytes} bytes", {"max_bytes": max_bytes}
            )
        return value

    return check


def _distinct(values: list) -> list:
    if len(set(values)) != len(values):
        raise ValueError("library_ids must be distinct")
    return values


RequestedUrl = Annotated[str, StringConstraints(max_length=2048), AfterValidator(_requested_url)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
CaptureKind = Literal["web_article", "pdf", "epub"]
CaptureContentType = Literal["application/pdf", "application/epub+zip", "application/json"]


class LocalFile(_Strict):
    kind: Literal["LocalFile"] = "LocalFile"


class BrowserCapture(_Strict):
    kind: Literal["BrowserCapture"] = "BrowserCapture"
    source_url: RequestedUrl
    sha256: Sha256Hex


InputOrigin = Annotated[LocalFile | BrowserCapture, Field(discriminator="kind")]
InputOriginKind = Literal["LocalFile", "BrowserCapture"]
INPUT_ORIGIN_ADAPTER: TypeAdapter[LocalFile | BrowserCapture] = TypeAdapter(InputOrigin)


class BrowserCaptureIntent(_Strict):
    kind: CaptureKind
    source_url: RequestedUrl
    filename: str = Field(min_length=1, max_length=255)
    content_type: CaptureContentType
    size_bytes: int = Field(gt=0)
    sha256: Sha256Hex
    library_ids: Annotated[list[UUID], AfterValidator(_distinct)] = Field(default_factory=list)


class ArticlePacket(_Strict):
    """The uploaded article object, in exactly this key order; no extras."""

    url: RequestedUrl
    base_url: RequestedUrl
    title: str = Field(max_length=1024)
    content_html: Annotated[str, AfterValidator(_bounded_utf8(WEB_ARTICLE_HTML_MAX_BYTES))]
    source_html: Annotated[str, AfterValidator(_bounded_utf8(ARTICLE_SOURCE_HTML_MAX_BYTES))]
    byline: Presence[Annotated[str, StringConstraints(max_length=1024)]]
    excerpt: Presence[Annotated[str, StringConstraints(max_length=4000)]]
    site_name: Presence[Annotated[str, StringConstraints(max_length=1024)]]
    published_time: Presence[Annotated[str, StringConstraints(max_length=128)]]


def decode_article_packet(raw: bytes) -> ArticlePacket:
    """Strictly decode packet bytes: a part over its bound is ``E_CAPTURE_TOO_LARGE``,
    anything else that is not the exact object is ``E_INVALID_FILE_TYPE``."""
    if len(raw) > ARTICLE_PACKET_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet exceeds the packet-size limit."
        )
    try:
        return ArticlePacket.model_validate_json(raw)
    except ValidationError as exc:
        if any(error["type"] == _TOO_LARGE for error in exc.errors()):
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet part exceeds its size limit."
            ) from exc
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source is not a valid article packet."
        ) from exc


class CaptureLimits(_Strict):
    """The byte limits the extension checks at save; the article part bounds are
    its own constants (extraction precedes login) and are not repeated here."""

    max_pdf_bytes: int
    max_epub_bytes: int
    max_article_packet_bytes: int


class ExtensionSessionOut(_Strict):
    user_handle: UserHandle
    email: Presence[str]
    display_name: Presence[str]
    limits: CaptureLimits
