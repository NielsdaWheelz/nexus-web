"""Shared fixtures for real Nexus Python proof."""

from __future__ import annotations

import os
import sys
from collections.abc import Generator
from pathlib import Path
from uuid import UUID, uuid4

_REPO_ROOT = Path(__file__).parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Spawned Python proof inherits the same network boundary through sitecustomize.
_TESTKIT_PATH = Path(__file__).parent / "testkit"
os.environ["NEXUS_TEST_DENY_EXTERNAL_NETWORK"] = "1"
os.environ["PYTHONPATH"] = os.pathsep.join(
    (
        str(_TESTKIT_PATH),
        *(part for part in os.environ.get("PYTHONPATH", "").split(os.pathsep) if part),
    )
)

from tests.testkit.network import install_network_guard

_restore_collection_network = install_network_guard()

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from tests.testkit.auth import StaticTokenVerifier, UserRecord
from tests.testkit.database import require_test_database_url


@pytest.fixture(autouse=True)
def deny_external_network(
    request: pytest.FixtureRequest, pytestconfig: pytest.Config
) -> Generator[None, None, None]:
    """Allow external sockets only for an explicitly enabled hosted proof."""
    global _restore_collection_network
    hosted = Path(request.node.path).is_relative_to(Path(pytestconfig.rootpath) / "tests/hosted")
    force_enabled = bool(pytestconfig.getoption("force_enable_socket"))
    if force_enabled:
        if not hosted:
            pytest.fail("--force-enable-socket is restricted to tests/hosted")
        inherited = os.environ.pop("NEXUS_TEST_DENY_EXTERNAL_NETWORK", None)
        _restore_collection_network()
        yield
        _restore_collection_network = install_network_guard()
        if inherited is not None:
            os.environ["NEXUS_TEST_DENY_EXTERNAL_NETWORK"] = inherited
        return
    if hosted:
        pytest.fail("tests/hosted requires the explicit --force-enable-socket capability")

    restore = install_network_guard()
    yield
    restore()


@pytest.fixture(scope="session")
def engine() -> Generator[Engine, None, None]:
    database = create_engine(require_test_database_url(os.environ), pool_pre_ping=True)
    yield database
    database.dispose()


@pytest.fixture
def db_session(engine: Engine) -> Generator[Session, None, None]:
    """Contain service commits inside one outer transaction."""
    connection = engine.connect()
    outer_transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer_transaction.rollback()
        connection.close()


@pytest.fixture
def test_user(db_session: Session) -> UserRecord:
    from nexus.services.bootstrap import ensure_user_and_default_library

    user_id = uuid4()
    email = f"nexus-test-{user_id}@example.invalid"
    return UserRecord(
        id=user_id,
        email=email,
        default_library_id=ensure_user_and_default_library(db_session, user_id, email),
    )


@pytest.fixture
def nexus_app(db_session: Session, test_user: UserRecord) -> FastAPI:
    """Build the real FastAPI stack with only external token verification controlled."""
    from nexus.app import add_request_id_middleware, create_app
    from nexus.auth.middleware import AuthMiddleware
    from nexus.db.session import get_db, get_repeatable_read_db
    from nexus.services.bootstrap import ensure_user_and_default_library

    verifier = StaticTokenVerifier(test_user.id, test_user.email)

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        return ensure_user_and_default_library(db_session, user_id, email)

    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=bootstrap,
        )
    )
    add_request_id_middleware(app, log_requests=False)

    def session() -> Generator[Session, None, None]:
        yield db_session

    app.dependency_overrides[get_db] = session
    # Fixture rows live in one uncommitted outer transaction, so a request cannot
    # open its own read-only snapshot connection and still see them. Snapshot
    # routes read through the same session; route, service, and SQL stay real.
    # What this deliberately does NOT prove: the per-request REPEATABLE READ,
    # READ ONLY transaction itself. Every snapshot route runs one SELECT, which
    # is atomic at any isolation level, so nothing observable is lost today. A
    # route that grows a second statement, or one whose read-only guarantee
    # becomes load-bearing, needs a process-level proof against the run database
    # rather than a wider fixture.
    app.dependency_overrides[get_repeatable_read_db] = session
    return app


@pytest.fixture
def authenticated_client(
    nexus_app: FastAPI, test_user: UserRecord
) -> Generator[TestClient, None, None]:
    """Run an authenticated request through the real FastAPI stack."""
    verifier = StaticTokenVerifier(test_user.id, test_user.email)
    with TestClient(
        nexus_app,
        headers={"Authorization": f"Bearer {verifier.token}"},
    ) as client:
        yield client


@pytest.fixture
def anonymous_client(nexus_app: FastAPI) -> Generator[TestClient, None, None]:
    """Run an anonymous request through the real FastAPI stack."""
    with TestClient(nexus_app) as client:
        yield client
