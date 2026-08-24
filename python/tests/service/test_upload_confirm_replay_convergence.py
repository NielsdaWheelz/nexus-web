"""Priority proof: a confirm replay behind the publication lock converges on published."""

from __future__ import annotations

from threading import Event, Thread
from uuid import UUID

from sqlalchemy import Engine, event, func, select
from sqlalchemy.orm import Session

from nexus.db.models import MediaSourceAttempt, MediaUploadSession
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.upload_sessions import ingest_job_count, upload_request


def test_confirm_replay_racing_the_publication_transaction_converges_on_published(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    """A replay that queues behind the winning publication lock is not a conflict.

    One locked read of the session row owns the "already published" decision, so a
    replay blocked on that lock observes the publication fact and returns the same
    projection instead of the 409 an unlocked pre-read used to race into.
    """
    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    payload = b"%PDF-1.7\nreplay race source\n%%EOF"
    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=upload_request(filename="replay-race.pdf", size_bytes=len(payload)),
        request_id="replay-race-create",
        idempotency_key="replay-race",
        storage_client=storage,
    )
    session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "replay-race",
        )
    ).scalar_one()
    storage.put_object(
        build_upload_session_staging_storage_path(session.id, 1, "pdf"),
        payload,
        "application/pdf",
    )

    publication_pending = Event()
    release_publication = Event()
    replay_locking = Event()
    winner_results: list[tuple[UUID, UUID, str]] = []
    replay_results: list[tuple[UUID, UUID, str]] = []
    thread_errors: list[Exception] = []

    def hold_inside_publication_transaction(pending_db: Session) -> None:
        pending = next(
            (
                value
                for value in pending_db.identity_map.values()
                if isinstance(value, MediaUploadSession)
                and value.id == session.id
                and value.published_at is not None
            ),
            None,
        )
        if pending is None or publication_pending.is_set():
            return
        publication_pending.set()
        if not release_publication.wait(timeout=20):
            raise AssertionError("winning publication was never released")

    def confirm(sink: list[tuple[UUID, UUID, str]], request_id: str) -> None:
        with Session(engine, expire_on_commit=False) as confirm_db:
            if request_id == "race-winner":
                event.listen(confirm_db, "before_commit", hold_inside_publication_transaction)
            try:
                result = confirm_upload_session(
                    confirm_db,
                    viewer_id=test_user.id,
                    session_handle=created.session_handle,
                    generation=1,
                    request_id=request_id,
                    storage_client=storage,
                )
                sink.append((result.media_id, result.source_attempt_id, result.idempotency_outcome))
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                thread_errors.append(exc)

    def note_replay_lock_wait(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "media_upload_sessions" in statement and "FOR UPDATE" in statement:
            replay_locking.set()

    winner = Thread(target=confirm, args=(winner_results, "race-winner"), name="race-winner")
    winner.start()
    replay: Thread | None = None
    try:
        assert publication_pending.wait(timeout=20), "publication transaction never opened"
        # The winner now holds the session row FOR UPDATE with its publication fact
        # staged but uncommitted; only the replay can issue that locking read next.
        event.listen(engine, "before_cursor_execute", note_replay_lock_wait)
        try:
            replay = Thread(
                target=confirm, args=(replay_results, "race-replay"), name="race-replay"
            )
            replay.start()
            assert replay_locking.wait(timeout=20), "replay never reached the session row lock"
        finally:
            event.remove(engine, "before_cursor_execute", note_replay_lock_wait)
    finally:
        release_publication.set()
        winner.join(timeout=30)
        if replay is not None:
            replay.join(timeout=30)

    assert not winner.is_alive() and replay is not None and not replay.is_alive()
    assert thread_errors == []
    assert len(winner_results) == 1 and len(replay_results) == 1
    assert winner_results[0][2] == "Created"
    assert replay_results[0][2] == "Reused"
    assert replay_results[0][0] == winner_results[0][0] == session.candidate_media_id
    assert replay_results[0][1] == winner_results[0][1]
    db_session.expire_all()
    assert (
        ingest_job_count(
            db_session, media_id=session.candidate_media_id, attempt_id=winner_results[0][1]
        )
        == 1
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == session.candidate_media_id)
        )
        == 1
    )
