"""Reader profile and per-media state service layer."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import ReaderMediaState, ReaderProfile
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader import (
    ReaderMediaStateOut,
    ReaderMediaStatePatch,
    ReaderProfileOut,
    ReaderProfilePatch,
)

# Default values when no profile exists
DEFAULT_THEME = "light"
DEFAULT_FONT_SIZE_PX = 16
DEFAULT_LINE_HEIGHT = 1.5
DEFAULT_FONT_FAMILY = "serif"
DEFAULT_COLUMN_WIDTH_CH = 65
DEFAULT_FOCUS_MODE = False
DEFAULT_VIEW_MODE = "scroll"


def _profile_to_dict(profile: ReaderProfile | None) -> dict:
    """Convert profile (or defaults) to dict."""
    if profile:
        return {
            "theme": profile.theme,
            "font_size_px": int(profile.font_size_px),
            "line_height": float(profile.line_height),
            "font_family": profile.font_family,
            "column_width_ch": int(profile.column_width_ch),
            "focus_mode": profile.focus_mode,
            "default_view_mode": profile.default_view_mode,
            "updated_at": profile.updated_at,
        }
    return {
        "theme": DEFAULT_THEME,
        "font_size_px": DEFAULT_FONT_SIZE_PX,
        "line_height": DEFAULT_LINE_HEIGHT,
        "font_family": DEFAULT_FONT_FAMILY,
        "column_width_ch": DEFAULT_COLUMN_WIDTH_CH,
        "focus_mode": DEFAULT_FOCUS_MODE,
        "default_view_mode": DEFAULT_VIEW_MODE,
        "updated_at": datetime.now(UTC),
    }


def get_reader_profile(db: Session, user_id: UUID) -> ReaderProfileOut:
    """Get reader profile for user, or defaults if none exists."""
    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
    data = _profile_to_dict(profile)
    return ReaderProfileOut(**data)


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
    if patch.default_view_mode is not None:
        profile.default_view_mode = patch.default_view_mode

    db.commit()
    db.refresh(profile)
    return ReaderProfileOut.model_validate(profile)


def get_reader_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderMediaStateOut:
    """Get effective reader state for media (profile defaults + media overrides)."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == viewer_id).first()
    base = _profile_to_dict(profile)

    state = (
        db.query(ReaderMediaState)
        .filter(
            ReaderMediaState.user_id == viewer_id,
            ReaderMediaState.media_id == media_id,
        )
        .first()
    )

    # Start with profile defaults
    effective = dict(base)
    effective["view_mode"] = effective["default_view_mode"]
    effective.pop("default_view_mode", None)
    effective["locator_kind"] = None
    effective["fragment_id"] = None
    effective["offset"] = None
    effective["section_id"] = None
    effective["page"] = None
    effective["zoom"] = None

    # Apply media overrides
    if state:
        if state.theme is not None:
            effective["theme"] = state.theme
        if state.font_size_px is not None:
            effective["font_size_px"] = int(state.font_size_px)
        if state.line_height is not None:
            effective["line_height"] = float(state.line_height)
        if state.font_family is not None:
            effective["font_family"] = state.font_family
        if state.column_width_ch is not None:
            effective["column_width_ch"] = int(state.column_width_ch)
        if state.focus_mode is not None:
            effective["focus_mode"] = state.focus_mode
        effective["view_mode"] = state.view_mode
        effective["locator_kind"] = state.locator_kind
        effective["fragment_id"] = state.fragment_id
        effective["offset"] = state.offset
        effective["section_id"] = state.section_id
        effective["page"] = state.page
        effective["zoom"] = float(state.zoom) if state.zoom is not None else None
        effective["updated_at"] = state.updated_at

    return ReaderMediaStateOut(**effective)


def patch_reader_media_state(
    db: Session, viewer_id: UUID, media_id: UUID, patch: ReaderMediaStatePatch
) -> ReaderMediaStateOut:
    """Update reader media state (upsert)."""
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
        state = ReaderMediaState(user_id=viewer_id, media_id=media_id)
        db.add(state)
        db.flush()
    provided = patch.model_fields_set

    # Override fields: explicit null clears media-level override and falls back to profile.
    if "theme" in provided:
        state.theme = patch.theme
    if "font_size_px" in provided:
        state.font_size_px = patch.font_size_px
    if "line_height" in provided:
        state.line_height = patch.line_height
    if "font_family" in provided:
        state.font_family = patch.font_family
    if "column_width_ch" in provided:
        state.column_width_ch = patch.column_width_ch
    if "focus_mode" in provided:
        state.focus_mode = patch.focus_mode
    if "view_mode" in provided and patch.view_mode is not None:
        state.view_mode = patch.view_mode

    if "locator_kind" in provided:
        # Explicit null clears resume locator state for this media.
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

    return get_reader_media_state(db, viewer_id, media_id)
