import pytest

from nexus.config import clear_settings_cache
from nexus.db.engine import create_db_engine

pytestmark = pytest.mark.unit


def test_default_engine_pool_handles_browser_and_api_concurrency(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("DATABASE_POOL_SIZE", raising=False)
    monkeypatch.delenv("DATABASE_MAX_OVERFLOW", raising=False)
    monkeypatch.delenv("DATABASE_POOL_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://user:pass@localhost/db")
    clear_settings_cache()

    engine = create_db_engine("postgresql+psycopg://user:pass@localhost/db")
    try:
        assert engine.pool.size() == 5
        assert engine.pool._max_overflow == 5
        assert engine.pool._timeout == 30
    finally:
        engine.dispose()
        clear_settings_cache()


def test_engine_pool_uses_environment_overrides(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://user:pass@localhost/db")
    monkeypatch.setenv("DATABASE_POOL_SIZE", "3")
    monkeypatch.setenv("DATABASE_MAX_OVERFLOW", "4")
    monkeypatch.setenv("DATABASE_POOL_TIMEOUT_SECONDS", "12.5")
    clear_settings_cache()

    engine = create_db_engine("postgresql+psycopg://user:pass@localhost/db")
    try:
        assert engine.pool.size() == 3
        assert engine.pool._max_overflow == 4
        assert engine.pool._timeout == 12.5
    finally:
        engine.dispose()
        clear_settings_cache()
