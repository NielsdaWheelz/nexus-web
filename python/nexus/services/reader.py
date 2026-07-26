"""Reader profile service."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import ReaderProfile
from nexus.db.retries import retry_serializable
from nexus.schemas.reader import ReaderProfileOut, ReaderProfilePatch

# The only preference-default authority: schema-validated by construction and
# immutable (ReaderProfileOut is frozen). Preference columns carry no database
# default (migration 0181); a missing row and a first PATCH both consume this
# exact value.
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
    """Get reader profile for user, or defaults if none exists."""
    profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
    if profile:
        return ReaderProfileOut.model_validate(profile)
    return READER_PROFILE_DEFAULTS


def patch_reader_profile(db: Session, user_id: UUID, patch: ReaderProfilePatch) -> ReaderProfileOut:
    """Update reader profile, creating it from the default authority if absent.

    Runs entirely inside ``retry_serializable``: a concurrent first insert
    surfaces as an IntegrityError on ``reader_profiles_pkey``, which retries
    the whole attempt so the SELECT observes the winner and applies this
    patch on top of it. No upsert, explicit lock, or custom retry schedule.
    """

    def attempt() -> ReaderProfileOut:
        profile = db.query(ReaderProfile).filter(ReaderProfile.user_id == user_id).first()
        if not profile:
            # First PATCH: the migration dropped column server defaults, so
            # every field must be explicitly seeded from the one authority
            # before the patch is applied.
            profile = ReaderProfile(
                user_id=user_id,
                theme=READER_PROFILE_DEFAULTS.theme,
                font_size_px=READER_PROFILE_DEFAULTS.font_size_px,
                line_height=READER_PROFILE_DEFAULTS.line_height,
                font_family=READER_PROFILE_DEFAULTS.font_family,
                column_width_ch=READER_PROFILE_DEFAULTS.column_width_ch,
                focus_mode=READER_PROFILE_DEFAULTS.focus_mode,
                hyphenation=READER_PROFILE_DEFAULTS.hyphenation,
            )
            db.add(profile)

        for field_name in patch.model_fields_set:
            setattr(profile, field_name, getattr(patch, field_name))

        db.commit()
        db.refresh(profile)
        return ReaderProfileOut.model_validate(profile)

    return retry_serializable(db, "reader_profile_patch", attempt)
