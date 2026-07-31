"""Sealed, non-authorizing outward identity for Podcast refresh runs."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
from uuid import UUID

from pydantic_core import core_schema

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_PREFIX = "prr1"
_DOMAIN = b"podcast-refresh-run\0v1"
_TAG_BYTES = 16
_PART_CHARS = 22
_WIRE_RE = re.compile(
    rf"^{_PREFIX}\.[A-Za-z0-9_-]{{{_PART_CHARS}}}\.[A-Za-z0-9_-]{{{_PART_CHARS}}}$"
)


class InvalidPodcastRefreshRunHandle(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid Podcast refresh run handle")


class PodcastRefreshRunHandle(str):
    @classmethod
    def _validate(cls, value: str) -> PodcastRefreshRunHandle:
        _parse_wire(value)
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


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode_b64url(value: str, *, expected_bytes: int) -> bytes:
    try:
        decoded = base64.b64decode(
            value + "=" * (-len(value) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if len(decoded) != expected_bytes or _b64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def _root_key() -> bytes:
    try:
        root = base64.b64decode(
            get_settings().effective_stream_token_signing_key,
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY is not strict base64") from exc
    if len(root) < 32:
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY must decode to at least 32 bytes")
    return root


def _key() -> bytes:
    return hmac.new(_root_key(), b"nexus-handle-key\0" + _DOMAIN, hashlib.sha256).digest()


def _tag(run_id: UUID) -> bytes:
    return hmac.new(
        _key(),
        b"nexus-handle\0" + _DOMAIN + run_id.bytes,
        hashlib.sha256,
    ).digest()[:_TAG_BYTES]


def _parse_wire(raw: str) -> tuple[UUID, bytes]:
    if _WIRE_RE.fullmatch(raw) is None:
        raise ValueError("invalid Podcast refresh run handle grammar")
    prefix, encoded_id, encoded_tag = raw.split(".")
    if prefix != _PREFIX:
        raise ValueError("wrong Podcast refresh run handle prefix")
    return (
        UUID(bytes=_decode_b64url(encoded_id, expected_bytes=16)),
        _decode_b64url(encoded_tag, expected_bytes=_TAG_BYTES),
    )


def seal_podcast_refresh_run(run_id: UUID) -> PodcastRefreshRunHandle:
    return PodcastRefreshRunHandle(f"{_PREFIX}.{_b64url(run_id.bytes)}.{_b64url(_tag(run_id))}")


def unseal_podcast_refresh_run(raw: str) -> UUID:
    try:
        run_id, presented_tag = _parse_wire(raw)
    except (ValueError, AttributeError) as exc:
        raise InvalidPodcastRefreshRunHandle() from exc
    if not hmac.compare_digest(presented_tag, _tag(run_id)):
        raise InvalidPodcastRefreshRunHandle()
    return run_id
