import pytest

from nexus.db.engine import create_db_engine

pytestmark = pytest.mark.unit


def test_default_engine_pool_handles_browser_api_concurrency():
    engine = create_db_engine("postgresql+psycopg://user:pass@localhost/db")
    try:
        assert engine.pool.size() == 10
        assert engine.pool._max_overflow == 10
        assert engine.pool._timeout == 30.0
    finally:
        engine.dispose()


def test_engine_pool_can_be_capped_for_managed_poolers():
    engine = create_db_engine(
        "postgresql+psycopg://user:pass@localhost/db",
        pool_size=2,
        max_overflow=0,
        pool_timeout_seconds=10,
    )
    try:
        assert engine.pool.size() == 2
        assert engine.pool._max_overflow == 0
        assert engine.pool._timeout == 10
    finally:
        engine.dispose()
