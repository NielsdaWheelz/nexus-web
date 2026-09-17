"""Runtime identity selection and bounded PostgreSQL readiness."""

from __future__ import annotations

import math
import os
import time
from collections.abc import Mapping, Sequence
from functools import lru_cache
from pathlib import Path

import psycopg

from nexus.config import Environment, get_settings
from nexus.release_artifact import RuntimeIdentity, load_runtime_identity

NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV = "NEXUS_RUNTIME_IDENTITY_FILE"
PRODUCTION_RUNTIME_IDENTITY_FILE = Path("/app/runtime-identity.json")
DATABASE_READINESS_TIMEOUT_SECONDS = 2.0

# One canonical persisted-owner invariant shared by production readiness and the
# operator aggregate. An in-flight source attempt must point at its sole exact
# ingest job, and that owner must still be runnable/retryable or explicitly dead.
ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL = """
WITH in_flight_source AS (
    SELECT msa.id, msa.media_id, msa.job_id
    FROM media_source_attempts AS msa
    WHERE msa.status IN ('accepted', 'queued', 'running')
)
SELECT count(*)
FROM in_flight_source AS source
LEFT JOIN background_jobs AS owned_job
  ON owned_job.id = source.job_id
 AND owned_job.kind = 'ingest_media_source'
 AND owned_job.status IN ('pending', 'failed', 'running', 'dead')
 AND owned_job.payload @> jsonb_build_object(
        'media_id', source.media_id::text,
        'attempt_id', source.id::text
    )
CROSS JOIN LATERAL (
    SELECT count(*) AS exact_count
    FROM background_jobs AS exact_job
    WHERE exact_job.kind = 'ingest_media_source'
      AND exact_job.payload @> jsonb_build_object(
            'media_id', source.media_id::text,
            'attempt_id', source.id::text
          )
) AS exact_jobs
WHERE owned_job.id IS NULL OR exact_jobs.exact_count <> 1
"""


def runtime_identity_path(*, environment: Environment, environ: Mapping[str, str]) -> Path:
    """Select the sole identity file admitted by one deployment environment."""
    configured = environ.get(NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV)
    if environment in (Environment.STAGING, Environment.PROD):
        if configured is not None:
            raise RuntimeError(
                f"{NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV} is not permitted in staging/prod"
            )
        return PRODUCTION_RUNTIME_IDENTITY_FILE

    if configured is None or not configured.strip():
        raise RuntimeError(f"{NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV} is required in local/test")
    path = Path(configured)
    if not path.is_absolute():
        raise RuntimeError(f"{NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV} must be an absolute path")
    return path


@lru_cache(maxsize=1)
def get_runtime_identity() -> RuntimeIdentity:
    """Load the immutable identity selected for this process."""
    settings = get_settings()
    path = runtime_identity_path(environment=settings.nexus_env, environ=os.environ)
    return load_runtime_identity(path)


def database_revision_is_ready(observed_revisions: Sequence[str], expected_revision: str) -> bool:
    """Return whether PostgreSQL exposes exactly the baked single Alembic head."""
    return tuple(observed_revisions) == (expected_revision,)


def is_database_ready(
    *,
    database_url: str,
    expected_revision: str,
    timeout_seconds: float = DATABASE_READINESS_TIMEOUT_SECONDS,
    reconciler_max_age_seconds: int | None = None,
) -> bool:
    """Probe schema identity and, when required, fresh ingest reconciliation."""
    timeout = float(timeout_seconds)
    if not math.isfinite(timeout) or timeout < 2:
        raise ValueError("database readiness timeout must be finite and at least two seconds")
    if reconciler_max_age_seconds is not None and reconciler_max_age_seconds < 1:
        raise ValueError("reconciler readiness age must be positive")
    deadline = time.monotonic() + timeout
    connect_timeout_seconds = max(1, math.floor(timeout / 2))
    statement_timeout_ms = max(1, math.floor((timeout - connect_timeout_seconds) * 1000))
    psycopg_url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    latest_reconciler: Sequence[object] | None = None
    accepted_source_job_defect_count = 0
    try:
        with psycopg.connect(
            psycopg_url,
            autocommit=True,
            connect_timeout=connect_timeout_seconds,
            options=f"-c statement_timeout={statement_timeout_ms}",
            tcp_user_timeout=statement_timeout_ms,
        ) as connection:
            if time.monotonic() >= deadline:
                return False
            rows = connection.execute(
                "SELECT version_num FROM alembic_version ORDER BY version_num"
            ).fetchall()
            if not database_revision_is_ready(
                tuple(str(row[0]) for row in rows), expected_revision
            ):
                return False
            if reconciler_max_age_seconds is not None:
                latest_reconciler = connection.execute(
                    """
                    SELECT extract(
                        epoch FROM clock_timestamp() - finished_at
                    )
                    FROM background_jobs
                    WHERE kind = 'reconcile_stale_ingest_media_job'
                      AND status = 'succeeded'
                      AND finished_at IS NOT NULL
                    ORDER BY finished_at DESC, id DESC
                    LIMIT 1
                    """
                ).fetchone()
                defect_row = connection.execute(ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL).fetchone()
                if defect_row is None:
                    return False
                accepted_source_job_defect_count = int(defect_row[0])
    except psycopg.Error:
        return False
    if reconciler_max_age_seconds is None:
        return True
    if latest_reconciler is None:
        return False
    if accepted_source_job_defect_count != 0:
        return False
    raw_age = latest_reconciler[0]
    if raw_age is None:
        return False
    age_seconds = float(raw_age)
    return math.isfinite(age_seconds) and 0 <= age_seconds <= reconciler_max_age_seconds
