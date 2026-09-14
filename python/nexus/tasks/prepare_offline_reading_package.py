"""Prepare and atomically retain one generation's verified schema-two archive."""

from collections.abc import Mapping
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import require_reader_publication_limits
from nexus.db.models import Media, ReaderPublicationArtifact
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, lock_and_renew_running_job_claim
from nexus.jobs.registry import get_default_registry
from nexus.schemas.offline_reading_preparation import OFFLINE_ARCHIVE_MEMBER_KEY
from nexus.services.offline_reading_delivery import build_offline_reading_archive_file
from nexus.services.offline_reading_preparation import (
    OFFLINE_PACKAGE_PREPARATION_JOB_KIND,
    read_ready_offline_archive,
)
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.reader_publication_artifacts import verify_reader_publication_asset
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_reader_publication_member_storage_path
from nexus.tasks.storage_object_cleanup import reserve_storage_object_write


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    media_id: UUID
    generation: int = Field(ge=1, strict=True)


def prepare_offline_reading_package(
    *,
    payload: Mapping[str, object],
    context: JobExecutionContext,
    session_factory: sessionmaker[Session] | None = None,
) -> dict[str, object]:
    request = _Payload.model_validate(payload)
    factory = session_factory or get_session_factory()
    with factory() as db:
        if (
            read_ready_offline_archive(db, media_id=request.media_id, generation=request.generation)
            is not None
        ):
            return {"status": "ready", "reader_generation": request.generation}
    limits = require_reader_publication_limits()
    storage = get_storage_client()
    with parser_attempt_directory(context.job_id) as directory:
        path = directory / "publication.zip"
        archive = build_offline_reading_archive_file(
            factory,
            media_id=request.media_id,
            generation=request.generation,
            limits=limits,
            path=path,
        )
        storage_path = build_reader_publication_member_storage_path(
            request.media_id, archive.account_independent_digest
        )
        with factory() as db:
            reserve_storage_object_write(db, media_id=request.media_id, storage_path=storage_path)
        with path.open("rb") as source:
            storage.put_object_stream(storage_path, source, archive.media_type)
        verify_reader_publication_asset(
            storage,
            key=OFFLINE_ARCHIVE_MEMBER_KEY,
            storage_path=storage_path,
            media_type=archive.media_type,
            expected_size_bytes=archive.compressed_length,
            expected_sha256=archive.account_independent_digest,
        )
    with factory() as db:
        media = db.scalar(select(Media).where(Media.id == request.media_id).with_for_update())
        if (
            lock_and_renew_running_job_claim(
                db,
                context=context,
                lease_seconds=get_default_registry()[
                    OFFLINE_PACKAGE_PREPARATION_JOB_KIND
                ].lease_seconds,
            )
            is None
        ):
            db.rollback()
            return {"status": "claim_lost"}
        if media is None:
            return {"status": "media_deleted"}
        descriptor = db.get(
            ReaderPublicationArtifact, (request.media_id, request.generation, "descriptor.json")
        )
        if descriptor is None:
            # justify-defect: the media row is locked above and still present,
            # and a retained generation's members are deleted only with it.
            raise AssertionError("retained publication disappeared without media deletion")
        existing = read_ready_offline_archive(
            db, media_id=request.media_id, generation=request.generation
        )
        if existing is not None:
            if existing.sha256 != archive.account_independent_digest:
                # justify-defect: retained members are immutable and assembly is
                # deterministic, so two attempts at one generation cannot differ.
                raise AssertionError(
                    "the same retained publication produced different archive bytes"
                )
        else:
            db.add(
                ReaderPublicationArtifact(
                    media_id=request.media_id,
                    generation=request.generation,
                    path=OFFLINE_ARCHIVE_MEMBER_KEY,
                    role="archive",
                    storage_path=storage_path,
                    media_type=archive.media_type,
                    size_bytes=archive.compressed_length,
                    sha256=archive.account_independent_digest,
                    archive_expanded_bytes=archive.expanded_length,
                )
            )
        db.commit()
    return {"status": "ready", "reader_generation": request.generation}
