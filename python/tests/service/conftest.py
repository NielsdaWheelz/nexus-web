"""Committed-state fixtures shared by service proofs."""

from __future__ import annotations

from collections.abc import Generator
from uuid import uuid4

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall, MediaUploadSession
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import (
    cleanup_committed_upload_user,
    delete_generations_by_ids,
    delete_jobs_by_ids,
)
from tests.testkit.upload_sessions import delete_storage_prefix


@pytest.fixture
def committed_chat_state_isolation(engine: Engine) -> Generator[None, None, None]:
    """Remove only queue and generation rows committed by the requesting proof."""

    with Session(engine) as db:
        existing_ids = frozenset(
            db.scalars(text("SELECT id FROM background_jobs WHERE kind = 'chat_run'")).all()
        )
        existing_generation_ids = frozenset(db.scalars(select(LLMCall.id)).all())
    yield
    with Session(engine) as db:
        current_ids = frozenset(
            db.scalars(text("SELECT id FROM background_jobs WHERE kind = 'chat_run'")).all()
        )
        current_generation_ids = frozenset(db.scalars(select(LLMCall.id)).all())
        delete_generations_by_ids(
            db,
            generation_ids=tuple(sorted(current_generation_ids - existing_generation_ids, key=str)),
        )
        delete_jobs_by_ids(
            db,
            job_ids=tuple(sorted(current_ids - existing_ids, key=str)),
        )
        db.commit()


@pytest.fixture
def committed_upload_support(engine: Engine) -> Generator[tuple[Session, UserRecord], None, None]:
    """Own one committed user whose upload rows and staged objects are torn down."""
    user_id = uuid4()
    email = f"upload-session-proof-{user_id}@example.invalid"
    db = Session(engine, expire_on_commit=False)
    default_library_id = ensure_user_and_default_library(db, user_id, email)
    db.commit()
    try:
        yield (
            db,
            UserRecord(
                id=user_id,
                email=email,
                default_library_id=default_library_id,
            ),
        )
    finally:
        storage = get_storage_client()
        for session in db.execute(
            select(MediaUploadSession).where(MediaUploadSession.created_by_user_id == user_id)
        ).scalars():
            for generation in range(1, session.upload_generation + 1):
                storage.delete_object(
                    build_upload_session_staging_storage_path(session.id, generation, session.kind)
                )
            delete_storage_prefix(storage, f"media/{session.candidate_media_id}/")
        db.close()
        cleanup_committed_upload_user(engine, user_id=user_id)
