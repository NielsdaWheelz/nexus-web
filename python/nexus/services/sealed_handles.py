"""Browse discovery-target handles and resource-share link tokens.

A discovery target handle (``ndt1.<payload>.<tag>``) seals the canonical payload of one browse
result under an HMAC-SHA256 key derived from ``NEXUS_HANDLE_KEY``, so a client can name it back
but never forge one. A share token (``nxshr1_`` + 32 random bytes) is a bearer credential the
grant row stores as minted.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

from pydantic_core import core_schema

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_DISCOVERY_TARGET_MAX_BYTES = 4_096
_DISCOVERY_TARGET_RE = re.compile(r"^ndt1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$")


class InvalidDiscoveryTargetHandle(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Invalid discovery target")


class DiscoveryTargetHandle(str):
    @classmethod
    def _validate(cls, value: str) -> DiscoveryTargetHandle:
        _parse(value)
        return cls(value)

    @classmethod
    def __get_pydantic_core_schema__(
        cls, _source: object, _handler: object
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_after_validator_function(cls._validate, core_schema.str_schema())


def _b64url(raw: bytes) -> str:
    # justify-base64url-over-base64: handles and tokens travel in url paths and fragments.
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _canonical_b64url(value: str) -> bytes:
    # justify-base64url-over-base64: the url-safe alphabet _b64url writes. binascii.Error is a
    # ValueError, which every caller maps.
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if _b64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def _parse(raw: str) -> tuple[bytes, bytes]:
    match = _DISCOVERY_TARGET_RE.fullmatch(raw)
    if match is None:
        raise ValueError("invalid discovery target handle grammar")
    payload, tag = _canonical_b64url(match.group(1)), _canonical_b64url(match.group(2))
    if not payload or len(payload) > _DISCOVERY_TARGET_MAX_BYTES or len(tag) != 32:
        raise ValueError("invalid discovery target handle size")
    return payload, tag


def _tag(payload: bytes) -> bytes:
    key = hmac.new(
        get_settings().handle_key, b"nexus-handle-key\0browse-discovery-target", hashlib.sha256
    ).digest()
    return hmac.new(key, b"nexus-discovery-target\0" + payload, hashlib.sha256).digest()


def seal_discovery_target(canonical_payload: bytes) -> DiscoveryTargetHandle:
    if not canonical_payload or len(canonical_payload) > _DISCOVERY_TARGET_MAX_BYTES:
        raise ValueError("Invalid discovery target payload")
    payload, tag = _b64url(canonical_payload), _b64url(_tag(canonical_payload))
    return DiscoveryTargetHandle(f"ndt1.{payload}.{tag}")


def unseal_discovery_target(raw: str) -> bytes:
    try:
        payload, tag = _parse(raw)
    except ValueError as exc:
        raise InvalidDiscoveryTargetHandle from exc
    if not hmac.compare_digest(tag, _tag(payload)):
        raise InvalidDiscoveryTargetHandle
    return payload


def new_share_token() -> str:
    return f"nxshr1_{_b64url(secrets.token_bytes(32))}"
