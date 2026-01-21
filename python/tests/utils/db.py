"""Test utilities for database isolation.

Provides fixtures for running tests in nested transactions (savepoints)
that are rolled back after each test, ensuring test isolation without
requiring full database resets.
"""

from typing import Any

from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session


class DirectSessionManager:
    """Manager for tests that need direct DB access without savepoint isolation.

    Use this when a test requires multiple independent connections that must
    see each other's committed data (e.g., testing race conditions,
    connection pooling, or partial state recovery).

    WARNING: Tests using this do NOT auto-rollback. They must register
    cleanup data or manually clean up.

    Usage:
        def test_something(self, direct_db: DirectSessionManager):
            # Register cleanup upfront (deleted in reverse order)
            direct_db.register_cleanup("child_table", "parent_id", some_id)
            direct_db.register_cleanup("parent_table", "id", some_id)

            # Create data with committed transactions
            with direct_db.session() as s:
                s.execute(...)
                s.commit()

            # Verify with separate connection
            with direct_db.session() as s:
                result = s.execute(...)
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._cleanup_items: list[tuple[str, str, Any]] = []

    def session(self) -> Session:
        """Create a new independent session.

        Caller is responsible for committing/closing.
        """
        return Session(self.engine)

    def register_cleanup(self, table: str, column: str, value: Any) -> None:
        """Register data to be cleaned up after test.

        Items are deleted in reverse order of registration (LIFO),
        so register parent tables before child tables.

        Args:
            table: Table name to delete from.
            column: Column name to match.
            value: Value to match for deletion.
        """
        self._cleanup_items.append((table, column, value))

    def cleanup(self) -> None:
        """Delete all registered test data in reverse order."""
        if not self._cleanup_items:
            return

        with Session(self.engine) as session:
            for table, column, value in reversed(self._cleanup_items):
                session.execute(
                    text(f"DELETE FROM {table} WHERE {column} = :value"),
                    {"value": value},
                )
            session.commit()
        self._cleanup_items.clear()


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
