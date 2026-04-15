"""Reader profile and per-media resume service layer."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import ReaderMediaState, ReaderProfile
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader import (
    ReaderProfileOut,
    ReaderProfilePatch,
    ReaderResumeStateOut,
    ReaderResumeStatePatch,
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


def get_reader_resume_state(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderResumeStateOut:
    """Get per-media reader resume state."""
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
        return ReaderResumeStateOut(
            locator_kind=None,
            fragment_id=None,
            offset=None,
            section_id=None,
            page=None,
            zoom=None,
            updated_at=datetime.now(UTC),
        )

    return ReaderResumeStateOut.model_validate(state)


def patch_reader_resume_state(
    db: Session, viewer_id: UUID, media_id: UUID, patch: ReaderResumeStatePatch
) -> ReaderResumeStateOut:
    """Update per-media reader resume state (upsert)."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Ensure a row exists in a single SQL statement so concurrent first writes
    # cannot race into duplicate-key failures.
    db.execute(
        pg_insert(ReaderMediaState)
        .values(user_id=viewer_id, media_id=media_id)
        .on_conflict_do_nothing(
            index_elements=[ReaderMediaState.user_id, ReaderMediaState.media_id]
        )
    )
    state = (
        db.query(ReaderMediaState)
        .filter(
            ReaderMediaState.user_id == viewer_id,
            ReaderMediaState.media_id == media_id,
        )
        .one()
    )
    provided = patch.model_fields_set

    if "locator_kind" in provided:
        if patch.locator_kind is None:
            state.locator_kind = None
            state.fragment_id = None
            state.offset = None
            state.section_id = None
            state.page = None
            state.zoom = None
        else:
            state.locator_kind = patch.locator_kind
            if patch.locator_kind == "fragment_offset":
                state.fragment_id = patch.fragment_id
                state.offset = patch.offset
                state.section_id = None
                state.page = None
                state.zoom = None
            elif patch.locator_kind == "epub_section":
                state.fragment_id = None
                state.offset = None
                state.section_id = patch.section_id
                state.page = None
                state.zoom = None
            elif patch.locator_kind == "pdf_page":
                state.fragment_id = None
                state.offset = None
                state.section_id = None
                state.page = patch.page
                state.zoom = patch.zoom

    db.commit()
    db.refresh(state)

    return ReaderResumeStateOut.model_validate(state)
