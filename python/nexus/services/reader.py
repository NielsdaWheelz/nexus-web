"""Reader profile and per-media state service layer."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Fragment, ReaderMediaState, ReaderProfile
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.reader import (
    ReaderMediaStateOut,
    ReaderMediaStatePut,
    ReaderProfileOut,
    ReaderProfilePatch,
)

DEFAULT_THEME = "light"
DEFAULT_FONT_SIZE_PX = 16
DEFAULT_LINE_HEIGHT = 1.5
DEFAULT_FONT_FAMILY = "serif"
DEFAULT_COLUMN_WIDTH_CH = 65
DEFAULT_FOCUS_MODE = False


def get_reader_profile(db: Session, user_id: UUID) -> ReaderProfileOut:
    """Get reader profile for user, or defaults if none exists."""
    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
    if profile:
        return ReaderProfileOut.model_validate(profile)
    return ReaderProfileOut(
        theme=DEFAULT_THEME,
        font_size_px=DEFAULT_FONT_SIZE_PX,
        line_height=DEFAULT_LINE_HEIGHT,
        font_family=DEFAULT_FONT_FAMILY,
        column_width_ch=DEFAULT_COLUMN_WIDTH_CH,
        focus_mode=DEFAULT_FOCUS_MODE,
        updated_at=datetime.now(UTC),
    )


def patch_reader_profile(db: Session, user_id: UUID, patch: ReaderProfilePatch) -> ReaderProfileOut:
    """Update reader profile (upsert)."""
    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
    if not profile:
        profile = ReaderProfile(user_id=user_id)
        db.add(profile)
        db.flush()

    if patch.theme is not None:
        profile.theme = patch.theme
    if patch.font_size_px is not None:
        profile.font_size_px = patch.font_size_px
    if patch.line_height is not None:
        profile.line_height = patch.line_height
    if patch.font_family is not None:
        profile.font_family = patch.font_family
    if patch.column_width_ch is not None:
        profile.column_width_ch = patch.column_width_ch
    if patch.focus_mode is not None:
        profile.focus_mode = patch.focus_mode

    db.commit()
    db.refresh(profile)
    return ReaderProfileOut.model_validate(profile)


def get_reader_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderMediaStateOut:
    """Get per-media reader state."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    state = (
        db.query(ReaderMediaState)
        .filter(
            ReaderMediaState.user_id == viewer_id,
            ReaderMediaState.media_id == media_id,
        )
        .first()
    )

    if not state:
        return ReaderMediaStateOut(media_id=media_id, locator=None)

    return ReaderMediaStateOut.model_validate(state)


def put_reader_media_state(
    db: Session, viewer_id: UUID, media_id: UUID, body: ReaderMediaStatePut
) -> ReaderMediaStateOut:
    """Replace per-media reader state (upsert)."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if body.locator is not None and body.locator.type == "fragment_offset":
        if body.locator.fragment_id is not None:
            fragment_exists = (
                db.query(Fragment.id)
                .filter(
                    Fragment.id == body.locator.fragment_id,
                    Fragment.media_id == media_id,
                )
                .first()
            )
            if not fragment_exists:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "fragment_id must reference a fragment on this media",
                )

    current_time = datetime.now(UTC)
    locator_payload = None
    if body.locator is not None:
        locator_payload = body.locator.model_dump(mode="json", exclude_none=True)

    row = (
        db.execute(
            pg_insert(ReaderMediaState)
            .values(
                user_id=viewer_id,
                media_id=media_id,
                locator=locator_payload,
                created_at=current_time,
                updated_at=current_time,
            )
            .on_conflict_do_update(
                index_elements=[ReaderMediaState.user_id, ReaderMediaState.media_id],
                set_={
                    ReaderMediaState.locator.key: locator_payload,
                    ReaderMediaState.updated_at.key: current_time,
                },
            )
            .returning(
                ReaderMediaState.id,
                ReaderMediaState.media_id,
                ReaderMediaState.locator,
                ReaderMediaState.created_at,
                ReaderMediaState.updated_at,
            )
        )
        .mappings()
        .one()
    )

    db.commit()
    return ReaderMediaStateOut.model_validate(row)
