"""Real-Postgres races for media/library reference mutations.

The public mutation services run on independent connections released by a common
barrier.  Every join is bounded: a lock-order regression fails as a hung worker,
while the final-state assertions prove that each race has a valid serial outcome.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from uuid import UUID

import pytest
from sqlalchemy import event, text

from nexus.errors import ApiError, ApiErrorCode
from nexus.services import library_entries, library_governance, media_deletion
from tests.factories import create_test_library, create_test_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _run_concurrently(targets: list[Callable[[], object]]) -> list[object]:
    barrier = threading.Barrier(len(targets))
    results: list[object] = [None] * len(targets)
    errors: list[BaseException] = []
    result_lock = threading.Lock()

    def run(index: int, target: Callable[[], object]) -> None:
        try:
            barrier.wait(timeout=10)
            result = target()
            with result_lock:
                results[index] = result
        except BaseException as exc:  # pragma: no cover - surfaced below
            with result_lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(index, target), daemon=True)
        for index, target in enumerate(targets)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    for thread in threads:
        if thread.is_alive():
            errors.append(AssertionError(f"worker thread did not finish: {thread.name}"))

    assert errors == [], f"concurrent workers raised: {errors!r}"
    return results


def _api_outcome(target: Callable[[], None]) -> str | ApiErrorCode:
    try:
        target()
    except ApiError as exc:
        return exc.code
    return "ok"


def _register_media_and_library_cleanup(
    direct_db: DirectSessionManager, media_id: UUID, *library_ids: UUID
) -> None:
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    for library_id in library_ids:
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)


def test_same_library_delete_vs_media_removal_has_a_serial_outcome(
    auth_client, direct_db: DirectSessionManager
) -> None:
    viewer_id = create_test_user_id()
    default_library_id = _bootstrap_user(auth_client, viewer_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Same-library race")
        library_id = create_test_library(session, viewer_id, "Same-library race")
        library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
        session.commit()
        library_entries.ensure_media_in_library(session, viewer_id, library_id, media_id)
    _register_media_and_library_cleanup(direct_db, media_id, library_id)

    def delete_library() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_governance.delete_library(session, viewer_id, library_id)
            )

    def remove_entry() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_entries.ensure_media_absent_from_library_for_viewer(
                    session, viewer_id, media_id, library_id
                )
            )

    delete_outcome, remove_outcome = _run_concurrently([delete_library, remove_entry])
    assert delete_outcome == "ok"
    assert remove_outcome in {"ok", ApiErrorCode.E_LIBRARY_NOT_FOUND}

    with direct_db.session() as session:
        assert (
            session.execute(
                text("SELECT 1 FROM libraries WHERE id = :id"), {"id": library_id}
            ).first()
            is None
        )
        references = {
            UUID(str(row[0]))
            for row in session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :id"),
                {"id": media_id},
            )
        }
    assert references == {default_library_id}


def test_two_library_delete_vs_last_reference_removal_never_leaves_zero_refs(
    auth_client, direct_db: DirectSessionManager
) -> None:
    viewer_id = create_test_user_id()
    _bootstrap_user(auth_client, viewer_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Last-reference race")
        deleting_library_id = create_test_library(session, viewer_id, "Deleting reference")
        removing_library_id = create_test_library(session, viewer_id, "Removing reference")
        for library_id in (deleting_library_id, removing_library_id):
            library_entries.ensure_entry(
                session, library_id, library_entries.media_target(media_id)
            )
        session.commit()
    _register_media_and_library_cleanup(
        direct_db, media_id, deleting_library_id, removing_library_id
    )

    def delete_library() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_governance.delete_library(session, viewer_id, deleting_library_id)
            )

    def remove_last_candidate() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_entries.ensure_media_absent_from_library_for_viewer(
                    session, viewer_id, media_id, removing_library_id
                )
            )

    delete_outcome, remove_outcome = _run_concurrently([delete_library, remove_last_candidate])
    assert delete_outcome == "ok"
    assert remove_outcome in {"ok", ApiErrorCode.E_MEDIA_LAST_REFERENCE}

    with direct_db.session() as session:
        media_exists = (
            session.execute(text("SELECT 1 FROM media WHERE id = :id"), {"id": media_id}).first()
            is not None
        )
        references = {
            UUID(str(row[0]))
            for row in session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :id"),
                {"id": media_id},
            )
        }
    if media_exists:
        assert remove_outcome == ApiErrorCode.E_MEDIA_LAST_REFERENCE
        assert references == {removing_library_id}
    else:
        assert remove_outcome == "ok"
        assert references == set()


def test_add_vs_library_delete_is_accounted_or_rejected_cleanly(
    auth_client, direct_db: DirectSessionManager
) -> None:
    viewer_id = create_test_user_id()
    default_library_id = _bootstrap_user(auth_client, viewer_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Add-delete race")
        library_id = create_test_library(session, viewer_id, "Add-delete race")
        library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
        session.commit()
    _register_media_and_library_cleanup(direct_db, media_id, library_id)

    def delete_library() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_governance.delete_library(session, viewer_id, library_id)
            )

    def add_entry() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_entries.ensure_media_in_library(
                    session, viewer_id, library_id, media_id
                )
            )

    delete_outcome, add_outcome = _run_concurrently([delete_library, add_entry])
    assert delete_outcome == "ok"
    assert add_outcome in {"ok", ApiErrorCode.E_LIBRARY_NOT_FOUND}

    with direct_db.session() as session:
        assert (
            session.execute(
                text("SELECT 1 FROM libraries WHERE id = :id"), {"id": library_id}
            ).first()
            is None
        )
        references = {
            UUID(str(row[0]))
            for row in session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :id"),
                {"id": media_id},
            )
        }
    assert references == {default_library_id}


@pytest.mark.parametrize("filing_api", ["singular", "bulk"])
@pytest.mark.parametrize("teardown", ["whole_resource", "last_library"])
def test_add_reauthorizes_after_waiting_on_concurrent_reachability_teardown(
    auth_client,
    direct_db: DirectSessionManager,
    filing_api: str,
    teardown: str,
) -> None:
    """A stale pre-lock read cannot recreate reachability after teardown.

    The worker pauses on its real ``FOR UPDATE`` statement after the public command's
    initial authorization. A separate session removes the final source reference through
    whole-resource deletion or whole-library teardown; only then may the filing acquire
    the media row. Both additive façades must reauthorize under that lock and return the
    masked media 404 whether the media is retained behind an intent or hard-deleted.
    """
    viewer_id = create_test_user_id()
    default_library_id = _bootstrap_user(auth_client, viewer_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title=f"Stale {teardown} {filing_api} filing")
        library_id = create_test_library(
            session, viewer_id, f"Stale {teardown} {filing_api} target"
        )
        source_library_id = default_library_id
        if teardown == "whole_resource":
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
        else:
            source_library_id = create_test_library(
                session, viewer_id, f"Stale {filing_api} source"
            )
            library_entries.ensure_entry(
                session,
                source_library_id,
                library_entries.media_target(media_id),
            )
        session.commit()
    cleanup_library_ids = [library_id]
    if source_library_id != default_library_id:
        cleanup_library_ids.append(source_library_id)
    _register_media_and_library_cleanup(direct_db, media_id, *cleanup_library_ids)
    if teardown == "whole_resource":
        direct_db.register_cleanup("background_jobs", "payload->>'mediaId'", str(media_id))
        direct_db.register_cleanup("media_teardown_intents", "media_id", media_id)

    prelock_reached = threading.Event()
    allow_media_lock = threading.Event()
    outcomes: list[str | ApiErrorCode] = []
    errors: list[BaseException] = []

    def add_after_stale_authorization() -> None:
        try:
            with direct_db.session() as session:
                connection = session.connection()
                paused = False

                def pause_before_media_lock(
                    _connection,
                    _cursor,
                    statement: str,
                    _parameters,
                    _context,
                    _executemany,
                ) -> None:
                    nonlocal paused
                    normalized = " ".join(statement.lower().split())
                    if (
                        paused
                        or "select 1 from media where id =" not in normalized
                        or "for update" not in normalized
                    ):
                        return
                    paused = True
                    prelock_reached.set()
                    if not allow_media_lock.wait(timeout=10):
                        raise AssertionError("timed out waiting to resume filing media lock")

                event.listen(connection, "before_cursor_execute", pause_before_media_lock)
                if filing_api == "singular":
                    outcome = _api_outcome(
                        lambda: library_entries.ensure_media_in_library(
                            session, viewer_id, library_id, media_id
                        )
                    )
                else:
                    outcome = _api_outcome(
                        lambda: library_entries.ensure_media_in_libraries_for_viewer(
                            session, viewer_id, media_id, [library_id]
                        )
                    )
                outcomes.append(outcome)
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    worker = threading.Thread(target=add_after_stale_authorization, daemon=True)
    worker.start()
    assert prelock_reached.wait(timeout=10), "filing did not reach its post-authorization lock"

    try:
        with direct_db.session() as session:
            if teardown == "whole_resource":
                result = media_deletion.delete_document_for_viewer(session, viewer_id, media_id)
                assert result.kind == "Deleting"
            else:
                library_governance.delete_library(session, viewer_id, source_library_id)
    finally:
        allow_media_lock.set()

    worker.join(timeout=20)
    assert not worker.is_alive(), "filing worker did not finish"
    assert errors == [], errors
    assert outcomes == [ApiErrorCode.E_MEDIA_NOT_FOUND]

    with direct_db.session() as session:
        assert (
            session.execute(
                text(
                    "SELECT 1 FROM library_entries "
                    "WHERE media_id = :media_id AND library_id = :library_id"
                ),
                {"media_id": media_id, "library_id": library_id},
            ).first()
            is None
        )
        media_exists = (
            session.execute(
                text("SELECT 1 FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            ).first()
            is not None
        )
        teardown_intent_exists = (
            session.execute(
                text("SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).first()
            is not None
        )
        if teardown == "whole_resource":
            assert media_exists
            assert teardown_intent_exists
        else:
            assert not media_exists
            assert not teardown_intent_exists
            assert (
                session.execute(
                    text("SELECT 1 FROM libraries WHERE id = :library_id"),
                    {"library_id": source_library_id},
                ).first()
                is None
            )


def test_whole_resource_delete_vs_media_removal_converges_replay_safely(
    auth_client, direct_db: DirectSessionManager
) -> None:
    viewer_id = create_test_user_id()
    other_owner_id = create_test_user_id()
    default_library_id = _bootstrap_user(auth_client, viewer_id)
    _bootstrap_user(auth_client, other_owner_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Whole-delete race")
        visible_library_id = create_test_library(session, viewer_id, "Visible reference")
        private_library_id = create_test_library(session, other_owner_id, "Private survivor")
        for library_id in (default_library_id, visible_library_id, private_library_id):
            library_entries.ensure_entry(
                session, library_id, library_entries.media_target(media_id)
            )
        session.commit()
    _register_media_and_library_cleanup(direct_db, media_id, visible_library_id, private_library_id)

    def delete_whole_resource() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: media_deletion.delete_document_for_viewer(session, viewer_id, media_id)
            )

    def remove_visible_entry() -> object:
        with direct_db.session() as session:
            return _api_outcome(
                lambda: library_entries.ensure_media_absent_from_library_for_viewer(
                    session, viewer_id, media_id, visible_library_id
                )
            )

    assert _run_concurrently([delete_whole_resource, remove_visible_entry]) == ["ok", "ok"]

    with direct_db.session() as session:
        references = {
            UUID(str(row[0]))
            for row in session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :id"),
                {"id": media_id},
            )
        }
        assert (
            session.execute(text("SELECT 1 FROM media WHERE id = :id"), {"id": media_id}).first()
            is not None
        )
    assert references == {private_library_id}
