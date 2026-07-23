"""Hermetic helpers for driving one dossier build through the public job queue."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow, claim_next_job, dead_letter_expired_job

_DOSSIER_BUILD_PRIORITY = -(2**31)


def _dossier_job_id(db: Session, *, build_id: UUID) -> UUID:
    job_id = db.execute(
        text(
            "SELECT id FROM background_jobs "
            "WHERE kind = 'dossier_build' AND dedupe_key = :dedupe_key"
        ),
        {"dedupe_key": f"dossier_build:{build_id}"},
    ).scalar_one()
    return UUID(str(job_id))


def _assert_dossier_build_job(
    job: JobRow | None,
    *,
    expected_job_id: UUID,
    build_id: UUID,
) -> JobRow:
    assert job is not None, f"no claimable dossier_build job for build {build_id}"
    assert job.id == expected_job_id, (
        f"public queue selected dossier_build job {job.id}, expected {expected_job_id} "
        f"for build {build_id}"
    )
    assert job.kind == "dossier_build"
    assert job.dedupe_key == f"dossier_build:{build_id}"
    assert str(job.payload.get("build_id")) == str(build_id)
    return job


def claim_dossier_build_job(
    db: Session,
    *,
    build_id: UUID,
    worker_id: str,
    lease_seconds: int = 600,
) -> JobRow:
    """Prioritize and claim exactly one build through ``claim_next_job``."""
    expected_job_id = _dossier_job_id(db, build_id=build_id)
    db.execute(
        text("UPDATE background_jobs SET priority = :priority WHERE id = :job_id"),
        {"job_id": expected_job_id, "priority": _DOSSIER_BUILD_PRIORITY},
    )
    return _assert_dossier_build_job(
        claim_next_job(
            db,
            worker_id=worker_id,
            lease_seconds=lease_seconds,
            allowed_kinds=["dossier_build"],
        ),
        expected_job_id=expected_job_id,
        build_id=build_id,
    )


def dead_letter_dossier_build_job(db: Session, *, build_id: UUID) -> JobRow:
    """Dead-letter exactly one eligible build through the public queue primitive."""
    expected_job_id = _dossier_job_id(db, build_id=build_id)
    db.execute(
        text(
            "UPDATE background_jobs SET lease_expires_at = '-infinity'::timestamptz "
            "WHERE id = :job_id"
        ),
        {"job_id": expected_job_id},
    )
    return _assert_dossier_build_job(
        dead_letter_expired_job(db, allowed_kinds=["dossier_build"]),
        expected_job_id=expected_job_id,
        build_id=build_id,
    )
