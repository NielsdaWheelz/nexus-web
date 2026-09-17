"""Browse composition over the one signed keyset cursor codec."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from nexus.services.browse.models import BrowseQuery
from nexus.services.sealed_handles import DiscoveryTargetHandle
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

_SEARCH_FAMILY = "BrowseSearch"
_PREVIEW_EPISODES_FAMILY = "BrowsePreviewEpisodes"


def _search_digest(
    query: BrowseQuery,
    *,
    viewer_id: UUID,
    provider_contract: str,
) -> dict[str, object]:
    return {
        "viewer": str(viewer_id),
        "query": query.query,
        "kind": query.kind.value,
        "source": query.source.value,
        "sort": query.sort.value if query.sort is not None else "Default",
        "providerContract": provider_contract,
        "locale": "und",
        "safety": "moderate",
    }


def encode_search_cursor(
    query: BrowseQuery,
    *,
    viewer_id: UUID,
    provider_contract: str,
    after: int | str,
) -> str:
    kind = KeysetValueKind.Int if isinstance(after, int) else KeysetValueKind.Text
    return encode_signed_keyset_cursor(
        family=_SEARCH_FAMILY,
        query=_search_digest(query, viewer_id=viewer_id, provider_contract=provider_contract),
        after=(KeysetValue(kind, after),),
    )


def decode_search_cursor(
    cursor: str,
    query: BrowseQuery,
    *,
    viewer_id: UUID,
    provider_contract: str,
    kind: KeysetValueKind,
) -> int | str:
    (value,) = decode_signed_keyset_cursor(
        cursor,
        family=_SEARCH_FAMILY,
        query=_search_digest(query, viewer_id=viewer_id, provider_contract=provider_contract),
        expected_kinds=(kind,),
    )
    if kind is KeysetValueKind.Int:
        return cast(int, value)
    return cast(str, value)


def _preview_digest(*, viewer_id: UUID, target: DiscoveryTargetHandle) -> dict[str, object]:
    return {
        "viewer": str(viewer_id),
        "target": str(target),
        "provider": "PodcastIndex",
        "order": "PublishedDescending",
    }


def encode_preview_episodes_cursor(
    *,
    viewer_id: UUID,
    target: DiscoveryTargetHandle,
    before_published: int,
    before_episode_ref: str,
) -> str:
    return encode_signed_keyset_cursor(
        family=_PREVIEW_EPISODES_FAMILY,
        query=_preview_digest(viewer_id=viewer_id, target=target),
        after=(
            KeysetValue(KeysetValueKind.Int, before_published),
            KeysetValue(KeysetValueKind.Text, before_episode_ref),
        ),
    )


def decode_preview_episodes_cursor(
    cursor: str,
    *,
    viewer_id: UUID,
    target: DiscoveryTargetHandle,
) -> tuple[int, str]:
    published, episode_ref = decode_signed_keyset_cursor(
        cursor,
        family=_PREVIEW_EPISODES_FAMILY,
        query=_preview_digest(viewer_id=viewer_id, target=target),
        expected_kinds=(KeysetValueKind.Int, KeysetValueKind.Text),
    )
    return cast(int, published), cast(str, episode_ref)
