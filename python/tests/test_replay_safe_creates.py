"""Replay and first-sight race contracts for client-minted resource creates."""

from __future__ import annotations

import threading
from collections.abc import Callable
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.notes import CreatePageRequest
from nexus.services import library_governance, notes
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap(auth_client, user_id: UUID) -> None:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text


def _run_concurrently(operations: list[Callable[[], UUID]]) -> list[UUID]:
    barrier = threading.Barrier(len(operations))
    results: list[UUID | None] = [None] * len(operations)
    errors: list[BaseException] = []
    lock = threading.Lock()

    def run(index: int, operation: Callable[[], UUID]) -> None:
        try:
            barrier.wait(timeout=10)
            result = operation()
            with lock:
                results[index] = result
        except BaseException as exc:  # pragma: no cover - surfaced below
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(index, operation), daemon=True)
        for index, operation in enumerate(operations)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    return [result for result in results if result is not None]


def _page_create(
    direct_db: DirectSessionManager,
    *,
    viewer_id: UUID,
    request: CreatePageRequest,
) -> UUID:
    with direct_db.session() as db:
        return notes.create_page(db, viewer_id, request).id


def _library_create(
    direct_db: DirectSessionManager,
    *,
    viewer_id: UUID,
    request: CreateLibraryRequest,
) -> UUID:
    with direct_db.session() as db:
        return library_governance.create_library(db, viewer_id, request).id


def test_page_response_loss_retry_and_concurrent_first_sight_converge(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    viewer_id = create_test_user_id()
    _bootstrap(auth_client, viewer_id)
    page_id = uuid4()
    request = CreatePageRequest(page_id=page_id, title="Replay-safe page")
    direct_db.register_cleanup("pages", "id", page_id)

    # The first response is deliberately ignored, modeling a lost response.
    _page_create(direct_db, viewer_id=viewer_id, request=request)
    assert _page_create(direct_db, viewer_id=viewer_id, request=request) == page_id

    concurrent_id = uuid4()
    concurrent = CreatePageRequest(page_id=concurrent_id, title="Concurrent page")
    direct_db.register_cleanup("pages", "id", concurrent_id)
    assert _run_concurrently(
        [
            lambda: _page_create(
                direct_db,
                viewer_id=viewer_id,
                request=concurrent,
            ),
            lambda: _page_create(
                direct_db,
                viewer_id=viewer_id,
                request=concurrent,
            ),
        ]
    ) == [concurrent_id, concurrent_id]

    with direct_db.session() as db:
        assert (
            db.execute(
                text("SELECT count(*) FROM pages WHERE id IN (:first_id, :concurrent_id)"),
                {"first_id": page_id, "concurrent_id": concurrent_id},
            ).scalar_one()
            == 2
        )
        assert (
            db.execute(
                text(
                    """
                    SELECT count(*)
                    FROM resource_versions
                    WHERE user_id = :viewer_id
                      AND resource_scheme = 'page'
                      AND resource_id = :page_id
                      AND lane IN ('title', 'outgoing_edges')
                    """
                ),
                {"viewer_id": viewer_id, "page_id": concurrent_id},
            ).scalar_one()
            == 2
        )


def test_page_same_id_payload_or_owner_mismatch_is_typed_conflict(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    owner_id = create_test_user_id()
    other_id = create_test_user_id()
    _bootstrap(auth_client, owner_id)
    _bootstrap(auth_client, other_id)
    page_id = uuid4()
    direct_db.register_cleanup("pages", "id", page_id)
    _page_create(
        direct_db,
        viewer_id=owner_id,
        request=CreatePageRequest(page_id=page_id, title="Original"),
    )

    for viewer_id, title in ((owner_id, "Changed"), (other_id, "Original")):
        with pytest.raises(ConflictError) as exc_info:
            _page_create(
                direct_db,
                viewer_id=viewer_id,
                request=CreatePageRequest(page_id=page_id, title=title),
            )
        assert exc_info.value.code == ApiErrorCode.E_RESOURCE_CONFLICT


def test_library_response_loss_retry_and_concurrent_first_sight_converge(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    viewer_id = create_test_user_id()
    _bootstrap(auth_client, viewer_id)
    library_id = uuid4()
    request = CreateLibraryRequest(library_id=library_id, name="Replay-safe library")
    direct_db.register_cleanup("libraries", "id", library_id)

    _library_create(direct_db, viewer_id=viewer_id, request=request)
    assert _library_create(direct_db, viewer_id=viewer_id, request=request) == library_id

    concurrent_id = uuid4()
    concurrent = CreateLibraryRequest(
        library_id=concurrent_id,
        name="Concurrent library",
    )
    direct_db.register_cleanup("libraries", "id", concurrent_id)
    assert _run_concurrently(
        [
            lambda: _library_create(
                direct_db,
                viewer_id=viewer_id,
                request=concurrent,
            ),
            lambda: _library_create(
                direct_db,
                viewer_id=viewer_id,
                request=concurrent,
            ),
        ]
    ) == [concurrent_id, concurrent_id]

    with direct_db.session() as db:
        membership = db.execute(
            text(
                """
                SELECT owner_user_id, m.user_id, m.role
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id
                WHERE l.id = :library_id
                """
            ),
            {"library_id": concurrent_id},
        ).one()
        assert membership == (viewer_id, viewer_id, "admin")


def test_library_same_id_payload_or_owner_mismatch_is_typed_conflict(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    owner_id = create_test_user_id()
    other_id = create_test_user_id()
    _bootstrap(auth_client, owner_id)
    _bootstrap(auth_client, other_id)
    library_id = uuid4()
    direct_db.register_cleanup("libraries", "id", library_id)
    _library_create(
        direct_db,
        viewer_id=owner_id,
        request=CreateLibraryRequest(library_id=library_id, name="Original"),
    )

    for viewer_id, name in ((owner_id, "Changed"), (other_id, "Original")):
        with pytest.raises(ConflictError) as exc_info:
            _library_create(
                direct_db,
                viewer_id=viewer_id,
                request=CreateLibraryRequest(library_id=library_id, name=name),
            )
        assert exc_info.value.code == ApiErrorCode.E_RESOURCE_CONFLICT


def test_create_routes_require_client_minted_ids(auth_client) -> None:
    viewer_id = create_test_user_id()
    _bootstrap(auth_client, viewer_id)

    page = auth_client.post(
        "/notes/pages",
        headers=auth_headers(viewer_id),
        json={"title": "Missing id"},
    )
    library = auth_client.post(
        "/libraries",
        headers=auth_headers(viewer_id),
        json={"name": "Missing id"},
    )
    assert page.status_code == 400
    assert library.status_code == 400
