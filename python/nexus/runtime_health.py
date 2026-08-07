"""Runtime identity selection and bounded PostgreSQL readiness."""

from __future__ import annotations

import math
import os
import threading
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
_database_readiness_slot = threading.BoundedSemaphore(value=1)


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


def clear_runtime_identity_cache() -> None:
    """Clear process-local identity state for an owned test/runtime restart."""
    get_runtime_identity.cache_clear()


def database_revision_is_ready(observed_revisions: Sequence[str], expected_revision: str) -> bool:
    """Return whether PostgreSQL exposes exactly the baked single Alembic head."""
    return tuple(observed_revisions) == (expected_revision,)


def is_database_ready(
    *,
    database_url: str,
    expected_revision: str,
    timeout_seconds: float = DATABASE_READINESS_TIMEOUT_SECONDS,
) -> bool:
    """Probe PostgreSQL independently of the application pool within a fixed budget."""
    timeout = float(timeout_seconds)
    if not math.isfinite(timeout) or timeout < 2:
        raise ValueError("database readiness timeout must be finite and at least two seconds")
    if not _database_readiness_slot.acquire(blocking=False):
        return False
    deadline = time.monotonic() + timeout
    connect_timeout_seconds = max(1, math.floor(timeout / 2))
    statement_timeout_ms = max(1, math.floor((timeout - connect_timeout_seconds) * 1000))
    psycopg_url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    try:
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
        except psycopg.Error:
            return False
        return database_revision_is_ready(tuple(str(row[0]) for row in rows), expected_revision)
    finally:
        _database_readiness_slot.release()
