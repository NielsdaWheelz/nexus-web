"""Sealed outward handles for activity exclusions and devices.

A handle is ``<prefix>.<id>.<tag>`` in canonical base64url, the tag an HMAC
under a per-kind key derived from ``STREAM_TOKEN_SIGNING_KEY``. A device handle
is the tag alone: a one-way pseudonym, so no raw device id leaves the server.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import NamedTuple
from uuid import UUID

from nexus.config import get_settings
from nexus.errors import InvalidRequestError


class HandleKind(NamedTuple):
    prefix: str
    label: str
    domain: bytes


EXCLUSION = HandleKind("nce1", "activity exclusion", b"consumption-activity-exclusion\0v1")
DEVICE = HandleKind("ncd1", "device", b"consumption-device\0v1")


def seal(kind: HandleKind, value: UUID) -> str:
    return f"{kind.prefix}.{_encode(value.bytes)}.{_encode(_tag(kind, value.bytes))}"


def unseal(kind: HandleKind, raw: str) -> UUID:
    """The sealed identity; 400 for a foreign prefix, a forgery or non-canonical base64url."""
    try:
        prefix, encoded_id, encoded_tag = raw.split(".")
        value = UUID(bytes=_decode(encoded_id))
        if prefix != kind.prefix or not hmac.compare_digest(
            _decode(encoded_tag), _tag(kind, value.bytes)
        ):
            raise ValueError("not a handle of this kind")
    except ValueError as exc:
        raise InvalidRequestError(message=f"Invalid {kind.label} handle") from exc
    return value


def seal_device(device_id: str) -> str:
    return f"{DEVICE.prefix}.{_encode(_tag(DEVICE, device_id.encode()))}"


def _tag(kind: HandleKind, payload: bytes) -> bytes:
    root = base64.b64decode(get_settings().effective_stream_token_signing_key, validate=True)
    key = hmac.new(root, b"nexus-handle-key\0" + kind.domain, hashlib.sha256).digest()
    return hmac.new(key, b"nexus-handle\0" + kind.domain + payload, hashlib.sha256).digest()[:16]


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if len(decoded) != 16 or _encode(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded
