"""Priority proof: offline cursor writes are account- and publication-fenced."""

from __future__ import annotations

import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus, ReaderPublication
from nexus.errors import ApiError, ApiErrorCode
from nexus.ids import new_uuid7
from nexus.schemas.offline_reader_progress import OfflineReaderWrite
from nexus.schemas.reader import (
    CursorWrite,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import offline_reader_progress
from nexus.services.consumption import service as consumption
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_publication import replace_reader_publication
from tests.testkit.auth import StaticTokenVerifier, UserRecord


@dataclass(frozen=True, slots=True)
class _PublishedArticle:
    viewer_id: UUID
    email: str
    media_id: UUID
    fragment_id: UUID


@contextmanager
def _committed_published_article(engine: Engine) -> Iterator[_PublishedArticle]:
    viewer_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    email = f"offline-reader-progress-{viewer_id}@example.invalid"
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            email,
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Offline reader progress proof",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Publication-fenced progress.",
                html_sanitized="<p>Publication-fenced progress.</p>",
            )
        )
        db.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=7))
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    yield _PublishedArticle(viewer_id, email, media_id, fragment_id)


def _reader_media_state_row(article: _PublishedArticle, engine: Engine) -> dict[str, Any]:
    """The stored row itself, including the tuple header a rolled-back write marks.

    A rejected write must never reach the row: after a mutate-then-rollback the
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


def _assert_row_untouched(
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    fence: str,
) -> None:
    assert after == before, f"the {fence} fence changed reader_media_state: {before!r} -> {after!r}"
    assert after["xmax"] == "0", (
        f"the {fence} fence mutated reader_media_state and rolled back: {after!r}"
    )


def _progress_client(article: _PublishedArticle) -> TestClient:
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


def _await_blocked_publication_read(engine: Engine) -> None:
    """Wait until one request is blocked reading `reader_publications`."""
    deadline = time.monotonic() + 60.0
    observed = -1
    while time.monotonic() < deadline:
        with Session(engine) as db:
            observed = int(
                db.scalar(
                    text(
                        """
                        SELECT count(*)
                        FROM pg_locks lock_row
                        JOIN pg_class relation ON relation.oid = lock_row.relation
                        WHERE relation.relname = 'reader_publications'
                          AND lock_row.database = (
                              SELECT oid FROM pg_database WHERE datname = current_database()
                          )
                          AND NOT lock_row.granted
                        """
                    )
                )
                or 0
            )
            if observed >= 1:
                return
            db.execute(text("SELECT pg_sleep(0.02)"))
    raise AssertionError(
        f"no offline-reader-state request ever blocked on reader_publications ({observed} waiting)"
    )


def _cursor(fragment_id: UUID, *, offset: int) -> WebReaderResumeState:
    progression = offset / 100
    return WebReaderResumeState(
        kind="web",
        target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
        locations=ReaderTextLocations(
            text_offset=offset,
            progression=progression,
            total_progression=progression,
            position=1,
        ),
        text=ReaderQuoteContext(
            quote="progress",
            quote_prefix="Publication-fenced ",
            quote_suffix=".",
        ),
    )


def _write(
    *,
    generation: int,
    base_revision: int,
    locator: WebReaderResumeState,
) -> OfflineReaderWrite:
    return OfflineReaderWrite.model_validate(
        {
            "expectedReaderGeneration": generation,
            "baseRevision": base_revision,
            "locator": locator.model_dump(mode="json"),
        }
    )


def _prove_wrong_account_leaves_canonical_cursor_unchanged(
    engine: Engine,
) -> None:
    with _committed_published_article(engine) as article:
        accepted = _cursor(article.fragment_id, offset=10)
        rejected = _cursor(article.fragment_id, offset=20)
        canonical = consumption.put_reader_cursor(
            article.viewer_id,
            article.media_id,
            CursorWrite(locator=accepted, base_revision=0),
        )
        before = _reader_media_state_row(article, engine)

        with pytest.raises(ApiError) as wrong_account:
            offline_reader_progress.put(
                viewer_id=article.viewer_id,
                expected_account_id=uuid4(),
                media_id=article.media_id,
                write=_write(
                    generation=7,
                    base_revision=canonical.revision,
                    locator=rejected,
                ),
            )
        assert wrong_account.value.code == ApiErrorCode.E_FORBIDDEN

        with Session(engine) as db:
            observed = consumption.get_reader_cursor(db, article.viewer_id, article.media_id)
        assert observed == canonical, (
            "account fence mutated the canonical cursor: "
            f"expected={canonical!r} actual={observed!r}"
        )
        _assert_row_untouched(before, _reader_media_state_row(article, engine), fence="account")


def _prove_wrong_generation_leaves_canonical_cursor_unchanged(
    engine: Engine,
) -> None:
    with _committed_published_article(engine) as article:
        accepted = _cursor(article.fragment_id, offset=10)
        rejected = _cursor(article.fragment_id, offset=20)
        canonical = consumption.put_reader_cursor(
            article.viewer_id,
            article.media_id,
            CursorWrite(locator=accepted, base_revision=0),
        )
        before = _reader_media_state_row(article, engine)

        with pytest.raises(ApiError) as changed_publication:
            offline_reader_progress.put(
                viewer_id=article.viewer_id,
                expected_account_id=article.viewer_id,
                media_id=article.media_id,
                write=_write(
                    generation=6,
                    base_revision=canonical.revision,
                    locator=rejected,
                ),
            )
        assert changed_publication.value.code == ApiErrorCode.E_READER_CONTENT_CHANGED

        with Session(engine) as db:
            observed = consumption.get_reader_cursor(db, article.viewer_id, article.media_id)
        assert observed == canonical, (
            "publication fence mutated the canonical cursor: "
            f"expected={canonical!r} actual={observed!r}"
        )
        _assert_row_untouched(
            before,
            _reader_media_state_row(article, engine),
            fence="publication",
        )


def _prove_matching_account_and_generation_return_attested_canonical_snapshot(
    engine: Engine,
) -> None:
    with _committed_published_article(engine) as article:
        locator = _cursor(article.fragment_id, offset=25)
        saved = offline_reader_progress.put(
            viewer_id=article.viewer_id,
            expected_account_id=article.viewer_id,
            media_id=article.media_id,
            write=_write(generation=7, base_revision=0, locator=locator),
        )
        with Session(engine) as db:
            loaded = offline_reader_progress.get(
                db,
                viewer_id=article.viewer_id,
                expected_account_id=article.viewer_id,
                media_id=article.media_id,
            )

        assert loaded.account_id == article.viewer_id
        assert loaded.reader_generation == 7
        assert loaded.cursor == saved.cursor
        assert loaded.cursor.locator == locator


def _prove_api_returns_account_and_generation_attestation_headers(
    db_session: Session,
    authenticated_client: TestClient,
    test_user: UserRecord,
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.pdf.value,
            title="Offline progress API proof",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
        )
    )
    db_session.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=3))
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)

    response = authenticated_client.get(
        f"/media/{media_id}/offline-reader-state",
        headers={"X-Nexus-Expected-Account-Id": str(test_user.id)},
    )

    assert response.status_code == 200, response.text
    assert response.headers["Nexus-Account-Id"] == str(test_user.id)
    assert response.headers["Nexus-Reader-Generation"] == "3"
    assert response.json() == {
        "data": {
            "accountId": str(test_user.id),
            "readerGeneration": 3,
            "cursor": {"state": "Empty", "revision": 0},
        }
    }


def test_offline_progress_is_account_generation_and_response_attested(
    engine: Engine,
    db_session: Session,
    authenticated_client: TestClient,
    test_user: UserRecord,
) -> None:
    """One sensitivity owner proves every side of the offline CAS boundary."""

    _prove_wrong_account_leaves_canonical_cursor_unchanged(engine)
    _prove_wrong_generation_leaves_canonical_cursor_unchanged(engine)
    _prove_matching_account_and_generation_return_attested_canonical_snapshot(engine)
    _prove_api_returns_account_and_generation_attestation_headers(
        db_session,
        authenticated_client,
        test_user,
    )


def test_offline_reader_state_route_fences_account_and_generation_before_any_mutation(
    engine: Engine,
) -> None:
    """The PUT transport is where the native client's fences are actually bound.

    The header value, not the session, carries the account the device believes it
    is writing for, so the route must compare it with the authenticated viewer and
    refuse before `reader_media_state` is touched; success must attest the account
    and generation the device then persists.
    """
    with _committed_published_article(engine) as article:
        accepted = _cursor(article.fragment_id, offset=10)
        rejected = _cursor(article.fragment_id, offset=20)
        canonical = consumption.put_reader_cursor(
            article.viewer_id,
            article.media_id,
            CursorWrite(locator=accepted, base_revision=0),
        )
        before = _reader_media_state_row(article, engine)
        path = f"/media/{article.media_id}/offline-reader-state"
        body = {
            "expectedReaderGeneration": 7,
            "baseRevision": canonical.revision,
            "locator": rejected.model_dump(mode="json"),
        }

        with _progress_client(article) as client:
            foreign_account = client.put(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(uuid4())},
                json=body,
            )
            foreign_row = _reader_media_state_row(article, engine)
            wrong_generation = client.put(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(article.viewer_id)},
                json={**body, "expectedReaderGeneration": 6},
            )
            generation_row = _reader_media_state_row(article, engine)
            snake_case_body = client.put(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(article.viewer_id)},
                json={
                    "expected_reader_generation": 7,
                    "base_revision": canonical.revision,
                    "locator": rejected.model_dump(mode="json"),
                },
            )
            schema_row = _reader_media_state_row(article, engine)
            accepted_write = client.put(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(article.viewer_id)},
                json=body,
            )
            reread = client.get(
                path,
                headers={"X-Nexus-Expected-Account-Id": str(article.viewer_id)},
            )

    assert foreign_account.status_code == 403, foreign_account.text
    assert foreign_account.json()["error"]["code"] == "E_FORBIDDEN"
    _assert_row_untouched(before, foreign_row, fence="route account")
    assert wrong_generation.status_code == 409, wrong_generation.text
    assert wrong_generation.json()["error"]["code"] == "E_READER_CONTENT_CHANGED"
    _assert_row_untouched(before, generation_row, fence="route publication")
    assert snake_case_body.status_code == 400, (
        "the offline write schema is camelCase-only on the wire: "
        f"{snake_case_body.status_code} {snake_case_body.text[:200]}"
    )
    _assert_row_untouched(before, schema_row, fence="route write-schema")

    assert accepted_write.status_code == 200, accepted_write.text
    assert accepted_write.headers["Nexus-Account-Id"] == str(article.viewer_id)
    assert accepted_write.headers["Nexus-Reader-Generation"] == "7"
    written = accepted_write.json()["data"]
    assert written["accountId"] == str(article.viewer_id)
    assert written["readerGeneration"] == 7
    assert written["cursor"]["state"] == "Positioned"
    assert written["cursor"]["revision"] == canonical.revision + 1
    assert written["cursor"]["locator"] == rejected.model_dump(mode="json")
    assert reread.status_code == 200, reread.text
    assert reread.json()["data"] == written
    assert reread.headers["Nexus-Reader-Generation"] == "7"


def test_offline_reader_state_get_attests_one_snapshot_of_cursor_and_generation(
    engine: Engine,
) -> None:
    """The device persists this pair as one baseline, so it must be one instant.

    A publication that advances while the response is being assembled must not
    produce a cursor read at the old instant paired with the new generation.
    """
    with _committed_published_article(engine) as article:
        locator = _cursor(article.fragment_id, offset=10)
        canonical = consumption.put_reader_cursor(
            article.viewer_id,
            article.media_id,
            CursorWrite(locator=locator, base_revision=0),
        )
        client = _progress_client(article)
        path = f"/media/{article.media_id}/offline-reader-state"
        headers = {"X-Nexus-Expected-Account-Id": str(article.viewer_id)}

        with ThreadPoolExecutor(max_workers=1) as pool, Session(engine) as publisher:
            publisher.execute(text("LOCK TABLE reader_publications IN ACCESS EXCLUSIVE MODE"))
            try:
                call = pool.submit(client.get, path, headers=headers)
                _await_blocked_publication_read(engine)
                replace_reader_publication(
                    publisher,
                    media_id=article.media_id,
                    expected_kind=MediaKind.web_article.value,
                    replace_projection=lambda _media: None,
                )
                publisher.commit()
            finally:
                publisher.rollback()
            response = call.result(timeout=120)

        with Session(engine) as db:
            bumped = db.scalar(
                text("SELECT generation FROM reader_publications WHERE media_id = :media_id"),
                {"media_id": article.media_id},
            )

    assert bumped == 8, f"the racing publication never advanced its generation: {bumped!r}"
    assert response.status_code == 200, response.text
    observed = response.json()["data"]
    assert (observed["cursor"]["revision"], observed["readerGeneration"]) == (
        canonical.revision,
        7,
    ), (
        "the response paired a cursor read before the publication bump with the "
        f"generation after it: {observed!r}"
    )
    assert response.headers["Nexus-Reader-Generation"] == "7"
