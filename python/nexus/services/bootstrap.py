"""User and default library bootstrap service.

Provides race-safe user and default library creation on first login.
"""

import logging
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.session import transaction

logger = logging.getLogger(__name__)

# Default library name (not user-editable in v1)
DEFAULT_LIBRARY_NAME = "My Library"


def ensure_user_and_default_library(db: Session, user_id: UUID) -> UUID:
    """Ensure user exists, default library exists, and owner membership exists.

    This function is race-safe and idempotent:
    - Concurrent calls converge to correct state
    - Uses INSERT ON CONFLICT DO NOTHING for idempotent inserts
    - Recovers from partial failures (e.g., library exists but membership missing)

    Args:
        db: Database session.
        user_id: The user's ID (from JWT sub claim).

    Returns:
        The default library ID.

    Raises:
        Exception: If bootstrap fails after all recovery attempts.
    """
    with transaction(db):
        # Step 1: Ensure user exists
        db.execute(
            text("""
                INSERT INTO users (id)
                VALUES (:user_id)
                ON CONFLICT (id) DO NOTHING
            """),
            {"user_id": user_id},
        )

        # Step 2: Check if default library already exists
        result = db.execute(
            text("""
                SELECT id FROM libraries
                WHERE owner_user_id = :user_id AND is_default = true
            """),
            {"user_id": user_id},
        )
        row = result.fetchone()
        default_library_id = row[0] if row else None

        # Step 3: If no default library, create one (catch race)
        if default_library_id is None:
            try:
                result = db.execute(
                    text("""
                        INSERT INTO libraries (name, owner_user_id, is_default)
                        VALUES (:name, :user_id, true)
                        RETURNING id
                    """),
                    {"name": DEFAULT_LIBRARY_NAME, "user_id": user_id},
                )
                row = result.fetchone()
                default_library_id = row[0]
                logger.info("Created default library %s for user %s", default_library_id, user_id)
            except IntegrityError:
                # Lost race: another request created it; fetch the existing one
                db.rollback()  # Rollback the failed insert

                # Re-query for the default library
                result = db.execute(
                    text("""
                        SELECT id FROM libraries
                        WHERE owner_user_id = :user_id AND is_default = true
                    """),
                    {"user_id": user_id},
                )
                row = result.fetchone()
                default_library_id = row[0] if row else None

                if default_library_id is None:
                    # This should not happen - log and raise
                    logger.error(
                        "Failed to find default library after race recovery for user %s", user_id
                    )
                    raise RuntimeError(
                        f"Failed to bootstrap default library for user {user_id}"
                    ) from None

                logger.info(
                    "Found existing default library %s for user %s after race",
                    default_library_id,
                    user_id,
                )

        # Step 4: Ensure owner membership exists (idempotent)
        # Handles edge case: library exists but membership doesn't (partial failure recovery)
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
                ON CONFLICT (library_id, user_id) DO NOTHING
            """),
            {"library_id": default_library_id, "user_id": user_id},
        )

    return default_library_id


def create_bootstrap_callback(db: Session):
    """Create a bootstrap callback function that captures the database session.

    This is used to wire up the auth middleware with the bootstrap service.

    Args:
        db: Database session.

    Returns:
        A callback function that takes user_id and returns default_library_id.
    """

    def callback(user_id: UUID) -> UUID:
        return ensure_user_and_default_library(db, user_id)

    return callback
