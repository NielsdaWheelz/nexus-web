"""Source authorship defects remain worker defects, not product failures."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Contributor, MediaSourceAttempt
from nexus.jobs.queue import JobExecutionContext
from nexus.services.contributor_taxonomy import contributor_handle_candidates
from nexus.services.media_source_ingest import (
    accept_browser_article_capture,
    run_source_attempt,
)
from nexus.storage.client import get_storage_client
from tests.testkit.auth import UserRecord
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.upload_sessions import delete_storage_prefix


def test_source_author_identity_defect_is_not_persisted_as_ingest_failure(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    author_name = "Invariant Broken Author"
    response = accept_browser_article_capture(
        db=db_session,
        viewer_id=test_user.id,
        url=f"https://example.invalid/articles/{uuid4()}",
        content_html="<article><h1>Proof</h1><p>Captured body.</p></article>",
        source_html="<html><body><article>Captured body.</article></body></html>",
        library_ids=[],
        title="Author defect proof",
        byline=author_name,
        request_id="source-author-defect-proof",
    )
    assert response.ingest_enqueued

    attempt = db_session.get(MediaSourceAttempt, response.source_attempt_id)
    assert attempt is not None and attempt.job_id is not None
    job_id = attempt.job_id
    worker_id = "source-author-defect-worker"
    claimed = claim_job_row(
        db_session,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("ingest_media_source",),
    )
    assert claimed is not None
    db_session.add(
        Contributor(
            handle=next(contributor_handle_candidates(author_name)),
            display_name=author_name,
        )
    )
    db_session.commit()

    try:
        with pytest.raises(RuntimeError, match="Contributor handle candidates exhausted"):
            run_source_attempt(
                session_factory=sessionmaker(
                    bind=db_session.get_bind(),
                    autoflush=False,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                ),
                media_id=response.media_id,
                attempt_id=response.source_attempt_id,
                actor_user_id=test_user.id,
                request_id="source-author-defect-proof",
                context=JobExecutionContext(
                    job_id=job_id,
                    worker_id=worker_id,
                    attempt_no=claimed.attempts,
                    resource_class="Heavy",
                    execution_id=claimed.execution_id,
                ),
            )

        db_session.expire_all()
        persisted = db_session.get(MediaSourceAttempt, response.source_attempt_id)
        assert persisted is not None
        assert persisted.status == "running"
        assert persisted.error_code is None
        assert persisted.error_message is None
    finally:
        delete_storage_prefix(get_storage_client(), f"media/{response.media_id}/")
