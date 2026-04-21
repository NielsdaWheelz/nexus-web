"""Reader profile and per-media locator service layer."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, MediaKind, ReaderMediaState, ReaderProfile
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.reader import ReaderLocator, ReaderProfileOut, ReaderProfilePatch

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


def get_reader_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderLocator | None:
    """Get per-media reader locator."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    state = (
        db.query(ReaderMediaState.locator)
        .filter(
            ReaderMediaState.user_id == viewer_id,
            ReaderMediaState.media_id == media_id,
        )
        .first()
    )
    if state is None or state.locator is None:
        return None
    return ReaderLocator.model_validate(state.locator)


def put_reader_media_state(
    db: Session, viewer_id: UUID, media_id: UUID, locator: ReaderLocator | None
) -> ReaderLocator | None:
    """Replace per-media reader locator."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.query(Media).filter(Media.id == media_id).first()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if locator is not None:
        if media.kind == MediaKind.pdf:
            if locator.page is None:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "page is required for PDF reader state",
                )
            if any(
                value is not None
                for value in (
                    locator.source,
                    locator.anchor,
                    locator.text_offset,
                    locator.quote,
                    locator.quote_prefix,
                    locator.quote_suffix,
                    locator.progression,
                    locator.total_progression,
                )
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "PDF reader state cannot include text locator fields",
                )
        else:
            if locator.source is None:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "source is required for text reader state",
                )
            if (
                locator.page is not None
                or locator.page_progression is not None
                or locator.zoom is not None
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Text reader state cannot include PDF page fields",
                )
            if not any(
                value is not None
                for value in (
                    locator.anchor,
                    locator.text_offset,
                    locator.quote,
                    locator.quote_prefix,
                    locator.quote_suffix,
                    locator.progression,
                    locator.total_progression,
                    locator.position,
                )
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Text reader state needs at least one anchor field",
                )

    current_time = datetime.now(UTC)
    locator_payload = locator.model_dump(mode="json", exclude_none=True) if locator else None
    state = (
        db.query(ReaderMediaState)
        .filter(
            ReaderMediaState.user_id == viewer_id,
            ReaderMediaState.media_id == media_id,
        )
        .first()
    )

    if locator_payload is None:
        if state is None:
            return None
        db.execute(
            text(
                """
                UPDATE reader_media_state
                SET locator = NULL, updated_at = :updated_at
                WHERE id = :state_id
                """
            ),
            {
                "updated_at": current_time,
                "state_id": state.id,
            },
        )
        db.commit()
        return None

    if state is None:
        state = ReaderMediaState(
            user_id=viewer_id,
            media_id=media_id,
            locator=locator_payload,
            created_at=current_time,
            updated_at=current_time,
        )
        db.add(state)
        try:
            db.commit()
            return (
                ReaderLocator.model_validate(state.locator) if state.locator is not None else None
            )
        except IntegrityError:
            db.rollback()
            state = (
                db.query(ReaderMediaState)
                .filter(
                    ReaderMediaState.user_id == viewer_id,
                    ReaderMediaState.media_id == media_id,
                )
                .one()
            )

    state.locator = locator_payload
    state.updated_at = current_time
    db.commit()
    return ReaderLocator.model_validate(state.locator) if state.locator is not None else None
