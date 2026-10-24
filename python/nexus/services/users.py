"""Account profiles, people search and canonical account mutation serialization.

viewer locks precede admission, podcast, media and library locks. removal revisions
fence fresh acquisition; accepted workspace removal, unsubscribe and library
deletion advance them, including absence. acquisition and background sync do not.
"""

from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import User
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.user import (
    DISPLAY_NAME_MAX_LENGTH,
    UpdateProfileRequest,
    UserProfileOut,
    UserSearchOut,
)
from nexus.text import escape_like


def lock_viewer(db: Session, viewer_id: UUID) -> int:
    """Serialize account writers before admission, podcast, media and library locks.

    no-key-update permits the foreign-key key-share locks of concurrent publication.
    """
    revision = db.scalar(
        text("SELECT removal_revision FROM users WHERE id = :id FOR NO KEY UPDATE"),
        {"id": viewer_id},
    )
    if revision is None:
        # justify-defect: authenticated bootstrap guarantees the account row.
        raise AssertionError("authenticated user row is missing")
    return revision


def require_removal_revision(db: Session, viewer_id: UUID, expected: int) -> None:
    """Compare a frozen acquisition fence while the caller holds the viewer lock."""
    current = db.execute(
        text("SELECT removal_revision FROM users WHERE id = :id"), {"id": viewer_id}
    ).scalar_one()
    if current != expected:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Save needs review")


def advance_removal_revision(db: Session, viewer_id: UUID) -> int:
    """Publish accepted removal, including absence; caller holds the viewer lock."""
    return db.execute(
        text(
            "UPDATE users SET removal_revision = nextval('collection_order_revision_seq') "
            "WHERE id = :id RETURNING removal_revision"
        ),
        {"id": viewer_id},
    ).scalar_one()


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


def search_users(db: Session, query: str, viewer_id: UUID, limit: int) -> list[UserSearchOut]:
    """People to share with or invite: display names containing the query, or the one
    account whose email it is exactly. An email is returned only on that exact match,
    so a search never lists addresses. The viewer is left out."""
    query = query.strip()
    if len(query) < 3:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Search query must be at least 3 characters"
        )
    rows = db.execute(
        text("""
            SELECT id AS user_id, display_name,
                   CASE WHEN lower(email) = lower(:query) THEN email END AS email
            FROM users
            WHERE id <> :viewer_id
              AND (lower(email) = lower(:query) OR display_name ILIKE :contains ESCAPE '\\')
            ORDER BY (lower(email) = lower(:query)) IS TRUE DESC, lower(display_name), id
            LIMIT :limit
        """),
        {
            "query": query,
            "contains": f"%{escape_like(query)}%",
            "viewer_id": viewer_id,
            "limit": limit,
        },
    ).mappings()
    return [UserSearchOut(**row) for row in rows]
