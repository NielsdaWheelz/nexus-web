"""User service layer.

User profile and search operations.
"""

import re
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.user import UserProfileOut, UserSearchOut


def get_user_profile(
    db: Session, user_id: UUID, default_library_id: UUID, email: str | None
) -> UserProfileOut:
    """Get user profile including display_name from DB.

    Email comes from the JWT (via Viewer) rather than DB to stay fresh.
    display_name is read from the DB.
    """
    row = db.execute(
        text("SELECT display_name FROM users WHERE id = :uid"),
        {"uid": user_id},
    ).fetchone()

    return UserProfileOut(
        user_id=user_id,
        default_library_id=default_library_id,
        email=email,
        display_name=row[0] if row else None,
    )


def update_display_name(db: Session, user_id: UUID, display_name: str | None) -> None:
    """Update a user's display_name.

    Args:
        db: Database session.
        user_id: The user's ID.
        display_name: New display name, or None to clear.

    Raises:
        InvalidRequestError: If display_name is empty string or too long.
    """
    if display_name is not None:
        display_name = display_name.strip()
        if not display_name:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Display name cannot be empty (use null to clear)",
            )

    with transaction(db):
        db.execute(
            text("UPDATE users SET display_name = :dn WHERE id = :uid"),
            {"dn": display_name, "uid": user_id},
        )


def search_users(db: Session, query: str, viewer_id: UUID, limit: int = 10) -> list[UserSearchOut]:
    """Search users by email prefix or display_name substring.

    Args:
        db: Database session.
        query: Search query (minimum 3 characters).
        viewer_id: Current user's ID (excluded from results).
        limit: Maximum results (capped at 20).

    Returns:
        List of matching users.

    Raises:
        InvalidRequestError: If query is too short.
    """
    if len(query) < 3:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Search query must be at least 3 characters",
        )

    limit = min(limit, 20)

    # Escape LIKE special characters
    escaped = re.sub(r"([%_\\])", r"\\\1", query)

    result = db.execute(
        text("""
            SELECT id, email, display_name
            FROM users
            WHERE id != :viewer_id
              AND (
                email ILIKE :prefix_pattern
                OR display_name ILIKE :contains_pattern
              )
            ORDER BY
              CASE WHEN email ILIKE :prefix_pattern THEN 0 ELSE 1 END,
              email ASC NULLS LAST
            LIMIT :limit
        """),
        {
            "viewer_id": viewer_id,
            "prefix_pattern": f"{escaped}%",
            "contains_pattern": f"%{escaped}%",
            "limit": limit,
        },
    )

    return [
        UserSearchOut(user_id=row[0], email=row[1], display_name=row[2])
        for row in result.fetchall()
    ]
