"""Pytest configuration and fixtures for Nexus tests.

Test isolation strategy:
- Tests that use db_session get a nested transaction (savepoint) that rolls back
- Migration tests run in a separate database (nexus_test_migrations)
- Tests needing multiple connections use direct_db fixture
- Auth tests use authenticated_client with test JWT tokens

Environment Setup:
- Test environment variables are configured BEFORE any application imports
- This ensures Settings validation passes without requiring external configuration
- Tests use mock verifiers for JWT validation, not real Supabase endpoints
"""

import os
import sys
from collections.abc import Generator
from pathlib import Path
from uuid import UUID, uuid4

# Configure test environment BEFORE any imports that load Settings.
# These values are placeholders - tests use MockJwtVerifier, not real JWKS.
if not os.environ.get("NEXUS_ENV"):
    os.environ["NEXUS_ENV"] = "test"
if not os.environ.get("SUPABASE_JWKS_URL"):
    os.environ["SUPABASE_JWKS_URL"] = "http://localhost:54321/auth/v1/.well-known/jwks.json"
if not os.environ.get("SUPABASE_ISSUER"):
    os.environ["SUPABASE_ISSUER"] = "http://localhost:54321/auth/v1"
if not os.environ.get("SUPABASE_AUDIENCES"):
    os.environ["SUPABASE_AUDIENCES"] = "authenticated"
# Podcast env must be unconditionally set for tests — .env may contain
# PODCASTS_ENABLED=false which Make loads before pytest starts.
os.environ["PODCASTS_ENABLED"] = "true"
os.environ.setdefault("PODCAST_INDEX_API_KEY", "test-podcast-index-key")
os.environ.setdefault("PODCAST_INDEX_API_SECRET", "test-podcast-index-secret")

# Add repo root to sys.path for importing top-level packages (e.g., apps)
_repo_root = Path(__file__).parent.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.config import clear_settings_cache
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
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


@pytest.fixture(scope="session")
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
def db_session(engine: Engine, verify_schema_exists: None) -> Generator[Session, None, None]:
    """Provide a database session with savepoint isolation.

    Each test gets a fresh session that is rolled back after the test,
    ensuring no data persists between tests.

    Note: Do not use this fixture for tests that need multiple independent
    connections. Use direct_db instead.
    """
    with TestDatabaseManager(engine) as session:
        yield session


@pytest.fixture
def direct_db(
    engine: Engine, verify_schema_exists: None
) -> Generator[DirectSessionManager, None, None]:
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
def test_verifier() -> MockJwtVerifier:
    """Provide a test token verifier."""
    return MockJwtVerifier()


@pytest.fixture
def authenticated_app(engine: Engine, verify_schema_exists: None):
    """Provide a FastAPI app with auth + request-id middleware using test verifier.

    Uses the test database engine for bootstrap operations.
    Includes request-id middleware for consistent middleware stack.
    """
    # Create session factory bound to test engine
    session_factory = create_session_factory(engine)

    # Create bootstrap callback that uses the test session factory
    def bootstrap_callback(user_id: UUID, email: str | None = None) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id, email=email)
        finally:
            db.close()

    # Create app with test verifier and custom bootstrap
    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    # Override get_db so route handlers use the test engine
    from nexus.api.deps import get_db

    def _test_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _test_get_db

    # Manually add auth middleware with our test configuration
    from nexus.auth.middleware import AuthMiddleware

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    # Add request-id middleware (outermost — runs first)
    from nexus.app import add_request_id_middleware

    add_request_id_middleware(app, log_requests=False)

    return app


@pytest.fixture
def authenticated_client(
    authenticated_app, db_session: Session
) -> Generator[TestClient, None, None]:
    """Provide a FastAPI test client with auth middleware and savepoint isolation.

    Uses db_session for savepoint-based transaction rollback after each test.
    Prefer this for tests that don't need multiple independent connections.

    For tests using direct_db (multi-connection, manual cleanup), use auth_client instead.
    """
    with TestClient(authenticated_app) as client:
        yield client


@pytest.fixture
def test_user_id() -> UUID:
    """Generate a random UUID for a test user."""
    return create_test_user_id()


@pytest.fixture
def bootstrapped_user(db_session: Session) -> UUID:
    """Create a test user with default library, ready for service-layer tests.

    Use this fixture when tests call service functions directly (not via API).
    The user and their default library are created in the database.

    For API-based tests, use e2e_client or authenticated_client instead,
    which bootstrap users automatically via AuthMiddleware.
    """
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    return user_id


@pytest.fixture
def random_uuid() -> str:
    """Generate a random UUID string for test data."""
    return str(uuid4())


@pytest.fixture
def auth_client(engine: Engine, verify_schema_exists: None) -> Generator[TestClient, None, None]:
    """Provide a FastAPI test client with auth + request-id middleware.

    No savepoint isolation — tests using this fixture must register manual cleanup
    via direct_db.register_cleanup(). Use for integration tests that need multiple
    independent connections (direct_db).

    For tests using db_session (auto-rollback), use authenticated_client instead.
    """
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID, email: str | None = None) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id, email=email)
        finally:
            db.close()

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    # Override get_db so route handlers use the test engine
    from nexus.api.deps import get_db

    def _test_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _test_get_db

    from nexus.auth.middleware import AuthMiddleware

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    # Add request-id middleware (outermost — runs first)
    from nexus.app import add_request_id_middleware

    add_request_id_middleware(app, log_requests=False)

    with TestClient(app) as client:
        yield client


@pytest.fixture(autouse=True)
def reset_settings_cache():
    """Reset the settings cache before each test."""
    clear_settings_cache()
    yield
    clear_settings_cache()
