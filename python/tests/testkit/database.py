"""Exact database boundary for runner-owned PostgreSQL clones."""

from __future__ import annotations

import re
from collections.abc import Mapping

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

_RUN_ID = re.compile(r"[0-9a-f]{16}\Z")


def require_test_database_url(environment: Mapping[str, str]) -> str:
    """Accept only the exact local database shape emitted by nexus-test."""
    raw = environment.get("DATABASE_URL", "")
    run_id = environment.get("NEXUS_TEST_RUN_ID", "")
    if environment.get("NEXUS_ENV") != "test" or not raw or _RUN_ID.fullmatch(run_id) is None:
        raise ValueError(
            "NEXUS_ENV=test, NEXUS_TEST_RUN_ID, and runner-provided DATABASE_URL are required"
        )
    try:
        url = make_url(raw)
    except ArgumentError as error:
        raise ValueError("DATABASE_URL is not a valid SQLAlchemy URL") from error
    if (
        url.drivername != "postgresql+psycopg"
        or url.host != "127.0.0.1"
        or url.port is None
        or url.username is not None
        or url.password is not None
        or url.database != f"nexus_run_{run_id}"
        or dict(url.query) != {"user": "postgres", "password": "postgres"}
    ):
        raise ValueError("DATABASE_URL is not the exact runner-owned local PostgreSQL clone")
    return raw


def require_test_migration_database_url(environment: Mapping[str, str]) -> str:
    """Accept only the empty migration database owned by the current test run."""
    raw = environment.get("NEXUS_MIGRATION_DATABASE_URL", "")
    run_id = environment.get("NEXUS_TEST_RUN_ID", "")
    if environment.get("NEXUS_ENV") != "test" or not raw or _RUN_ID.fullmatch(run_id) is None:
        raise ValueError(
            "NEXUS_ENV=test, NEXUS_TEST_RUN_ID, and runner-provided "
            "NEXUS_MIGRATION_DATABASE_URL are required"
        )
    try:
        url = make_url(raw)
    except ArgumentError as error:
        raise ValueError("NEXUS_MIGRATION_DATABASE_URL is not a valid SQLAlchemy URL") from error
    if (
        url.drivername != "postgresql+psycopg"
        or url.host != "127.0.0.1"
        or url.port is None
        or url.username is not None
        or url.password is not None
        or url.database != f"nexus_migration_{run_id}"
        or dict(url.query) != {"user": "postgres", "password": "postgres"}
    ):
        raise ValueError(
            "NEXUS_MIGRATION_DATABASE_URL is not the exact runner-owned local migration database"
        )
    return raw
