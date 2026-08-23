"""Priority proof: an untyped confirm failure still settles with a keyed ConfirmFailed fact."""

from __future__ import annotations

import pytest
import structlog
from sqlalchemy import Engine, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from nexus.db.models import MediaUploadSession
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import (
    install_deferred_media_insert_failure,
    remove_deferred_media_insert_failure,
)
from tests.testkit.upload_sessions import upload_request


def test_confirm_failing_at_the_commit_boundary_records_a_confirm_failed_fact(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    """ConfirmStarted is never the last word about a confirm that died.

    A committed PostgreSQL constraint trigger fails the publication at the
    transaction boundary, which is outside the typed API error surface. The confirm
    must still settle its own story with a keyed ConfirmFailed fact carrying the
    generation, the request, and an internal error code — and no filename, URL,
    storage path, or content — because ConfirmStarted followed by silence leaves an
    operator unable to tell a dead confirm from one still running.
    """
    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    payload = b"%PDF-1.7\nconfirm failure fact source\n%%EOF"
    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=upload_request(filename="confirm-failed.pdf", size_bytes=len(payload)),
        request_id="confirm-failed-create",
        idempotency_key="confirm-failed-fact",
        storage_client=storage,
    )
    session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "confirm-failed-fact",
        )
    ).scalar_one()
    storage.put_object(
        build_upload_session_staging_storage_path(session.id, 1, "pdf"),
        payload,
        "application/pdf",
    )
    trigger_name, function_name = install_deferred_media_insert_failure(
        engine,
        media_id=session.candidate_media_id,
        discriminator=test_user.id.hex,
    )
    try:
        with structlog.testing.capture_logs() as confirm_facts:
            with pytest.raises(DBAPIError, match="forced upload publication commit failure"):
                confirm_upload_session(
                    db_session,
                    viewer_id=test_user.id,
                    session_handle=created.session_handle,
                    generation=1,
                    request_id="forced-commit-failure",
                    storage_client=storage,
                )
        confirm_events = [
            entry["event"]
            for entry in confirm_facts
            if entry.get("upload_session_id") == str(session.id)
        ]
        assert confirm_events == ["ConfirmStarted", "ConfirmFailed"]
        confirm_failed = next(entry for entry in confirm_facts if entry["event"] == "ConfirmFailed")
        assert confirm_failed["generation"] == 1
        assert confirm_failed["request_id"] == "forced-commit-failure"
        assert confirm_failed["error_code"] == "E_INTERNAL"
        assert {"filename", "upload_url", "storage_path", "content"}.isdisjoint(confirm_failed)
    finally:
        db_session.rollback()
        remove_deferred_media_insert_failure(
            engine, trigger_name=trigger_name, function_name=function_name
        )

    with Session(engine) as settled_oracle:
        settled = settled_oracle.get(MediaUploadSession, session.id)
        assert settled is not None
        assert settled.published_at is None
        assert settled.verification_token is None
