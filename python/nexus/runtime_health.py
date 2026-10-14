"""Which build is serving, and whether its database is the one it expects."""

import time
from functools import lru_cache
from pathlib import Path

import psycopg

from nexus.config import get_settings
from nexus.release_artifact import RuntimeIdentity, load_runtime_identity

_BAKED_IDENTITY = Path("/app/runtime-identity.json")
_READINESS_SECONDS = 2.0


@lru_cache(maxsize=1)
def get_runtime_identity() -> RuntimeIdentity:
    """The image-baked identity when deployed, else NEXUS_RUNTIME_IDENTITY_FILE's."""
    settings = get_settings()
    path = _BAKED_IDENTITY if settings.deployed else settings.nexus_runtime_identity_file
    if path is None:
        raise RuntimeError("NEXUS_RUNTIME_IDENTITY_FILE is required in local/test")
    return load_runtime_identity(path)


def is_database_ready(*, database_url: str, expected_revision: str) -> bool:
    """The database answered within 2 s and its schema is exactly ``expected_revision``."""
    deadline = time.monotonic() + _READINESS_SECONDS
    try:
        with psycopg.connect(
            database_url.replace("postgresql+psycopg://", "postgresql://", 1),
            autocommit=True,
            connect_timeout=1,
            options="-c statement_timeout=1000",
            tcp_user_timeout=1000,
        ) as connection:
            if time.monotonic() >= deadline:
                return False
            rows = connection.execute("SELECT version_num FROM alembic_version").fetchall()
            return [str(row[0]) for row in rows] == [expected_revision]
    except psycopg.Error:
        return False
