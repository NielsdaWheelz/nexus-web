"""Test utilities for database isolation.

Provides fixtures for running tests in nested transactions (savepoints)
that are rolled back after each test, ensuring test isolation without
requiring full database resets.
"""

from typing import Any

from sqlalchemy import Connection, Engine
from sqlalchemy.orm import Session


class TestDatabaseManager:
    """Manager for test database sessions with savepoint isolation.

    Usage in conftest.py:
        @pytest.fixture
        def db_session(engine):
            manager = TestDatabaseManager(engine)
            with manager.session() as session:
                yield session
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._connection: Connection | None = None
        self._session: Session | None = None

    def __enter__(self) -> Session:
        """Start a test session with savepoint."""
        self._connection = self.engine.connect()
        self._connection.begin()

        self._session = Session(
            bind=self._connection,
            join_transaction_mode="create_savepoint",
        )
        return self._session

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Roll back and clean up the test session."""
        if self._session:
            self._session.close()
        if self._connection:
            self._connection.rollback()
            self._connection.close()

    def session(self) -> "TestDatabaseManager":
        """Return self for use as context manager."""
        return self
