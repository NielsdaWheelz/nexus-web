"""Domain-authenticated entity handles and resource-share bearer tokens.

Entity handles identify rows but never authorize actions. Their MAC covers the
entity domain and version as well as the UUID. Share tokens are separate
high-entropy bearer credentials resolved through a domain-separated verifier.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from typing import ClassVar
from uuid import UUID

from pydantic_core import core_schema

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_ENTITY_ID_BYTES = 16
_ENTITY_TAG_BYTES = 16
_ENTITY_PART_CHARS = 22
_SHARE_TOKEN_BYTES = 32
_SHARE_TOKEN_CHARS = 43
_ENTITY_HANDLE_INPUT_PREFIX = b"nexus-handle\0"
_ENTITY_KEY_INPUT_PREFIX = b"nexus-handle-key\0"
_SHARE_TOKEN_HASH_PREFIX = b"nexus-share-token\0v1\0"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True, slots=True)
class _EntityHandleSpec:
    prefix: str
    domain: str
    version: str = "1"

    @property
    def pattern(self) -> re.Pattern[str]:
        return re.compile(
            rf"^{re.escape(self.prefix)}\."
            rf"[A-Za-z0-9_-]{{{_ENTITY_PART_CHARS}}}\."
            rf"[A-Za-z0-9_-]{{{_ENTITY_PART_CHARS}}}$"
        )


_RESOURCE_GRANT = _EntityHandleSpec(prefix="nrg1", domain="resource-grant")
_USER = _EntityHandleSpec(prefix="nus1", domain="user")
_LIBRARY_INVITATION = _EntityHandleSpec(
    prefix="nli1",
    domain="library-invitation",
)
_SHARE_TOKEN_RE = re.compile(rf"^nxshr1_[A-Za-z0-9_-]{{{_SHARE_TOKEN_CHARS}}}$")


class InvalidSealedHandle(InvalidRequestError):
    def __init__(self, message: str = "Invalid sealed handle") -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, message)


class InvalidShareToken(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid share token")


class _CanonicalEntityHandle(str):
    _spec: ClassVar[_EntityHandleSpec]

    @classmethod
    def _validate(cls, value: str) -> _CanonicalEntityHandle:
        _parse_entity_wire(value, cls._spec)
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


class ResourceGrantHandle(_CanonicalEntityHandle):
    _spec = _RESOURCE_GRANT


class UserHandle(_CanonicalEntityHandle):
    _spec = _USER


class LibraryInvitationHandle(_CanonicalEntityHandle):
    _spec = _LIBRARY_INVITATION


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


def _root_key() -> bytes:
    encoded = get_settings().effective_stream_token_signing_key
    try:
        root = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        # justify-defect: settings validated by this process must carry the
        # canonical base64 signing root used by every handle owner.
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY is not strict base64") from exc
    if len(root) < 32:
        # justify-defect: a shorter configured root violates the sealed-handle
        # security contract and cannot be a product-facing validation branch.
        raise RuntimeError("STREAM_TOKEN_SIGNING_KEY must decode to at least 32 bytes")
    return root


def _derived_key(spec: _EntityHandleSpec) -> bytes:
    material = (
        _ENTITY_KEY_INPUT_PREFIX
        + spec.domain.encode("ascii")
        + b"\0"
        + spec.version.encode("ascii")
    )
    return hmac.new(_root_key(), material, hashlib.sha256).digest()


def _authenticated_input(spec: _EntityHandleSpec, entity_id: UUID) -> bytes:
    return (
        _ENTITY_HANDLE_INPUT_PREFIX
        + spec.domain.encode("ascii")
        + b"\0"
        + spec.version.encode("ascii")
        + b"\0"
        + entity_id.bytes
    )


def _tag(spec: _EntityHandleSpec, entity_id: UUID) -> bytes:
    return hmac.new(
        _derived_key(spec),
        _authenticated_input(spec, entity_id),
        hashlib.sha256,
    ).digest()[:_ENTITY_TAG_BYTES]


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


def _parse_entity_wire(raw: str, spec: _EntityHandleSpec) -> tuple[UUID, bytes]:
    if not spec.pattern.fullmatch(raw):
        raise ValueError("invalid entity handle grammar")
    prefix, id_part, tag_part = raw.split(".")
    if prefix != spec.prefix:
        raise ValueError("wrong entity handle prefix")
    return (
        UUID(bytes=_decode_canonical_b64url(id_part, expected_bytes=_ENTITY_ID_BYTES)),
        _decode_canonical_b64url(tag_part, expected_bytes=_ENTITY_TAG_BYTES),
    )


def _seal(entity_id: UUID, spec: _EntityHandleSpec, handle_type):
    return handle_type(f"{spec.prefix}.{_b64url(entity_id.bytes)}.{_b64url(_tag(spec, entity_id))}")


def _unseal(raw: str, spec: _EntityHandleSpec, message: str) -> UUID:
    try:
        entity_id, presented_tag = _parse_entity_wire(raw, spec)
    except ValueError as exc:
        raise InvalidSealedHandle(message) from exc
    if not hmac.compare_digest(presented_tag, _tag(spec, entity_id)):
        raise InvalidSealedHandle(message)
    return entity_id


def seal_resource_grant(grant_id: UUID) -> ResourceGrantHandle:
    return _seal(grant_id, _RESOURCE_GRANT, ResourceGrantHandle)


def parse_resource_grant_handle(raw: str) -> ResourceGrantHandle:
    try:
        _parse_entity_wire(raw, _RESOURCE_GRANT)
    except ValueError as exc:
        raise InvalidSealedHandle("Invalid resource grant handle") from exc
    return ResourceGrantHandle(raw)


def unseal_resource_grant(raw: str) -> UUID:
    return _unseal(raw, _RESOURCE_GRANT, "Invalid resource grant handle")


def seal_user(user_id: UUID) -> UserHandle:
    return _seal(user_id, _USER, UserHandle)


def parse_user_handle(raw: str) -> UserHandle:
    try:
        _parse_entity_wire(raw, _USER)
    except ValueError as exc:
        raise InvalidSealedHandle("Invalid user handle") from exc
    return UserHandle(raw)


def unseal_user(raw: str) -> UUID:
    return _unseal(raw, _USER, "Invalid user handle")


def seal_library_invitation(invitation_id: UUID) -> LibraryInvitationHandle:
    return _seal(invitation_id, _LIBRARY_INVITATION, LibraryInvitationHandle)


def parse_library_invitation_handle(raw: str) -> LibraryInvitationHandle:
    try:
        _parse_entity_wire(raw, _LIBRARY_INVITATION)
    except ValueError as exc:
        raise InvalidSealedHandle("Invalid library invitation handle") from exc
    return LibraryInvitationHandle(raw)


def unseal_library_invitation(raw: str) -> UUID:
    return _unseal(raw, _LIBRARY_INVITATION, "Invalid library invitation handle")


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


def share_token_hash(token: ShareToken) -> bytes:
    return hashlib.sha256(_SHARE_TOKEN_HASH_PREFIX + token.encode("ascii")).digest()
