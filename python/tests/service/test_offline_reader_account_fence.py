"""Priority proof: the offline account binding is a refusal, not a hint.

The Android client carries the account it believes its downloaded copy belongs
to in `X-Nexus-Expected-Account-Id`. A WebView session that has silently rotated
to another Nexus account would otherwise let a device-held cursor land on the
newly authenticated account's canonical row. This proof owns that one fence,
separately from the publication-generation fence, so each has its own
demonstrated-red sensitivity owner.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import reader_publication
from nexus.services.consumption import reader_progress
from nexus.services.consumption import service as consumption
from tests.testkit.auth import StaticTokenVerifier
from tests.testkit.reader_progress import (
    PublishedArticle,
    committed_published_article,
    reader_cursor,
    reader_write,
)


def _reader_media_state_row(article: PublishedArticle, engine: Engine) -> dict[str, Any]:
    """The stored row itself, including the tuple header a rolled-back write marks.

    A refused write must never reach the row: after a mutate-then-rollback the
    original tuple keeps the aborted transaction in ``xmax``, so the projection
    alone cannot tell the two apart.
    """
    with Session(engine) as db:
        return dict(
            db.execute(
                text(
                    """
                    SELECT id,
                           locator::text AS locator,
                           revision,
                           created_at,
                           updated_at,
                           xmin::text AS xmin,
                           xmax::text AS xmax
                    FROM reader_media_state
                    WHERE user_id = :viewer_id AND media_id = :media_id
                    """
                ),
                {"viewer_id": article.viewer_id, "media_id": article.media_id},
            )
            .mappings()
            .one()
        )


def _progress_client(article: PublishedArticle) -> TestClient:
    """A client on the production FastAPI stack authenticated as the article's viewer.

    Only external token verification is controlled; the route, its account fence,
    and its committed session are the real ones.
    """
    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app: FastAPI = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=None,
        )
    )
    add_request_id_middleware(app, log_requests=False)
    return TestClient(app, headers={"Authorization": f"Bearer {verifier.token}"})


def test_a_foreign_expected_account_is_refused_at_every_offline_progress_entry(
    engine: Engine,
) -> None:
    """Read and write both refuse, and the canonical row is never touched."""
    with committed_published_article(engine) as article:
        accepted = reader_cursor(article.fragment_id, offset=10)
        rejected = reader_cursor(article.fragment_id, offset=80)
        foreign_account_id = uuid4()
        with Session(engine) as db:
            published_generation = reader_publication.read_publication_generation(
                db, media_id=article.media_id
            )
        assert published_generation is not None
        # The baseline is installed through the one writer every real client uses,
        # so the fence is proved against a cursor that carries real provenance.
        canonical = reader_progress.put(
            viewer_id=article.viewer_id,
            expected_account_id=article.viewer_id,
            media_id=article.media_id,
            write=reader_write(
                generation=published_generation,
                base_revision=0,
                locator=accepted,
            ),
        ).cursor
        before = _reader_media_state_row(article, engine)

        with pytest.raises(ApiError) as refused_write:
            reader_progress.put(
                viewer_id=article.viewer_id,
                expected_account_id=foreign_account_id,
                media_id=article.media_id,
                write=reader_write(
                    generation=published_generation,
                    base_revision=canonical.revision,
                    locator=rejected,
                ),
            )

        with Session(engine) as db, pytest.raises(ApiError) as refused_read:
            reader_progress.get(
                db,
                viewer_id=article.viewer_id,
                expected_account_id=foreign_account_id,
                media_id=article.media_id,
            )

        after_service = _reader_media_state_row(article, engine)

        path = f"/media/{article.media_id}/offline-reader-state"
        with _progress_client(article) as client:
            route_write = client.put(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(foreign_account_id)},
                json={
                    "expectedReaderGeneration": published_generation,
                    "baseRevision": canonical.revision,
                    "locator": rejected.model_dump(mode="json"),
                },
            )
            route_read = client.get(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(foreign_account_id)},
            )
        after_route = _reader_media_state_row(article, engine)

        with Session(engine) as db:
            observed = consumption.get_reader_cursor(db, article.viewer_id, article.media_id).cursor

    assert refused_write.value.code == ApiErrorCode.E_FORBIDDEN
    assert refused_read.value.code == ApiErrorCode.E_FORBIDDEN
    assert after_service == before, (
        f"the account fence changed reader_media_state: {before!r} -> {after_service!r}"
    )
    assert after_service["xmax"] == "0", (
        f"the account fence mutated reader_media_state and rolled back: {after_service!r}"
    )
    assert route_write.status_code == 403, route_write.text
    assert route_write.json()["error"]["code"] == "E_FORBIDDEN"
    assert route_read.status_code == 403, route_read.text
    assert route_read.json()["error"]["code"] == "E_FORBIDDEN"
    assert after_route == before, (
        f"the route account fence changed reader_media_state: {before!r} -> {after_route!r}"
    )
    assert after_route["xmax"] == "0", (
        f"the route account fence mutated reader_media_state and rolled back: {after_route!r}"
    )
    assert observed == canonical, (
        "the account fence mutated the canonical cursor: "
        f"expected={canonical!r} actual={observed!r}"
    )
