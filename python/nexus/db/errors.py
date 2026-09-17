"""Helpers for interpreting database driver errors."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError, OperationalError


class TransactionRestart(Exception):
    """Internal signal that a transaction must restart against fresh state."""


class DatabaseRetryExhaustedError(RuntimeError):
    """Defect raised when a bounded database transaction retry exhausts."""

    def __init__(self, label: str, attempts: int) -> None:
        super().__init__(f"{label} exhausted after {attempts} transaction attempts")


def integrity_constraint_name(exc: IntegrityError) -> str | None:
    """Name of the constraint a failed write violated.

    psycopg surfaces it on ``exc.orig.diag.constraint_name`` for every server-side
    integrity violation.
    """
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    name = getattr(diag, "constraint_name", None)
    return str(name) if name else None


def is_retryable_transaction_conflict(exc: OperationalError) -> bool:
    """True for serialization_failure and deadlock_detected."""
    return getattr(exc.orig, "sqlstate", None) in {"40001", "40P01"}
