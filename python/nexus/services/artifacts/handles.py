"""``ArtifactBuildHandle``: the sealed, non-authorizing outward identity of one
artifact build (CP2-TYPES, CONTRACTS.md A9/A19/B0).

The private ``artifact_builds.id`` UUID is never exposed raw. Every route that
names a build (cancel, event stream) speaks a tamper-evident sealed handle that
*identifies but never authorizes* — authorization is always a separate check on
the resolved build/head. There is deliberately no ``build`` ResourceScheme.

The seal is a minimal HMAC-SHA256 tag over the UUID bytes, keyed by the app's
signing secret (the same key material :mod:`nexus.services.stream_tokens` uses;
a dedicated owner rather than a shared JWT). It is tamper-evidence, not a
capability — do not treat a valid unseal as permission.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from dataclasses import dataclass
from uuid import UUID

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

# Namespaced, versioned prefix so a handle is self-describing and re-keyable.
_SEAL_VERSION = "ab1"
_SEP = "."
_MAC_BYTES = 16  # 128-bit truncated tag: ample tamper-evidence for a non-secret id.


class InvalidArtifactBuildHandle(InvalidRequestError):
    """The outward handle is malformed or its seal does not verify."""

    def __init__(self, message: str = "Invalid artifact build handle") -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, message)


@dataclass(frozen=True, slots=True)
class ArtifactBuildHandle:
    """A validated outward build identity. Construct via :func:`parse_artifact_build_handle`
    (untrusted ingress) or :func:`build_handle` (trusted mint); ``sealed`` is the
    wire string, ``build_id`` the recovered internal UUID."""

    build_id: UUID
    sealed: str

    def __str__(self) -> str:
        return self.sealed


def _seal_key() -> bytes:
    settings = get_settings()
    try:
        key = base64.b64decode(settings.effective_stream_token_signing_key, validate=True)
    except binascii.Error as exc:  # pragma: no cover - configuration error
        raise ValueError("artifact build seal key is not valid base64") from exc
    if len(key) < 32:  # pragma: no cover - configuration error
        raise ValueError("artifact build seal key must be at least 32 bytes")
    return key


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(raw: str) -> bytes:
    pad = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + pad)


def _tag(build_id: UUID) -> bytes:
    return hmac.new(_seal_key(), build_id.bytes, hashlib.sha256).digest()[:_MAC_BYTES]


def seal_artifact_build(build_id: UUID) -> str:
    """Mint the sealed outward handle for an internal build id."""
    return _SEP.join((_SEAL_VERSION, _b64(build_id.bytes), _b64(_tag(build_id))))


def unseal_artifact_build(raw: str) -> UUID:
    """Recover the internal build id from a sealed handle, or raise
    :class:`InvalidArtifactBuildHandle` on any malformed/forged input."""
    parts = raw.split(_SEP)
    if len(parts) != 3 or parts[0] != _SEAL_VERSION:
        raise InvalidArtifactBuildHandle
    try:
        id_bytes = _unb64(parts[1])
        mac = _unb64(parts[2])
    except (binascii.Error, ValueError) as exc:
        raise InvalidArtifactBuildHandle from exc
    if len(id_bytes) != 16:
        raise InvalidArtifactBuildHandle
    build_id = UUID(bytes=id_bytes)
    if not hmac.compare_digest(mac, _tag(build_id)):
        raise InvalidArtifactBuildHandle
    return build_id


def build_handle(build_id: UUID) -> ArtifactBuildHandle:
    """Trusted mint of the validated handle from an internal build id."""
    return ArtifactBuildHandle(build_id=build_id, sealed=seal_artifact_build(build_id))


def parse_artifact_build_handle(raw: str) -> ArtifactBuildHandle:
    """Ingress parse of an untrusted outward handle into the validated value."""
    return ArtifactBuildHandle(build_id=unseal_artifact_build(raw), sealed=raw)
