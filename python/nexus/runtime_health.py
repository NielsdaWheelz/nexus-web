"""Which build is serving, and whether its database is the one it expects."""

import asyncio
from functools import lru_cache
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from nexus.config import get_settings
from nexus.db.session import open_control_async_session
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


async def is_database_ready(*, expected_revision: str) -> bool:
    """One aggregate two-second deadline includes control checkout and joined cleanup."""
    try:
        async with asyncio.timeout(_READINESS_SECONDS):
            async with open_control_async_session() as database:
                rows = (
                    await database.execute(text("SELECT version_num FROM alembic_version"))
                ).all()
                return [str(row[0]) for row in rows] == [expected_revision]
    except (SQLAlchemyError, TimeoutError):
        return False
