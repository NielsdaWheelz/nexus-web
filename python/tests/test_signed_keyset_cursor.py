import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta, timezone
from uuid import UUID

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services import signed_keyset_cursor
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

pytestmark = pytest.mark.unit

_QUERY = {
    "viewerId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "podcastId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "sort": "duration_desc",
}


def test_signed_keyset_cursor_round_trips_every_value_kind() -> None:
    instant = datetime(2026, 7, 29, 8, 9, 10, 123456, tzinfo=UTC)
    after = (
        KeysetValue(KeysetValueKind.Int, -7),
        KeysetValue(KeysetValueKind.DateTime, instant),
        KeysetValue(KeysetValueKind.DateTimeOrNull, None),
        KeysetValue(KeysetValueKind.DateTimeOrNull, instant),
        KeysetValue(
            KeysetValueKind.Uuid,
            UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ),
        KeysetValue(KeysetValueKind.Text, "Title"),
        KeysetValue(KeysetValueKind.TextOrNull, None),
        KeysetValue(KeysetValueKind.TextOrNull, "Creator"),
    )

    cursor = encode_signed_keyset_cursor(
        family="PodcastEpisodes",
        query=_QUERY,
        after=after,
    )

    assert decode_signed_keyset_cursor(
        cursor,
        family="PodcastEpisodes",
        query=_QUERY,
        expected_kinds=tuple(value.kind for value in after),
    ) == tuple(value.value for value in after)
    assert "=" not in cursor


@pytest.mark.parametrize("changed", ["family", "query", "kind", "tag", "padding"])
def test_signed_keyset_cursor_fails_closed(changed: str) -> None:
    cursor = encode_signed_keyset_cursor(
        family="PodcastEpisodes",
        query=_QUERY,
        after=(KeysetValue(KeysetValueKind.Int, 1),),
    )
    family = "PodcastSubscriptions" if changed == "family" else "PodcastEpisodes"
    query = {**_QUERY, "sort": "newest"} if changed == "query" else _QUERY
    kinds = (KeysetValueKind.Text,) if changed == "kind" else (KeysetValueKind.Int,)
    if changed == "tag":
        cursor = f"{cursor[:-1]}{'A' if cursor[-1] != 'A' else 'B'}"
    elif changed == "padding":
        cursor = f"{cursor}="

    with pytest.raises(InvalidRequestError) as exc_info:
        decode_signed_keyset_cursor(
            cursor,
            family=family,
            query=query,
            expected_kinds=kinds,
        )

    assert exc_info.value.code == ApiErrorCode.E_INVALID_CURSOR


@pytest.mark.parametrize("changed", ["noncanonical", "extra_key"])
def test_signed_keyset_cursor_rejects_authenticated_noncanonical_bodies(
    monkeypatch: pytest.MonkeyPatch,
    changed: str,
) -> None:
    signing_key = b"x" * 32
    monkeypatch.setattr(signed_keyset_cursor, "_signing_key", lambda: signing_key)
    cursor = encode_signed_keyset_cursor(
        family="PodcastEpisodes",
        query=_QUERY,
        after=(KeysetValue(KeysetValueKind.Int, 1),),
    )
    packed = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
    body = json.loads(packed[:-32])
    if changed == "noncanonical":
        raw = json.dumps(body, indent=1).encode()
    else:
        body["version"] = 1
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    forged = base64.urlsafe_b64encode(
        raw + hmac.new(signing_key, raw, hashlib.sha256).digest()
    ).rstrip(b"=")

    with pytest.raises(InvalidRequestError) as exc_info:
        decode_signed_keyset_cursor(
            forged.decode(),
            family="PodcastEpisodes",
            query=_QUERY,
            expected_kinds=(KeysetValueKind.Int,),
        )

    assert exc_info.value.code == ApiErrorCode.E_INVALID_CURSOR


def test_signed_keyset_cursor_rejects_noncanonical_datetime_encoding() -> None:
    cursor = encode_signed_keyset_cursor(
        family="AuthorWorks",
        query={"viewerId": _QUERY["viewerId"], "contributorHandle": "author"},
        after=(
            KeysetValue(
                KeysetValueKind.DateTime,
                datetime(2026, 7, 29, 10, tzinfo=timezone_plus_two()),
            ),
        ),
    )
    packed = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
    body = json.loads(packed[:-32])

    assert body["after"] == [["datetime", "2026-07-29T08:00:00+00:00"]]


def timezone_plus_two() -> timezone:
    return timezone(timedelta(hours=2))


@pytest.mark.parametrize(
    ("kind", "value"),
    [
        (KeysetValueKind.Int, True),
        (KeysetValueKind.Int, 2**63),
        (KeysetValueKind.DateTime, datetime(2026, 7, 29)),
        (KeysetValueKind.DateTimeOrNull, "2026-07-29T00:00:00+00:00"),
        (KeysetValueKind.Uuid, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        (KeysetValueKind.Text, None),
        (KeysetValueKind.TextOrNull, 1),
    ],
)
def test_signed_keyset_cursor_rejects_invalid_owned_values(
    kind: KeysetValueKind,
    value: object,
) -> None:
    with pytest.raises((TypeError, ValueError)):
        encode_signed_keyset_cursor(
            family="PodcastEpisodes",
            query=_QUERY,
            after=(KeysetValue(kind, value),),
        )
