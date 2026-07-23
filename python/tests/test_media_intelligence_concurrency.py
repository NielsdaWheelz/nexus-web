"""Concurrency contract for the Media Intelligence first-ensure owner."""

from __future__ import annotations

import threading

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.media_intelligence import ensure_media_unit
from tests.factories import create_test_media
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_concurrent_first_ensure_converges_on_one_head_and_job(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with direct_db.session() as db:
        media_id = create_test_media(db, title="Concurrent first ensure")

    # DirectSessionManager deletes in reverse registration order.
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("media_summaries", "media_id", media_id)
    direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))

    barrier = threading.Barrier(2)
    lock = threading.Lock()
    first_sight_reads = 0
    original_execute = Session.execute

    def synchronize_first_sight(self, statement, *args, **kwargs):  # noqa: ANN001
        nonlocal first_sight_reads
        result = original_execute(self, statement, *args, **kwargs)
        if "SELECT * FROM media_summaries WHERE media_id" in str(statement):
            with lock:
                first_sight_reads += 1
                should_wait = first_sight_reads <= 2
            if should_wait:
                barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(Session, "execute", synchronize_first_sight)
    refs = []
    errors: list[BaseException] = []

    def ensure() -> None:
        try:
            with direct_db.session() as db:
                refs.append(ensure_media_unit(db, media_id=media_id))
        except BaseException as exc:  # pragma: no cover - surfaced below
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=ensure, daemon=True) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert all(not thread.is_alive() for thread in threads), "concurrent ensures did not finish"
    assert errors == [], f"concurrent ensures raised: {errors!r}"
    assert len(refs) == 2
    assert refs[0].summary_id == refs[1].summary_id
    assert sum(ref.enqueued for ref in refs) == 1

    with direct_db.session() as db:
        assert (
            db.execute(
                text("SELECT count(*) FROM media_summaries WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
            == 1
        )
        jobs = (
            db.execute(
                text(
                    "SELECT payload, status FROM background_jobs "
                    "WHERE kind = 'media_unit_build' AND payload->>'media_id' = :media_id"
                ),
                {"media_id": str(media_id)},
            )
            .mappings()
            .all()
        )
        assert len(jobs) == 1
        assert jobs[0]["status"] == "pending"
        assert jobs[0]["payload"]["content_fingerprint"] == refs[0].content_fingerprint
