from typing import cast
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from nexus.services.contributors import _contributor_work_action_target

VIEWER_ID = UUID("11111111-1111-4111-8111-111111111111")
MEDIA_ID = UUID("22222222-2222-4222-8222-222222222222")
PODCAST_ID = UUID("33333333-3333-4333-8333-333333333333")
STATIC_ROUTE_SESSION = cast(Session, object())


@pytest.mark.unit
def test_resource_target_uses_typed_media_identity() -> None:
    target = _contributor_work_action_target(
        STATIC_ROUTE_SESSION,  # static media activation does not query the session
        viewer_id=VIEWER_ID,
        media_id=MEDIA_ID,
        podcast_id=None,
        gutenberg_ebook_id=None,
        href="/not-an-identity-source",
    )

    assert target.model_dump(mode="json", by_alias=True) == {
        "kind": "Resource",
        "ref": f"media:{MEDIA_ID}",
        "activation": {
            "resourceRef": f"media:{MEDIA_ID}",
            "kind": "route",
            "href": f"/media/{MEDIA_ID}",
            "unresolvedReason": None,
        },
        "missing": False,
    }


@pytest.mark.unit
def test_gutenberg_target_is_explicit_external_bridge_route() -> None:
    target = _contributor_work_action_target(
        STATIC_ROUTE_SESSION,
        viewer_id=VIEWER_ID,
        media_id=None,
        podcast_id=None,
        gutenberg_ebook_id=84,
        href="/browse/gutenberg/84",
    )

    assert target.model_dump(mode="json", by_alias=True) == {
        "kind": "External",
        "href": "/browse/gutenberg/84",
    }


@pytest.mark.unit
def test_resource_target_uses_typed_podcast_identity() -> None:
    target = _contributor_work_action_target(
        STATIC_ROUTE_SESSION,
        viewer_id=VIEWER_ID,
        media_id=None,
        podcast_id=PODCAST_ID,
        gutenberg_ebook_id=None,
        href="/not-an-identity-source",
    )

    assert target.model_dump(mode="json", by_alias=True) == {
        "kind": "Resource",
        "ref": f"podcast:{PODCAST_ID}",
        "activation": {
            "resourceRef": f"podcast:{PODCAST_ID}",
            "kind": "route",
            "href": f"/podcasts/{PODCAST_ID}",
            "unresolvedReason": None,
        },
        "missing": False,
    }


@pytest.mark.unit
def test_work_target_defects_without_exactly_one_identity() -> None:
    with pytest.raises(AssertionError, match="exactly one target identity"):
        _contributor_work_action_target(
            STATIC_ROUTE_SESSION,
            viewer_id=VIEWER_ID,
            media_id=MEDIA_ID,
            podcast_id=MEDIA_ID,
            gutenberg_ebook_id=None,
            href="/not-used",
        )
