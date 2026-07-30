"""API/DB proof for concrete independent Browse sections and zero-write Preview."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text
from web_search_tool.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchRequest,
    WebSearchResponse,
)

from nexus.services.browse.models import gutenberg_target, seal_target
from tests.factories import create_searchable_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class _RecordingProvider:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        if self.fail:
            raise WebSearchError(
                WebSearchErrorCode.PROVIDER_DOWN,
                "down",
                provider="fixture",
            )
        return WebSearchResponse(
            results=(),
            provider="fixture",
            provider_request_id="fixture-request",
        )


def test_legacy_discovery_product_routes_are_not_registered(auth_client) -> None:
    route_paths = {getattr(route, "path", None) for route in auth_client.app.routes}
    assert "/web/search" not in route_paths
    assert "/podcasts/discover" not in route_paths


def _bootstrap(auth_client, user_id) -> dict[str, str]:
    headers = auth_headers(user_id)
    response = auth_client.get("/me", headers=headers)
    assert response.status_code == 200, response.text
    return headers


def _counts(direct_db: DirectSessionManager) -> dict[str, int]:
    tables = (
        "media",
        "podcasts",
        "podcast_subscriptions",
        "podcast_subscription_backfills",
        "podcast_episodes",
        "library_entries",
        "consumption_activity_spans",
    )
    with direct_db.session() as session:
        existing_tables = {
            table
            for table in tables
            if session.scalar(text("SELECT to_regclass(:table)"), {"table": table}) is not None
        }
        return {
            table: int(session.scalar(text(f"SELECT COUNT(*) FROM {table}")) or 0)
            for table in existing_tables
        }


def test_invalid_or_duplicate_browse_state_calls_no_provider(auth_client) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    provider = _RecordingProvider()
    auth_client.app.state.web_search_provider = provider

    response = auth_client.get(
        "/browse?q=one&q=two&kind=WebArticle&source=Brave&limit=10",
        headers=headers,
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_BROWSE_QUERY"
    assert provider.requests == []


def test_inapplicable_preview_cursor_is_invalid_before_resolution(auth_client) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    target = seal_target(gutenberg_target("1342"))

    response = auth_client.get(
        "/browse/preview",
        params={"target": target, "limit": "10", "cursor": "abc"},
        headers=headers,
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_DISCOVERY_TARGET"


def test_tampered_preview_target_is_terminal_before_provider_resolution(auth_client) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    target = seal_target(gutenberg_target("1342"))
    replacement = "A" if target[-1] != "A" else "B"

    response = auth_client.get(
        "/browse/preview",
        params={"target": f"{target[:-1]}{replacement}", "limit": "10"},
        headers=headers,
    )

    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["code"] == "E_INVALID_DISCOVERY_TARGET"
    assert error["message"] == "Invalid discovery target"


def test_missing_preview_target_is_terminal_and_writes_nothing(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    target = seal_target(gutenberg_target("2147483647"))

    before = _counts(direct_db)
    response = auth_client.get(
        "/browse/preview",
        params={"target": target, "limit": "10"},
        headers=headers,
    )
    after = _counts(direct_db)

    assert response.status_code == 404, response.text
    error = response.json()["error"]
    assert error["code"] == "E_NOT_FOUND"
    assert error["message"] == "No longer available"
    assert after == before


def test_one_source_failure_does_not_erase_an_independent_nexus_section(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    title = f"Independent Browse {uuid4()}"
    with direct_db.session() as session:
        media_id = create_searchable_media(session, user_id, title=title)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    auth_client.app.state.web_search_provider = _RecordingProvider(fail=True)
    failed = auth_client.get(
        "/browse",
        params={
            "q": "independent",
            "kind": "WebArticle",
            "source": "Brave",
            "limit": "10",
        },
        headers=headers,
    )
    nexus = auth_client.get(
        "/browse",
        params={
            "q": "independent",
            "kind": "WebArticle",
            "source": "Nexus",
            "limit": "10",
        },
        headers=headers,
    )

    assert failed.status_code == 503, failed.text
    error = failed.json()["error"]
    assert error["code"] == "E_BROWSE_PROVIDER_UNAVAILABLE"
    assert error["message"] == "Browse provider request failed"
    assert error["details"] == {"kind": "Unavailable"}
    assert nexus.status_code == 200, nexus.text
    page = nexus.json()["data"]
    assert set(page) == {
        "query",
        "kind",
        "source",
        "sort",
        "items",
        "nextCursor",
    }
    row = next(item for item in page["items"] if item["title"] == title)
    assert row["resolution"] == {
        "kind": "InNexus",
        "href": f"/media/{media_id}",
    }


def test_gutenberg_preview_refetches_provider_truth_and_writes_nothing(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    headers = _bootstrap(auth_client, user_id)
    ebook_id = 900_000 + uuid4().int % 90_000
    direct_db.register_cleanup("project_gutenberg_catalog", "ebook_id", ebook_id)
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO project_gutenberg_catalog (
                    ebook_id,
                    title,
                    subjects,
                    bookshelves,
                    download_count,
                    raw_metadata,
                    synced_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :ebook_id,
                    :title,
                    'Systems',
                    'Reference',
                    1,
                    '{}'::jsonb,
                    now(),
                    now(),
                    now()
                )
                """
            ),
            {"ebook_id": ebook_id, "title": "Fixture Systems Book"},
        )
        session.commit()

    before = _counts(direct_db)
    target = seal_target(gutenberg_target(str(ebook_id)))
    response = auth_client.get(
        "/browse/preview",
        params={"target": target, "limit": "10"},
        headers=headers,
    )
    after = _counts(direct_db)

    assert response.status_code == 200, response.text
    preview = response.json()["data"]
    assert set(preview) == {
        "kind",
        "source",
        "target",
        "title",
        "contributors",
        "description",
        "publishedAt",
        "image",
        "sourceHref",
        "resolution",
        "kindFacts",
    }
    assert preview["kind"] == "Epub"
    assert preview["source"] == "ProjectGutenberg"
    assert preview["target"] == target
    assert preview["title"] == "Fixture Systems Book"
    assert preview["resolution"] == {"kind": "Preview", "target": target}
    assert preview["kindFacts"] == {
        "ebookRef": str(ebook_id),
        "importHref": (f"https://www.gutenberg.org/ebooks/{ebook_id}.epub.noimages"),
    }
    assert after == before
