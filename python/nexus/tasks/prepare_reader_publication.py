"""Backfill one accepted generation without replacing canonical source identity."""

from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import require_reader_publication_limits
from nexus.db.models import Media, ReaderPublication, ReaderPublicationArtifact
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, lock_and_renew_running_job_claim
from nexus.jobs.registry import get_default_registry
from nexus.schemas.reader_publication import ReaderPublicationPreparationRequest
from nexus.services.reader_publication import (
    ReaderPublicationBusy,
    install_current_reader_publication,
)
from nexus.services.reader_publication_backfill import prepare_current_reader_publication
from nexus.tasks.storage_object_cleanup import finalize_storage_object_write


def prepare_reader_publication(
    *,
    payload: Mapping[str, object],
    context: JobExecutionContext,
    session_factory: sessionmaker[Session] | None = None,
) -> dict[str, object]:
    request = ReaderPublicationPreparationRequest.model_validate(payload)
    factory = session_factory or get_session_factory()
    with factory() as db:
        current = db.scalar(
            select(ReaderPublication.generation).where(
                ReaderPublication.media_id == request.media_id
            )
        )
        if current != request.expected_generation:
            return {"status": "superseded", "reader_generation": request.expected_generation}
        if (
            db.get(
                ReaderPublicationArtifact,
                (request.media_id, request.expected_generation, "descriptor.json"),
            )
            is not None
        ):
            return {"status": "ready", "reader_generation": request.expected_generation}
    try:
        with prepare_current_reader_publication(
            factory,
            media_id=request.media_id,
            expected_generation=request.expected_generation,
            limits=require_reader_publication_limits(),
        ) as prepared:
            with factory() as db:
                media = db.scalar(
                    select(Media).where(Media.id == request.media_id).with_for_update()
                )
                if (
                    lock_and_renew_running_job_claim(
                        db,
                        context=context,
                        lease_seconds=get_default_registry()[
                            "prepare_reader_publication"
                        ].lease_seconds,
                    )
                    is None
                ):
                    db.rollback()
                    return {"status": "claim_lost"}
                if media is None:
                    return {"status": "media_deleted"}
                install_current_reader_publication(db, prepared=prepared)
                db.commit()
                # The committed members are now the DB owner of their bytes, so
                # conclude each reservation here instead of leaving it Armed until
                # its own deadline fires (spec 3.1 write reservation).
                for storage_path in sorted({member.storage_path for member in prepared.members}):
                    finalize_storage_object_write(
                        db, media_id=request.media_id, storage_path=storage_path
                    )
    except ReaderPublicationBusy:
        with factory() as db:
            current = db.scalar(
                select(ReaderPublication.generation).where(
                    ReaderPublication.media_id == request.media_id
                )
            )
        if current != request.expected_generation:
            return {"status": "superseded", "reader_generation": request.expected_generation}
        raise

    return {"status": "ready", "reader_generation": request.expected_generation}
