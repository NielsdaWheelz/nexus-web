"""User service layer.

User profile and search operations.
"""

import re
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import User
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import presence_from_nullable
from nexus.schemas.user import (
    DISPLAY_NAME_MAX_LENGTH,
    UpdateProfileRequest,
    UserProfileOut,
    UserSearchOut,
)
from nexus.services.sealed_handles import seal_user


def get_user_profile(
    db: Session, user_id: UUID, default_library_id: UUID, email: str | None
) -> UserProfileOut:
    """Get user profile including display_name from DB.

    Email comes from the JWT (via Viewer) rather than DB to stay fresh.
    display_name is read from the DB.
    """
    row = db.execute(
        text("SELECT display_name, calendar_time_zone FROM users WHERE id = :uid"),
        {"uid": user_id},
    ).fetchone()
    if row is None:
        # justify-defect: authenticated bootstrap guarantees the viewer's User row.
        raise AssertionError("authenticated user profile row is missing")

    return UserProfileOut(
        user_id=user_id,
        default_library_id=default_library_id,
        email=email,
        display_name=row.display_name,
        calendar_time_zone=row.calendar_time_zone,
    )


def update_user_profile(db: Session, user_id: UUID, request: UpdateProfileRequest) -> None:
    """Apply one atomic mutation to the supplied profile fields."""
    display_name = request.display_name
    if "display_name" in request.model_fields_set and display_name is not None:
        display_name = display_name.strip()
        if not display_name:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Display name cannot be empty (use null to clear)",
            )
        if len(display_name) > DISPLAY_NAME_MAX_LENGTH:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"Display name cannot exceed {DISPLAY_NAME_MAX_LENGTH} characters",
            )
    with transaction(db):
        user = db.get(User, user_id)
        if user is None:
            # justify-defect: authenticated bootstrap guarantees the viewer's User row.
            raise AssertionError("authenticated user profile row is missing")
        if "display_name" in request.model_fields_set:
            user.display_name = display_name
        if "calendar_time_zone" in request.model_fields_set:
            if request.calendar_time_zone is None:
                # justify-defect: UpdateProfileRequest rejects supplied null and
                # this branch only runs when the field was supplied.
                raise AssertionError("validated calendar timezone is missing")
            user.calendar_time_zone = request.calendar_time_zone


def calendar_local_date(db: Session, user_id: UUID) -> date:
    """Resolve one account-local date from the profile's canonical IANA zone."""
    time_zone = db.scalar(select(User.calendar_time_zone).where(User.id == user_id))
    if time_zone is None:
        # justify-defect: authenticated bootstrap guarantees a non-null profile zone.
        raise AssertionError("authenticated user calendar timezone is missing")
    return datetime.now(ZoneInfo(time_zone)).date()


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
        UserSearchOut(
            user_handle=seal_user(row[0]),
            email=presence_from_nullable(row[1]),
            display_name=presence_from_nullable(row[2]),
        )
        for row in result.fetchall()
    ]
