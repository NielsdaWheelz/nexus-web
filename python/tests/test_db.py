"""Database smoke tests.

Verifies that basic database connectivity works.
"""

from sqlalchemy import text
from sqlalchemy.orm import Session


class TestDatabaseConnectivity:
    """Tests for basic database operations."""

    def test_session_opens_and_executes_query(self, db_session: Session):
        """Database session can execute a simple query."""
        result = db_session.execute(text("SELECT 1 AS value"))
        row = result.fetchone()

        assert row is not None
        assert row[0] == 1

    def test_session_closes_cleanly(self, db_session: Session):
        """Session closes without error after use."""
        db_session.execute(text("SELECT 1"))
        # db_session fixture handles cleanup - test passes if no exception

    def test_session_can_query_information_schema(self, db_session: Session):
        """Session can query PostgreSQL system tables."""
        result = db_session.execute(text("SELECT current_database()"))
        db_name = result.scalar()

        assert db_name is not None
        assert isinstance(db_name, str)
