"""Bounded SERIALIZABLE retry: the one owner of the serialization-failure loop."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.db.errors import is_serialization_failure
from nexus.db.session import use_serializable_if_available


def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run ``op`` under SERIALIZABLE isolation, retrying on serialization failure.

    Each attempt sets SERIALIZABLE (when no transaction is open) and runs ``op``;
    a serialization failure rolls back and retries, up to ``retries`` total
    attempts, then re-raises. Any other ``OperationalError`` rolls back and
    re-raises immediately. ``op`` must reload its working rows and commit on each
    call so a retry sees fresh state. Per concurrency.md there is no explicit row
    locking on top of SERIALIZABLE.
    """
    for attempt in range(retries):
        use_serializable_if_available(db)
        try:
            return op()
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == retries - 1:
                raise
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError(f"{label} retry loop exhausted")
