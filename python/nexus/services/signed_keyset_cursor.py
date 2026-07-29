"""One strict authenticated codec for collection keyset cursors."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import assert_never
from uuid import UUID

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_DOMAIN = b"nexus:signed-keyset-cursor:v1"
_MAC_BYTES = hashlib.sha256().digest_size
_MAX_CURSOR_CHARS = 16_384
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1
_FAMILY_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9:.]{0,127}\Z", re.ASCII)
_CURSOR_PATTERN = re.compile(r"[A-Za-z0-9_-]+\Z", re.ASCII)

type KeysetScalar = int | datetime | UUID | str | None


class KeysetValueKind(str, Enum):
    Int = "int"
    DateTime = "datetime"
    DateTimeOrNull = "datetime_or_null"
    Uuid = "uuid"
    Text = "text"
    TextOrNull = "text_or_null"


@dataclass(frozen=True)
class KeysetValue:
    kind: KeysetValueKind
    value: KeysetScalar


def _canonical_json(payload: object) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _query_digest(query: Mapping[str, object]) -> str:
    return hashlib.sha256(_canonical_json(query)).hexdigest()


def _signing_key() -> bytes:
    root = base64.b64decode(
        get_settings().effective_stream_token_signing_key,
        validate=True,
    )
    return hashlib.sha256(root + _DOMAIN).digest()


def _require_family(family: str) -> None:
    if not _FAMILY_PATTERN.fullmatch(family):
        raise ValueError("Invalid signed keyset cursor family")


def _canonical_datetime(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Keyset datetime must be timezone-aware")
    return value.astimezone(UTC).isoformat()


def _encode_value(kind: KeysetValueKind, value: KeysetScalar) -> object:
    match kind:
        case KeysetValueKind.Int:
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or not _INT64_MIN <= value <= _INT64_MAX
            ):
                raise ValueError("Invalid keyset integer")
            return value
        case KeysetValueKind.DateTime:
            if not isinstance(value, datetime):
                raise TypeError("Invalid keyset datetime")
            return _canonical_datetime(value)
        case KeysetValueKind.DateTimeOrNull:
            if value is None:
                return None
            if not isinstance(value, datetime):
                raise TypeError("Invalid nullable keyset datetime")
            return _canonical_datetime(value)
        case KeysetValueKind.Uuid:
            if not isinstance(value, UUID):
                raise TypeError("Invalid keyset UUID")
            return str(value)
        case KeysetValueKind.Text:
            if not isinstance(value, str):
                raise TypeError("Invalid keyset text")
            return value
        case KeysetValueKind.TextOrNull:
            if value is not None and not isinstance(value, str):
                raise TypeError("Invalid nullable keyset text")
            return value
        case _:
            assert_never(kind)


def _parse_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError
    parsed = datetime.fromisoformat(value)
    if _canonical_datetime(parsed) != value:
        raise ValueError
    return parsed


def _decode_value(kind: KeysetValueKind, value: object) -> KeysetScalar:
    match kind:
        case KeysetValueKind.Int:
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or not _INT64_MIN <= value <= _INT64_MAX
            ):
                raise ValueError
            return value
        case KeysetValueKind.DateTime:
            return _parse_datetime(value)
        case KeysetValueKind.DateTimeOrNull:
            return None if value is None else _parse_datetime(value)
        case KeysetValueKind.Uuid:
            if not isinstance(value, str):
                raise ValueError
            parsed = UUID(value)
            if str(parsed) != value:
                raise ValueError
            return parsed
        case KeysetValueKind.Text:
            if not isinstance(value, str):
                raise ValueError
            return value
        case KeysetValueKind.TextOrNull:
            if value is not None and not isinstance(value, str):
                raise ValueError
            return value
        case _:
            assert_never(kind)


def encode_signed_keyset_cursor(
    *,
    family: str,
    query: Mapping[str, object],
    after: Sequence[KeysetValue],
) -> str:
    _require_family(family)
    body = {
        "after": [[value.kind.value, _encode_value(value.kind, value.value)] for value in after],
        "family": family,
        "queryDigest": _query_digest(query),
    }
    raw = _canonical_json(body)
    token = base64.urlsafe_b64encode(
        raw + hmac.new(_signing_key(), raw, hashlib.sha256).digest()
    ).rstrip(b"=")
    if len(token) > _MAX_CURSOR_CHARS:
        raise ValueError("Signed keyset cursor is too large")
    return token.decode("ascii")


def decode_signed_keyset_cursor(
    cursor: str,
    *,
    family: str,
    query: Mapping[str, object],
    expected_kinds: Sequence[KeysetValueKind],
) -> tuple[KeysetScalar, ...]:
    _require_family(family)
    expected_digest = _query_digest(query)
    try:
        if not cursor or len(cursor) > _MAX_CURSOR_CHARS or not _CURSOR_PATTERN.fullmatch(cursor):
            raise ValueError
        packed = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        if base64.urlsafe_b64encode(packed).rstrip(b"=").decode("ascii") != cursor:
            raise ValueError
        if len(packed) <= _MAC_BYTES:
            raise ValueError
        raw, supplied_mac = packed[:-_MAC_BYTES], packed[-_MAC_BYTES:]
        expected_mac = hmac.new(_signing_key(), raw, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied_mac, expected_mac):
            raise ValueError
        body = json.loads(
            raw,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
        if _canonical_json(body) != raw:
            raise ValueError
        if (
            not isinstance(body, dict)
            or set(body) != {"after", "family", "queryDigest"}
            or body["family"] != family
            or body["queryDigest"] != expected_digest
        ):
            raise ValueError
        after = body["after"]
        if not isinstance(after, list) or len(after) != len(expected_kinds):
            raise ValueError
        decoded: list[KeysetScalar] = []
        for element, kind in zip(after, expected_kinds, strict=True):
            if not isinstance(element, list) or len(element) != 2 or element[0] != kind.value:
                raise ValueError
            decoded.append(_decode_value(kind, element[1]))
        return tuple(decoded)
    except (
        ValueError,
        TypeError,
        KeyError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ) as exc:
        # justify-ignore-error: malformed cursor input is one expected API error.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from exc
