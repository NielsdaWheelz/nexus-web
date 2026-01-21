"""Pytest configuration and fixtures for Nexus tests.

Test isolation strategy:
- Tests that use db_session get a nested transaction (savepoint) that rolls back
- Migration tests run separately and manage their own database state
"""

import os
from collections.abc import Generator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from nexus.app import app
from tests.utils.db import TestDatabaseManager


def get_test_database_url() -> str:
    """Get the test database URL from environment.

    Raises:
        ValueError: If DATABASE_URL is not set.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.fail(
            "DATABASE_URL environment variable must be set for tests. "
            "Example: DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test"
        )
    return url


@pytest.fixture(scope="session")
def engine() -> Generator[Engine, None, None]:
    """Create a database engine for the test session.

    This engine is shared across all tests in the session.
    """
    database_url = get_test_database_url()
    engine = create_engine(database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(engine: Engine) -> Generator[Session, None, None]:
    """Provide a database session with savepoint isolation.

    Each test gets a fresh session that is rolled back after the test,
    ensuring no data persists between tests.

    Note: Do not use this fixture for migration tests.
    """
    with TestDatabaseManager(engine) as session:
        yield session


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    """Provide a FastAPI test client."""
    with TestClient(app) as client:
        yield client


@pytest.fixture
def random_uuid() -> str:
    """Generate a random UUID string for test data."""
    return str(uuid4())
