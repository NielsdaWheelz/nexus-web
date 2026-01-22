"""Pytest configuration and fixtures for Nexus tests.

Test isolation strategy:
- Tests that use db_session get a nested transaction (savepoint) that rolls back
- Migration tests run in a separate database (nexus_test_migrations)
- Tests needing multiple connections use direct_db fixture
- Auth tests use authenticated_client with test JWT tokens
"""

import os
import sys
from collections.abc import Generator
from pathlib import Path
from uuid import UUID, uuid4

# Add repo root to sys.path for importing top-level packages (e.g., apps)
_repo_root = Path(__file__).parent.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.verifier import MockTokenVerifier
from nexus.config import clear_settings_cache
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager, TestDatabaseManager


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


@pytest.fixture(scope="session", autouse=True)
def verify_schema_exists(engine: Engine) -> Generator[None, None, None]:
    """Verify database schema exists before running tests.

    Fails fast with helpful message if migrations haven't been run.
    This is a safety check, not a substitute for running migrations.
    """
    with engine.connect() as conn:
        result = conn.execute(
            text(
                "SELECT EXISTS ("
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'users'"
                ")"
            )
        )
        schema_exists = result.scalar()

    if not schema_exists:
        pytest.fail(
            "Database schema not found. Run migrations first:\n"
            "  make migrate-test\n"
            "Or run full setup:\n"
            "  make setup"
        )

    yield


@pytest.fixture
def db_session(engine: Engine) -> Generator[Session, None, None]:
    """Provide a database session with savepoint isolation.

    Each test gets a fresh session that is rolled back after the test,
    ensuring no data persists between tests.

    Note: Do not use this fixture for tests that need multiple independent
    connections. Use direct_db instead.
    """
    with TestDatabaseManager(engine) as session:
        yield session


@pytest.fixture
def direct_db(engine: Engine) -> Generator[DirectSessionManager, None, None]:
    """Provide direct database access without savepoint isolation.

    Use for tests that require multiple independent connections that must
    see each other's committed data (e.g., testing race conditions,
    partial state recovery, or connection pooling).

    Data registered via register_cleanup() is automatically deleted after
    the test in reverse order.

    Example:
        def test_something(self, direct_db):
            user_id = uuid4()
            direct_db.register_cleanup("users", "id", user_id)

            with direct_db.session() as s:
                s.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                s.commit()
    """
    manager = DirectSessionManager(engine)
    yield manager
    manager.cleanup()


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    """Provide a FastAPI test client without authentication.

    This client does not have auth middleware, suitable for testing
    public endpoints and basic functionality.
    """
    # Create app without auth middleware for basic tests
    app = create_app(skip_auth_middleware=True)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def test_verifier() -> MockTokenVerifier:
    """Provide a test token verifier."""
    return MockTokenVerifier()


@pytest.fixture
def authenticated_app(engine: Engine):
    """Provide a FastAPI app with auth middleware using test verifier.

    Uses the test database engine for bootstrap operations.
    """
    # Create session factory bound to test engine
    session_factory = create_session_factory(engine)

    # Create bootstrap callback that uses the test session factory
    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    # Create app with test verifier and custom bootstrap
    verifier = MockTokenVerifier()
    app = create_app(skip_auth_middleware=True)

    # Manually add auth middleware with our test configuration
    from nexus.auth.middleware import AuthMiddleware

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    return app


@pytest.fixture
def authenticated_client(
    authenticated_app, db_session: Session
) -> Generator[TestClient, None, None]:
    """Provide a FastAPI test client with auth middleware.

    This client uses MockTokenVerifier and can handle authenticated requests.
    Use auth_headers() to generate valid tokens for requests.
    """
    with TestClient(authenticated_app) as client:
        yield client


@pytest.fixture
def test_user_id() -> UUID:
    """Generate a random UUID for a test user."""
    return create_test_user_id()


@pytest.fixture
def random_uuid() -> str:
    """Generate a random UUID string for test data."""
    return str(uuid4())


@pytest.fixture(autouse=True)
def reset_settings_cache():
    """Reset the settings cache before each test."""
    clear_settings_cache()
    yield
    clear_settings_cache()
