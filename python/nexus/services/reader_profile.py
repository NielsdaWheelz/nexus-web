"""Reader profile service."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import ReaderProfile
from nexus.db.retries import retry_serializable
from nexus.schemas.reader import ReaderProfileOut, ReaderProfilePatch

# The one preference-default authority: the columns carry no server default.
READER_PROFILE_DEFAULTS = ReaderProfileOut(
    theme="light",
    font_family="serif",
    font_size_px=16,
    line_height=1.5,
    column_width_ch=65,
    focus_mode="off",
    hyphenation="auto",
)


def get_reader_profile(db: Session, user_id: UUID) -> ReaderProfileOut:
    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
    if profile is None:
        return READER_PROFILE_DEFAULTS
    return ReaderProfileOut.model_validate(profile)


def patch_reader_profile(db: Session, user_id: UUID, patch: ReaderProfilePatch) -> ReaderProfileOut:
    """Seed a missing row from the defaults, then apply the patch, under retry."""

    def attempt() -> ReaderProfileOut:
        profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
        if profile is None:
            profile = ReaderProfile(user_id=user_id, **READER_PROFILE_DEFAULTS.model_dump())
            db.add(profile)
        for field_name in patch.model_fields_set:
            setattr(profile, field_name, getattr(patch, field_name))
        db.commit()
        db.refresh(profile)
        return ReaderProfileOut.model_validate(profile)

    return retry_serializable(db, "reader_profile_patch", attempt)
