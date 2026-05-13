import pytest

from nexus.db.engine import create_db_engine

pytestmark = pytest.mark.unit


def test_default_engine_pool_is_capped_for_small_production_poolers():
    engine = create_db_engine("postgresql+psycopg://user:pass@localhost/db")
    try:
        assert engine.pool.size() == 1
        assert engine.pool._max_overflow == 0
        assert engine.pool._timeout == 10
    finally:
        engine.dispose()
