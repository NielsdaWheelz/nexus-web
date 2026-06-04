"""Reader profile and per-media reader state service layer."""

import json
from datetime import UTC, datetime
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import Media, MediaKind, ReaderMediaState, ReaderProfile
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.reader import ReaderProfileOut, ReaderProfilePatch, ReaderResumeState

DEFAULT_THEME = "light"
DEFAULT_FONT_SIZE_PX = 16
DEFAULT_LINE_HEIGHT = 1.5
DEFAULT_FONT_FAMILY = "serif"
DEFAULT_COLUMN_WIDTH_CH = 65
DEFAULT_FOCUS_MODE = "off"
DEFAULT_HYPHENATION = "auto"
READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState)
_VISIBLE_MEDIA_IDS_CTE_SQL = visible_media_ids_cte_sql().strip()
_UPSERT_READER_MEDIA_STATE_SQL = text(f"""
WITH visible_media AS (
    {_VISIBLE_MEDIA_IDS_CTE_SQL}
),
upserted AS (
    INSERT INTO reader_media_state (user_id, media_id, locator)
    SELECT :viewer_id, :media_id, CAST(:locator AS jsonb)
    WHERE EXISTS (
        SELECT 1 FROM visible_media WHERE media_id = :media_id
    )
    ON CONFLICT (user_id, media_id)
    DO UPDATE SET
        locator = EXCLUDED.locator,
        updated_at = now()
    RETURNING 1
)
SELECT
    EXISTS (SELECT 1 FROM visible_media WHERE media_id = :media_id) AS visible,
    EXISTS (SELECT 1 FROM upserted) AS written
""").bindparams(bindparam("locator", type_=JSONB))

_CLEAR_READER_MEDIA_STATE_SQL = text(f"""
WITH visible_media AS (
    {_VISIBLE_MEDIA_IDS_CTE_SQL}
),
updated AS (
    UPDATE reader_media_state
    SET locator = NULL, updated_at = now()
    WHERE user_id = :viewer_id
      AND media_id = :media_id
      AND EXISTS (
          SELECT 1 FROM visible_media WHERE media_id = :media_id
      )
    RETURNING 1
)
SELECT
    EXISTS (SELECT 1 FROM visible_media WHERE media_id = :media_id) AS visible,
    EXISTS (SELECT 1 FROM updated) AS written
""")


def _expected_reader_state_kind(media_kind: str) -> str | None:
    """Map a media kind to the only allowed persisted reader-state kind."""

    if media_kind == MediaKind.pdf.value:
        return "pdf"
    if media_kind == MediaKind.epub.value:
        return "epub"
    if media_kind == MediaKind.web_article.value:
        return "web"
    if media_kind in {MediaKind.video.value, MediaKind.podcast_episode.value}:
        return "transcript"
    return None


def _validate_reader_state_for_media(media_kind: str, locator: ReaderResumeState) -> None:
    """Reject reader state kinds that do not match the media kind."""

    expected_kind = _expected_reader_state_kind(media_kind)
    if expected_kind is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{media_kind}'",
        )
    if locator.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state kind '{locator.kind}' does not match media kind '{media_kind}'",
        )


def _deserialize_reader_state(
    locator_payload: object | None,
    *,
    media_kind: str,
) -> ReaderResumeState | None:
    """Validate stored reader state."""

    if locator_payload is None:
        return None

    try:
        locator = READER_RESUME_STATE_ADAPTER.validate_python(locator_payload)
    except ValidationError as exc:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Stored reader state is invalid",
        ) from exc

    try:
        _validate_reader_state_for_media(media_kind, locator)
    except InvalidRequestError as exc:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Stored reader state is invalid",
        ) from exc
    return locator


def parse_reader_resume_state(raw_body: bytes) -> ReaderResumeState | None:
    """Parse a PUT /media/{id}/reader-state request body. An empty body is
    rejected; a JSON ``null`` clears the state (returns None); anything else must
    validate as a ReaderResumeState."""
    if not raw_body:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader state body is required."
        )
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader state body must be valid JSON."
        ) from exc
    if payload is None:
        return None
    try:
        return READER_RESUME_STATE_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid reader state payload."
        ) from exc


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
        hyphenation=DEFAULT_HYPHENATION,
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
    if patch.hyphenation is not None:
        profile.hyphenation = patch.hyphenation

    db.commit()
    db.refresh(profile)
    return ReaderProfileOut.model_validate(profile)


def get_reader_media_state(
    db: Session, viewer_id: UUID, media_id: UUID
) -> ReaderResumeState | None:
    """Get per-media reader resume state."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.query(Media).filter(Media.id == media_id).first()
    if media is None:
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
    return _deserialize_reader_state(state.locator, media_kind=media.kind)


def put_reader_media_state(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    locator: ReaderResumeState | None,
) -> ReaderResumeState | None:
    """Replace per-media reader resume state."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.query(Media).filter(Media.id == media_id).first()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if locator is not None:
        _validate_reader_state_for_media(media.kind, locator)

    locator_payload = locator.model_dump(mode="json") if locator else None

    if locator_payload is None:
        result = (
            db.execute(
                _CLEAR_READER_MEDIA_STATE_SQL,
                {"viewer_id": viewer_id, "media_id": media_id},
            )
            .mappings()
            .one()
        )
        if not result["visible"]:
            db.rollback()
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        db.commit()
        return None

    result = (
        db.execute(
            _UPSERT_READER_MEDIA_STATE_SQL,
            {"viewer_id": viewer_id, "media_id": media_id, "locator": locator_payload},
        )
        .mappings()
        .one()
    )
    if not result["visible"]:
        db.rollback()
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    db.commit()
    return locator
