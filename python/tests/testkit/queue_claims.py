"""Claim one queue row for a proof that drives the job by hand.

``claim_job``/``claim_next_job`` return the claim (row plus the reclaim fact the
worker's history seam needs); a proof that executes a handler itself needs only
the row, so these unwrap it once instead of at every claim site.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow, claim_job, claim_next_job


def claim_job_row(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str] | None = None,
) -> JobRow | None:
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=lease_seconds,
        heavy_kinds=heavy_kinds,
        allowed_kinds=allowed_kinds,
    )
    return None if claimed is None else claimed.job


def claim_next_job_row(
    db: Session,
    *,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str] | None = None,
) -> JobRow | None:
    claimed = claim_next_job(
        db,
        worker_id=worker_id,
        lease_seconds=lease_seconds,
        heavy_kinds=heavy_kinds,
        allowed_kinds=allowed_kinds,
    )
    return None if claimed is None else claimed.job
