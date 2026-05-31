"""Unit tests for browse pagination cursor validation."""

import base64
import json
from uuid import uuid4

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.browse import browse_content

pytestmark = pytest.mark.unit


def _cursor(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")


def _assert_invalid_cursor(cursor: str, page_type: str = "podcasts") -> None:
    with pytest.raises(InvalidRequestError) as exc_info:
        browse_content(
            object(),
            uuid4(),
            "docs",
            limit=2,
            page_type=page_type,
            cursor=cursor,
        )

    assert exc_info.value.code == ApiErrorCode.E_INVALID_CURSOR


def test_browse_cursor_rejects_malformed_json_payload() -> None:
    _assert_invalid_cursor(base64.urlsafe_b64encode(b"[").decode("ascii").rstrip("="))


def test_browse_cursor_rejects_non_integer_offsets() -> None:
    _assert_invalid_cursor(
        _cursor(
            {
                "query": "docs",
                "page_type": "podcasts",
                "offset": "2",
            }
        )
    )


def test_browse_cursor_rejects_negative_offsets() -> None:
    _assert_invalid_cursor(
        _cursor(
            {
                "query": "docs",
                "page_type": "podcast_episodes",
                "offset": -1,
            }
        ),
        page_type="podcast_episodes",
    )


def test_browse_cursor_rejects_wrong_payload_type() -> None:
    _assert_invalid_cursor(_cursor(["docs", "podcasts", 2]))
