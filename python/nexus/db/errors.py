"""Helpers for interpreting database driver errors."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError, OperationalError


def integrity_constraint_name(exc: IntegrityError) -> str | None:
    """Name of the constraint a failed write violated, when the driver reports it.

    psycopg surfaces the violated constraint on ``exc.orig.diag.constraint_name``.
    Callers that must also recognise a constraint from the error text (when the
    driver does not populate ``diag``) keep that fallback at their own call site.
    """
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    name = getattr(diag, "constraint_name", None)
    return str(name) if name else None


def is_serialization_failure(exc: OperationalError) -> bool:
    sqlstate = getattr(exc.orig, "sqlstate", None)
    return sqlstate == "40001" or "could not serialize access" in str(exc.orig).lower()
