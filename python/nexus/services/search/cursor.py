"""Offset-cursor encode/decode for search pagination."""

from __future__ import annotations

import base64
import json

from nexus.errors import ApiErrorCode, InvalidRequestError

# =============================================================================
# Cursor Encoding/Decoding
# =============================================================================


def encode_search_cursor(offset: int) -> str:
    """Encode a cursor for search pagination.

    Cursor payload: {"offset": <int>}
    Encoding: base64url without padding
    """
    payload = {"offset": offset}
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def decode_search_cursor(cursor: str) -> int:
    """Decode a cursor for search pagination.

    Returns:
        offset value

    Raises:
        InvalidRequestError: If cursor is malformed or unparseable.
    """
    try:
        # Add padding if needed
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding

        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        if not isinstance(payload, dict):
            raise ValueError("Cursor payload must be an object")
        offset = payload["offset"]
        if type(offset) is not int:
            raise ValueError("Cursor offset must be an integer")
        if offset < 0:
            raise ValueError("Offset must be non-negative")
        return offset
    except (KeyError, ValueError):
        # justify-ignore-error: malformed cursor decode path. ValueError covers
        # binascii.Error, json.JSONDecodeError, UnicodeDecodeError, and the
        # explicit shape/offset raises; KeyError covers a missing offset key.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None
