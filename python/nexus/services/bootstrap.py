"""User and default library bootstrap service.

Provides race-safe user and default library creation on first login.
"""

import logging
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from nexus.db.errors import is_serialization_failure
from nexus.db.session import transaction, use_serializable_if_available

logger = logging.getLogger(__name__)

# Default library name is not user-editable.
DEFAULT_LIBRARY_NAME = "My Library"


def ensure_user_and_default_library(db: Session, user_id: UUID, email: str | None = None) -> UUID:
    """Ensure user exists, default library exists, and owner membership exists.

    This function is race-safe and idempotent. Concurrent callers converge
    through SERIALIZABLE retry or unique-constraint recovery.
    """
    for attempt in range(3):
        use_serializable_if_available(db)
        try:
            return _ensure_user_and_default_library_once(db, user_id, email)
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == 2:
                raise
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise
    raise AssertionError("default library bootstrap retry loop exhausted")


def _ensure_user_and_default_library_once(db: Session, user_id: UUID, email: str | None) -> UUID:
    with transaction(db):
        _ensure_user(db, user_id, email)
        default_library_id = _get_default_library_id(db, user_id)
        if default_library_id is None:
            default_library_id = _create_default_library(db, user_id)
        _ensure_default_library_membership(db, default_library_id, user_id)

    return default_library_id


def _ensure_user(db: Session, user_id: UUID, email: str | None) -> None:
    current = db.execute(
        text("SELECT email FROM users WHERE id = :user_id"),
        {"user_id": user_id},
    ).fetchone()
    if current is None:
        db.execute(
            text("INSERT INTO users (id, email) VALUES (:user_id, :email)"),
            {"user_id": user_id, "email": email},
        )
        return
    if email is not None and current[0] != email:
        db.execute(
            text("UPDATE users SET email = :email WHERE id = :user_id"),
            {"user_id": user_id, "email": email},
        )


def _get_default_library_id(db: Session, user_id: UUID) -> UUID | None:
    row = db.execute(
        text("""
            SELECT id FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
        """),
        {"user_id": user_id},
    ).fetchone()
    return row[0] if row else None


def _create_default_library(db: Session, user_id: UUID) -> UUID:
    row = db.execute(
        text("""
            INSERT INTO libraries (name, owner_user_id, is_default)
            VALUES (:name, :user_id, true)
            RETURNING id
        """),
        {"name": DEFAULT_LIBRARY_NAME, "user_id": user_id},
    ).fetchone()
    if row is None:
        raise AssertionError(
            "default library insert returned no id"
        )  # justify-service-invariant-check: INSERT RETURNING id must return one row.
    logger.info("Created default library %s for user %s", row[0], user_id)
    return row[0]


def _ensure_default_library_membership(
    db: Session, default_library_id: UUID, user_id: UUID
) -> None:
    row = db.execute(
        text("""
            SELECT role FROM memberships
            WHERE library_id = :library_id AND user_id = :user_id
        """),
        {"library_id": default_library_id, "user_id": user_id},
    ).fetchone()
    if row is None:
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": default_library_id, "user_id": user_id},
        )
    elif row[0] != "admin":
        db.execute(
            text("""
                UPDATE memberships
                SET role = 'admin'
                WHERE library_id = :library_id AND user_id = :user_id
            """),
            {"library_id": default_library_id, "user_id": user_id},
        )
