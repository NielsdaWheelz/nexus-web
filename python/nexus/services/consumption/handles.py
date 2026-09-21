"""Sealed outward handles: completion facts, activity exclusions, devices."""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import NamedTuple
from uuid import UUID

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_TAG_BYTES = 16


class HandleKind(NamedTuple):
    prefix: str
    label: str
    domain: bytes


COMPLETION = HandleKind("ncc1", "completion", b"consumption-completion\0v1")
EXCLUSION = HandleKind("nce1", "activity exclusion", b"consumption-activity-exclusion\0v1")
DEVICE = HandleKind("ncd1", "device", b"consumption-device\0v1")


class InvalidHandle(InvalidRequestError):
    def __init__(self, kind: HandleKind) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, f"Invalid {kind.label} handle")


def seal(kind: HandleKind, value: UUID) -> str:
    """The canonical ``<prefix>.<id>.<tag>`` handle for one identity."""
    return f"{kind.prefix}.{_b64url(value.bytes)}.{_b64url(_tag(kind, value.bytes))}"


def unseal(kind: HandleKind, raw: str) -> UUID:
    """Recover the identity, rejecting a foreign prefix, a forgery, or padding."""
    try:
        prefix, encoded_id, encoded_tag = raw.split(".")
        if prefix != kind.prefix:
            raise ValueError("wrong prefix")
        value = UUID(bytes=_decode_b64url(encoded_id, 16))
        provided = _decode_b64url(encoded_tag, _TAG_BYTES)
    except ValueError as exc:
        raise InvalidHandle(kind) from exc
    if not hmac.compare_digest(provided, _tag(kind, value.bytes)):
        raise InvalidHandle(kind)
    return value


def seal_device(device_id: str) -> str:
    """A one-way pseudonym: the tag alone, so no device id leaves the server."""
    raw = device_id.encode("utf-8")
    if not 1 <= len(raw) <= 200:
        raise ValueError("device id must be 1..200 UTF-8 bytes")
    return f"{DEVICE.prefix}.{_b64url(_tag(DEVICE, raw))}"


def _tag(kind: HandleKind, payload: bytes) -> bytes:
    root = base64.b64decode(get_settings().effective_stream_token_signing_key, validate=True)
    if len(root) < 32:
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY must decode to at least 32 bytes")
    key = hmac.new(root, b"nexus-handle-key\0" + kind.domain, hashlib.sha256).digest()
    digest = hmac.new(key, b"nexus-handle\0" + kind.domain + payload, hashlib.sha256).digest()
    return digest[:_TAG_BYTES]


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode_b64url(value: str, expected_bytes: int) -> bytes:
    """Decode then re-encode: the round trip is what makes the grammar single-valued."""
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if len(decoded) != expected_bytes or _b64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded
