"""Unit proof for exact Browse parsing, sealed targets, and signed cursors."""

from __future__ import annotations

import base64
import json
from dataclasses import replace
from uuid import uuid4

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.browse import parse_browse_preview_query, parse_browse_query
from nexus.services.browse.cursor import (
    BrowsePreviewEpisodesPlan,
    BrowseSearchPlan,
    decode_preview_episodes_cursor,
    decode_search_cursor,
    encode_preview_episodes_cursor,
    encode_search_cursor,
)
from nexus.services.browse.models import (
    BrowseKind,
    BrowseQuery,
    BrowseSource,
    brave_target,
    episode_target,
    gutenberg_target,
    podcast_target,
    seal_target,
    unseal_target,
    youtube_target,
)
from nexus.services.sealed_handles import seal_discovery_target

pytestmark = pytest.mark.unit


def _query(*, source: BrowseSource = BrowseSource.ProjectGutenberg) -> BrowseQuery:
    kind = BrowseKind.Epub
    if source is BrowseSource.YouTube:
        kind = BrowseKind.Video
    return BrowseQuery(
        query="systems",
        kind=kind,
        source=source,
        sort=None,
        limit=10,
        cursor=None,
    )


def _assert_code(code: ApiErrorCode, call) -> None:
    with pytest.raises(InvalidRequestError) as exc_info:
        call()
    assert exc_info.value.code is code


def test_browse_query_parser_accepts_only_one_exact_concrete_tuple() -> None:
    parsed = parse_browse_query(
        [
            ("q", "Café systems"),
            ("kind", "Video"),
            ("source", "YouTube"),
            ("sort", "Newest"),
            ("limit", "20"),
        ]
    )
    assert parsed.query == "Café systems"
    assert parsed.kind is BrowseKind.Video
    assert parsed.source is BrowseSource.YouTube
    assert parsed.sort is not None and parsed.sort.value == "Newest"
    assert parsed.limit == 20

    invalid_queries = [
        [("q", "systems"), ("kind", "Epub"), ("source", "ProjectGutenberg")],
        [
            ("q", "systems"),
            ("q", "other"),
            ("kind", "Epub"),
            ("source", "ProjectGutenberg"),
            ("limit", "10"),
        ],
        [
            ("q", " systems"),
            ("kind", "Epub"),
            ("source", "ProjectGutenberg"),
            ("limit", "10"),
        ],
        [
            ("q", "Cafe\u0301"),
            ("kind", "Epub"),
            ("source", "ProjectGutenberg"),
            ("limit", "10"),
        ],
        [
            ("q", "system\u0085s"),
            ("kind", "Epub"),
            ("source", "ProjectGutenberg"),
            ("limit", "10"),
        ],
        [
            ("q", "systems"),
            ("kind", "All"),
            ("source", "Nexus"),
            ("limit", "10"),
        ],
        [
            ("q", "systems"),
            ("kind", "Podcast"),
            ("source", "Nexus"),
            ("limit", "10"),
        ],
        [
            ("q", "systems"),
            ("kind", "Video"),
            ("source", "YouTube"),
            ("sort", "Relevance"),
            ("limit", "10"),
        ],
        [
            ("q", "systems"),
            ("kind", "Epub"),
            ("source", "ProjectGutenberg"),
            ("limit", "10"),
            ("documents", "true"),
        ],
    ]
    for query_items in invalid_queries:
        _assert_code(
            ApiErrorCode.E_INVALID_BROWSE_QUERY,
            lambda query_items=query_items: parse_browse_query(query_items),
        )


@pytest.mark.parametrize(
    "target",
    [
        gutenberg_target("1342"),
        brave_target("https://example.com/article", result_ref="brave:1"),
        youtube_target("dQw4w9WgXcQ"),
        podcast_target("75075"),
        episode_target("75075", "16795034"),
    ],
)
def test_discovery_target_handle_round_trips_only_the_closed_canonical_union(target) -> None:
    handle = seal_target(target)
    assert unseal_target(handle) == target
    parsed = parse_browse_preview_query([("target", handle), ("limit", "10")])
    assert parsed.target == handle

    replacement = "A" if handle[-1] != "A" else "B"
    _assert_code(
        ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
        lambda: unseal_target(f"{handle[:-1]}{replacement}"),
    )


def test_discovery_target_rejects_signed_obsolete_or_noncanonical_payloads() -> None:
    obsolete = seal_discovery_target(b'{"kind":"PodcastIndexShow","podcastRef":"75075"}')
    noncanonical = seal_discovery_target(b'{"podcastRef":"75075", "kind":"PodcastIndexPodcast"}')
    for handle in (obsolete, noncanonical):
        _assert_code(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
            lambda handle=handle: unseal_target(handle),
        )


def test_browse_search_cursor_binds_viewer_query_source_plan_and_scalar_kind() -> None:
    viewer_id = uuid4()
    query = _query()
    cursor = encode_search_cursor(
        query,
        viewer_id=viewer_id,
        provider_contract="ProjectGutenbergCatalogSearch",
        plan=BrowseSearchPlan.ProjectGutenbergRankOffset,
        after=20,
    )
    assert (
        decode_search_cursor(
            cursor,
            query,
            viewer_id=viewer_id,
            provider_contract="ProjectGutenbergCatalogSearch",
            plan=BrowseSearchPlan.ProjectGutenbergRankOffset,
        )
        == 20
    )

    wrong_bindings = [
        (
            query,
            uuid4(),
            "ProjectGutenbergCatalogSearch",
            BrowseSearchPlan.ProjectGutenbergRankOffset,
        ),
        (
            replace(query, query="other"),
            viewer_id,
            "ProjectGutenbergCatalogSearch",
            BrowseSearchPlan.ProjectGutenbergRankOffset,
        ),
        (
            query,
            viewer_id,
            "ProjectGutenbergCatalogSearch",
            BrowseSearchPlan.YouTubeSearchPageToken,
        ),
    ]
    for bound_query, bound_viewer, contract, plan in wrong_bindings:
        _assert_code(
            ApiErrorCode.E_INVALID_CURSOR,
            lambda bound_query=bound_query,
            bound_viewer=bound_viewer,
            contract=contract,
            plan=plan: decode_search_cursor(
                cursor,
                bound_query,
                viewer_id=bound_viewer,
                provider_contract=contract,
                plan=plan,
            ),
        )

    unsigned = base64.urlsafe_b64encode(json.dumps({"offset": 20}).encode()).decode().rstrip("=")
    _assert_code(
        ApiErrorCode.E_INVALID_CURSOR,
        lambda: decode_search_cursor(
            unsigned,
            query,
            viewer_id=viewer_id,
            provider_contract="ProjectGutenbergCatalogSearch",
            plan=BrowseSearchPlan.ProjectGutenbergRankOffset,
        ),
    )


def test_preview_episode_cursor_is_signed_and_cannot_cross_podcasts() -> None:
    viewer_id = uuid4()
    first = seal_target(podcast_target("75075"))
    second = seal_target(podcast_target("92001"))
    cursor = encode_preview_episodes_cursor(
        viewer_id=viewer_id,
        target=first,
        plan=BrowsePreviewEpisodesPlan.PodcastIndexBeforePublished,
        before_published=1_700_000_000,
        before_episode_ref="991",
    )
    assert decode_preview_episodes_cursor(
        cursor,
        viewer_id=viewer_id,
        target=first,
        plan=BrowsePreviewEpisodesPlan.PodcastIndexBeforePublished,
    ) == (1_700_000_000, "991")
    _assert_code(
        ApiErrorCode.E_INVALID_CURSOR,
        lambda: decode_preview_episodes_cursor(
            cursor,
            viewer_id=viewer_id,
            target=second,
            plan=BrowsePreviewEpisodesPlan.PodcastIndexBeforePublished,
        ),
    )
