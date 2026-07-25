"""Sealed outward handles for exact Consumption completion Undo."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
from uuid import UUID

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.consumption_activity import CompletionHandle, DeviceHandle

_PREFIX = "ncc1"
_DOMAIN = b"consumption-completion\0v1"
_DEVICE_PREFIX = "ncd1"
_DEVICE_DOMAIN = b"consumption-device\0v1"
_TAG_BYTES = 16


class InvalidCompletionHandle(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid completion handle")


class InvalidDeviceHandle(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid device handle")


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode_b64url(value: str, *, expected_bytes: int | None) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("invalid base64url")
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if (expected_bytes is not None and len(decoded) != expected_bytes) or _b64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def _key(domain: bytes) -> bytes:
    try:
        root = base64.b64decode(get_settings().effective_stream_token_signing_key, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY is not strict base64") from exc
    if len(root) < 32:
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY must decode to at least 32 bytes")
    return hmac.new(root, b"nexus-handle-key\0" + domain, hashlib.sha256).digest()


def _tag(completion_id: UUID) -> bytes:
    return hmac.new(
        _key(_DOMAIN), b"nexus-handle\0" + _DOMAIN + completion_id.bytes, hashlib.sha256
    ).digest()[:_TAG_BYTES]


def seal_completion(completion_id: UUID) -> CompletionHandle:
    return CompletionHandle(
        f"{_PREFIX}.{_b64url(completion_id.bytes)}.{_b64url(_tag(completion_id))}"
    )


def unseal_completion(raw: str) -> UUID:
    try:
        prefix, encoded_id, encoded_tag = raw.split(".")
        if prefix != _PREFIX:
            raise ValueError("wrong prefix")
        completion_id = UUID(bytes=_decode_b64url(encoded_id, expected_bytes=16))
        provided_tag = _decode_b64url(encoded_tag, expected_bytes=_TAG_BYTES)
    except (ValueError, AttributeError) as exc:
        raise InvalidCompletionHandle() from exc
    if not hmac.compare_digest(provided_tag, _tag(completion_id)):
        raise InvalidCompletionHandle()
    return completion_id


def parse_device_handle(raw: str) -> DeviceHandle:
    try:
        return DeviceHandle._validate(raw)
    except ValueError as exc:
        raise InvalidDeviceHandle() from exc


def seal_device(device_id: str) -> DeviceHandle:
    raw = device_id.encode("utf-8")
    if not 1 <= len(raw) <= 200:
        raise ValueError("device id must be 1..200 UTF-8 bytes")
    tag = hmac.new(
        _key(_DEVICE_DOMAIN), b"nexus-handle\0" + _DEVICE_DOMAIN + raw, hashlib.sha256
    ).digest()[:_TAG_BYTES]
    return DeviceHandle(f"{_DEVICE_PREFIX}.{_b64url(tag)}")
