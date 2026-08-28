"""Strict pagination-token boundary proof for object storage."""

from __future__ import annotations

from typing import Any, cast

import pytest
from botocore.client import BaseClient

from nexus.storage.client import StorageClient, StorageError


class _ListingS3Peer:
    def __init__(self, *, response: dict[str, Any]) -> None:
        self.response = response
        self.requests: list[dict[str, Any]] = []

    def list_objects_v2(self, **params: Any) -> dict[str, Any]:
        self.requests.append(params)
        return self.response


def _storage_client(peer: _ListingS3Peer) -> StorageClient:
    return StorageClient(
        endpoint_url="https://storage.invalid",
        access_key_id="access-key",
        secret_access_key="secret-key",
        bucket="bucket",
        s3_client=cast(BaseClient, peer),
    )


@pytest.mark.parametrize("continuation_token", ("", " padded", 7))
def test_storage_client_rejects_a_malformed_request_continuation_token(
    continuation_token: Any,
) -> None:
    peer = _ListingS3Peer(response={"IsTruncated": False, "Contents": []})

    with pytest.raises(StorageError, match="invalid continuation token"):
        _storage_client(peer).list_objects(
            "media/",
            continuation_token=continuation_token,
        )

    assert peer.requests == []


@pytest.mark.parametrize("next_continuation_token", (None, "", "padded ", 7))
def test_storage_client_rejects_a_truncated_page_without_a_canonical_next_token(
    next_continuation_token: Any,
) -> None:
    peer = _ListingS3Peer(
        response={
            "IsTruncated": True,
            "NextContinuationToken": next_continuation_token,
            "Contents": [],
        }
    )

    with pytest.raises(StorageError, match="invalid next continuation token"):
        _storage_client(peer).list_objects("media/")

    assert peer.requests == [{"Bucket": "bucket", "Prefix": "media/"}]


def test_storage_client_rejects_a_non_advancing_next_continuation_token() -> None:
    peer = _ListingS3Peer(
        response={
            "IsTruncated": True,
            "NextContinuationToken": "same-page",
            "Contents": [],
        }
    )

    with pytest.raises(StorageError, match="non-advancing next continuation token"):
        _storage_client(peer).list_objects(
            "media/",
            continuation_token="same-page",
        )

    assert peer.requests == [
        {
            "Bucket": "bucket",
            "Prefix": "media/",
            "ContinuationToken": "same-page",
        }
    ]
