"""Owned-database isolation for migration proof."""

from __future__ import annotations

import os
from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, text

from tests.testkit.database import require_test_migration_database_url


@pytest.fixture
def empty_migration_database_url() -> Generator[str, None, None]:
    """Reset only the controller-owned migration database before one proof."""
    database_url = require_test_migration_database_url(os.environ)
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA public CASCADE"))
            connection.execute(text("CREATE SCHEMA public"))
    finally:
        engine.dispose()

    previous_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = database_url
    try:
        yield database_url
    finally:
        if previous_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_url
