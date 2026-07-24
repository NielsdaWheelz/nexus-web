"""Grant-bound sealed handles for anonymous reader navigation."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from nexus.config import get_settings

PublicHandleDomain = Literal["section", "asset", "page-cursor"]

_VERSION = "1"
_DECODED_BYTES = 36
_REVISION_DIGEST_BYTES = 16
_TAG_BYTES = 16
_PREFIX_BY_DOMAIN: dict[PublicHandleDomain, str] = {
    "section": "nxps1_",
    "asset": "nxpa1_",
    "page-cursor": "nxpc1_",
}
_WIRE_RE_BY_DOMAIN = {
    domain: re.compile(rf"^{re.escape(prefix)}[A-Za-z0-9_-]{{48}}$")
    for domain, prefix in _PREFIX_BY_DOMAIN.items()
}


@dataclass(frozen=True, slots=True)
class PublicHandleContext:
    grant_id: UUID
    parent_media_id: UUID
    source_revision_bytes: bytes

    @property
    def revision_digest(self) -> bytes:
        return hashlib.sha256(self.source_revision_bytes).digest()[:_REVISION_DIGEST_BYTES]


def seal_public_handle(
    domain: PublicHandleDomain,
    *,
    ordinal: int,
    context: PublicHandleContext,
    root_key: bytes | None = None,
) -> str:
    if ordinal < 0 or ordinal > 2**32 - 1:
        raise ValueError("public handle ordinal must fit unsigned 32-bit")
    ordinal_bytes = ordinal.to_bytes(4, "big")
    revision_digest = context.revision_digest
    tag = _tag(
        domain,
        context=context,
        ordinal_bytes=ordinal_bytes,
        revision_digest=revision_digest,
        root_key=root_key,
    )
    body = ordinal_bytes + revision_digest + tag
    # justify-base64url-over-base64: public handles travel in URL paths/query
    # parameters, so the canonical alphabet must not introduce '/' or '+'.
    encoded = base64.urlsafe_b64encode(body).rstrip(b"=").decode("ascii")
    return f"{_PREFIX_BY_DOMAIN[domain]}{encoded}"


def unseal_public_handle(
    domain: PublicHandleDomain,
    raw: str,
    *,
    context: PublicHandleContext,
    root_key: bytes | None = None,
) -> int | None:
    if _WIRE_RE_BY_DOMAIN[domain].fullmatch(raw) is None:
        return None
    encoded = raw[len(_PREFIX_BY_DOMAIN[domain]) :]
    try:
        # justify-base64url-over-base64: the value is read from a URL
        # path/query boundary.
        body = base64.b64decode(
            encoded + ("=" * (-len(encoded) % 4)),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, binascii.Error):
        return None
    if len(body) != _DECODED_BYTES:
        return None
    if base64.urlsafe_b64encode(body).rstrip(b"=").decode("ascii") != encoded:
        return None

    ordinal_bytes = body[:4]
    revision_digest = body[4:20]
    supplied_tag = body[20:]
    if not hmac.compare_digest(revision_digest, context.revision_digest):
        return None
    expected_tag = _tag(
        domain,
        context=context,
        ordinal_bytes=ordinal_bytes,
        revision_digest=revision_digest,
        root_key=root_key,
    )
    if not hmac.compare_digest(supplied_tag, expected_tag):
        return None
    return int.from_bytes(ordinal_bytes, "big")


def _tag(
    domain: PublicHandleDomain,
    *,
    context: PublicHandleContext,
    ordinal_bytes: bytes,
    revision_digest: bytes,
    root_key: bytes | None,
) -> bytes:
    key = _derive_domain_key(domain, root_key=root_key)
    authenticated_input = (
        b"nexus-public-handle\0"
        + domain.encode("ascii")
        + b"\0"
        + _VERSION.encode("ascii")
        + b"\0"
        + context.grant_id.bytes
        + context.parent_media_id.bytes
        + ordinal_bytes
        + revision_digest
    )
    return hmac.new(key, authenticated_input, hashlib.sha256).digest()[:_TAG_BYTES]


def _derive_domain_key(
    domain: PublicHandleDomain,
    *,
    root_key: bytes | None,
) -> bytes:
    root = root_key if root_key is not None else _load_root_key()
    if len(root) < 32:
        raise ValueError("public handle root key must be at least 32 bytes")
    key_input = b"nexus-handle-key\0" + domain.encode("ascii") + b"\0" + _VERSION.encode("ascii")
    return hmac.new(root, key_input, hashlib.sha256).digest()


def _load_root_key() -> bytes:
    encoded = get_settings().effective_stream_token_signing_key
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("STREAM_TOKEN_SIGNING_KEY is not valid base64") from exc
