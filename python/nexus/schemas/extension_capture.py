"""Browser capture wire models: the capture request, an upload session's origin,
the article packet an article capture uploads, and the extension session.

The packet is the one object an article capture uploads; its identity is the
sha256 of the exact uploaded bytes, and ``decode_article_packet`` is the one
decoder every reader of those bytes (confirmation, the article adapter) shares.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)
from pydantic_core import PydanticCustomError

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.url_normalize import validate_requested_url
from nexus.services.web_article_structure import WEB_ARTICLE_HTML_MAX_BYTES

ARTICLE_PACKET_MAX_BYTES = 4 * 1024 * 1024
ARTICLE_SOURCE_HTML_MAX_BYTES = 64 * 1024


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _requested_url(value: str) -> str:
    try:
        validate_requested_url(value)
    except InvalidRequestError as exc:
        raise ValueError(exc.message) from exc
    return value


def _utf8_at_most(limit: int):
    def check(value: str) -> str:
        if len(value.encode()) > limit:
            raise PydanticCustomError(
                "capture_too_large", "utf-8 length exceeds {limit}", {"limit": limit}
            )
        return value

    return check


def _distinct(values: list[UUID]) -> list[UUID]:
    if len(set(values)) != len(values):
        raise ValueError("library_ids must be distinct")
    return values


RequestedUrl = Annotated[str, StringConstraints(max_length=2048), AfterValidator(_requested_url)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class LocalFile(_Strict):
    kind: Literal["LocalFile"] = "LocalFile"


class BrowserCapture(_Strict):
    kind: Literal["BrowserCapture"] = "BrowserCapture"
    source_url: RequestedUrl
    sha256: Sha256Hex


class CreateCaptureRequest(_Strict):
    """``id`` is the extension's session id, minted once per draft and resent on retry."""

    id: UUID
    kind: Literal["web_article", "pdf", "epub"]
    source_url: RequestedUrl
    filename: str = Field(min_length=1, max_length=255)
    content_type: Literal["application/pdf", "application/epub+zip", "application/json"]
    size_bytes: int = Field(gt=0)
    sha256: Sha256Hex
    library_ids: Annotated[list[UUID], AfterValidator(_distinct)] = Field(default_factory=list)


class ArticlePacket(_Strict):
    """The uploaded article object, in exactly this key order; no extras."""

    url: RequestedUrl
    base_url: RequestedUrl
    title: str = Field(max_length=1024)
    content_html: Annotated[str, AfterValidator(_utf8_at_most(WEB_ARTICLE_HTML_MAX_BYTES))]
    source_html: Annotated[str, AfterValidator(_utf8_at_most(ARTICLE_SOURCE_HTML_MAX_BYTES))]
    byline: Annotated[str, StringConstraints(max_length=1024)] | None
    excerpt: Annotated[str, StringConstraints(max_length=4000)] | None
    site_name: Annotated[str, StringConstraints(max_length=1024)] | None
    published_time: Annotated[str, StringConstraints(max_length=128)] | None


def decode_article_packet(raw: bytes) -> ArticlePacket:
    """A part over its bound is ``E_CAPTURE_TOO_LARGE``; any other mismatch is
    ``E_INVALID_FILE_TYPE``."""
    if len(raw) > ARTICLE_PACKET_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet exceeds its size limit."
        )
    try:
        return ArticlePacket.model_validate_json(raw)
    except ValidationError as exc:
        if any(error["type"] == "capture_too_large" for error in exc.errors()):
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet part is too large."
            ) from exc
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Not a valid article packet."
        ) from exc


class CaptureLimits(_Strict):
    """The byte limits the extension checks before it sends anything."""

    max_pdf_bytes: int
    max_epub_bytes: int
    max_article_packet_bytes: int


class ExtensionSessionOut(_Strict):
    user_id: UUID
    email: str | None
    display_name: str | None
    limits: CaptureLimits


class ExtensionTokenOut(_Strict):
    id: UUID
    token: str
    created_at: datetime
