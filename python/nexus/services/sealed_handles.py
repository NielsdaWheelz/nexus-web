"""Browse discovery-target handles and resource-share bearer tokens.

A discovery target handle seals the canonical payload of one browse result so a
client can name it back but never forge one. Share tokens are high-entropy bearer
credentials resolved through a domain-separated verifier.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets

from pydantic_core import core_schema

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_DISCOVERY_TARGET_MAX_BYTES = 4_096
_DISCOVERY_TARGET_TAG_BYTES = 32
_SHARE_TOKEN_BYTES = 32
_SHARE_TOKEN_CHARS = 43
_HANDLE_KEY_INPUT_PREFIX = b"nexus-handle-key\0"
_DISCOVERY_TARGET_INPUT_PREFIX = b"nexus-discovery-target\0"
_DISCOVERY_TARGET_KEY_INPUT = b"nexus-handle-key\0browse-discovery-target"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_DISCOVERY_TARGET_RE = re.compile(r"^ndt1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$")
_SHARE_TOKEN_RE = re.compile(rf"^nxshr1_[A-Za-z0-9_-]{{{_SHARE_TOKEN_CHARS}}}$")


class InvalidShareToken(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid share token")


class InvalidDiscoveryTargetHandle(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
            "Invalid discovery target",
        )


class ShareToken(str):
    @classmethod
    def _validate(cls, value: str) -> ShareToken:
        return parse_share_token(value)

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


class DiscoveryTargetHandle(str):
    @classmethod
    def _validate(cls, value: str) -> DiscoveryTargetHandle:
        _parse_discovery_target_wire(value)
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


def derive_handle_key(domain: str, version: str) -> bytes:
    """Derive a versioned handle key for trusted ASCII domain and version constants."""
    material = _HANDLE_KEY_INPUT_PREFIX + domain.encode("ascii") + b"\0" + version.encode("ascii")
    return hmac.new(get_settings().handle_key, material, hashlib.sha256).digest()


def _b64url(raw: bytes) -> str:
    # justify-base64url-over-base64: sealed handles and bearer tokens travel in
    # URL path/fragment components, where the standard alphabet is unsafe.
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode_canonical_b64url(value: str, *, expected_bytes: int) -> bytes:
    if not _B64URL_RE.fullmatch(value):
        raise ValueError("invalid base64url alphabet")
    padding = "=" * (-len(value) % 4)
    try:
        # justify-base64url-over-base64: decode the canonical URL-safe wire
        # alphabet owned by _b64url above.
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if len(decoded) != expected_bytes or _b64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def _decode_variable_canonical_b64url(value: str) -> bytes:
    if not _B64URL_RE.fullmatch(value):
        raise ValueError("invalid base64url alphabet")
    try:
        decoded = base64.b64decode(
            value + "=" * (-len(value) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if not decoded or len(decoded) > _DISCOVERY_TARGET_MAX_BYTES or _b64url(decoded) != value:
        raise ValueError("noncanonical discovery target payload")
    return decoded


def _discovery_target_key() -> bytes:
    return hmac.new(get_settings().handle_key, _DISCOVERY_TARGET_KEY_INPUT, hashlib.sha256).digest()


def _discovery_target_tag(payload: bytes) -> bytes:
    return hmac.new(
        _discovery_target_key(),
        _DISCOVERY_TARGET_INPUT_PREFIX + payload,
        hashlib.sha256,
    ).digest()


def _parse_discovery_target_wire(raw: str) -> tuple[bytes, bytes]:
    match = _DISCOVERY_TARGET_RE.fullmatch(raw)
    if match is None:
        raise ValueError("invalid discovery target handle grammar")
    return (
        _decode_variable_canonical_b64url(match.group(1)),
        _decode_canonical_b64url(
            match.group(2),
            expected_bytes=_DISCOVERY_TARGET_TAG_BYTES,
        ),
    )


def seal_discovery_target(canonical_payload: bytes) -> DiscoveryTargetHandle:
    if not canonical_payload or len(canonical_payload) > _DISCOVERY_TARGET_MAX_BYTES:
        raise ValueError("Invalid discovery target payload")
    return DiscoveryTargetHandle(
        f"ndt1.{_b64url(canonical_payload)}.{_b64url(_discovery_target_tag(canonical_payload))}"
    )


def unseal_discovery_target(raw: str) -> bytes:
    try:
        payload, presented_tag = _parse_discovery_target_wire(raw)
    except ValueError as exc:
        raise InvalidDiscoveryTargetHandle from exc
    if not hmac.compare_digest(presented_tag, _discovery_target_tag(payload)):
        raise InvalidDiscoveryTargetHandle
    return payload


def new_share_token() -> ShareToken:
    return ShareToken(f"nxshr1_{_b64url(secrets.token_bytes(_SHARE_TOKEN_BYTES))}")


def parse_share_token(raw: str) -> ShareToken:
    if not _SHARE_TOKEN_RE.fullmatch(raw):
        raise InvalidShareToken
    encoded = raw.removeprefix("nxshr1_")
    try:
        _decode_canonical_b64url(encoded, expected_bytes=_SHARE_TOKEN_BYTES)
    except ValueError as exc:
        raise InvalidShareToken from exc
    return ShareToken(raw)
