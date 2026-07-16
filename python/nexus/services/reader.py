"""Reader profile and per-media reader state service layer."""

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import MediaKind, ReaderProfile
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.reader import (
    CursorWrite,
    ReaderCursorEmpty,
    ReaderCursorPositioned,
    ReaderCursorSnapshot,
    ReaderProfileOut,
    ReaderProfilePatch,
    ReaderResumeState,
)

DEFAULT_THEME = "light"
DEFAULT_FONT_SIZE_PX = 16
DEFAULT_LINE_HEIGHT = 1.5
DEFAULT_FONT_FAMILY = "serif"
DEFAULT_COLUMN_WIDTH_CH = 65
DEFAULT_FOCUS_MODE = "off"
DEFAULT_HYPHENATION = "auto"
READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState)
# The final, explicitly named media FK on reader_media_state (see migration
# 0180). Runtime race normalization matches this exact name.
READER_MEDIA_STATE_MEDIA_FK = "fk_reader_media_state_media"
READER_MEDIA_STATE_UNIQUE = "uq_reader_media_state_user_media"
_VISIBLE_MEDIA_IDS_CTE_SQL = visible_media_ids_cte_sql().strip()
_SELECT_VISIBLE_READER_MEDIA_KIND_SQL = text(f"""
WITH visible_media AS (
    {_VISIBLE_MEDIA_IDS_CTE_SQL}
)
SELECT md.kind
FROM media md
WHERE md.id = :media_id
  AND EXISTS (
      SELECT 1 FROM visible_media WHERE media_id = md.id
  )
""")
_SELECT_READER_MEDIA_STATE_SQL = text("""
    SELECT id, locator, revision
    FROM reader_media_state
    WHERE user_id = :viewer_id AND media_id = :media_id
""")
_INSERT_READER_MEDIA_STATE_SQL = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision)
    VALUES (:viewer_id, :media_id, CAST(:locator AS jsonb), 1)
""").bindparams(bindparam("locator", type_=JSONB))
_UPDATE_READER_MEDIA_STATE_SQL = text("""
    UPDATE reader_media_state
    SET locator = CAST(:locator AS jsonb), revision = revision + 1, updated_at = now()
    WHERE id = :state_id AND revision = :base_revision
""").bindparams(bindparam("locator", type_=JSONB))


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


def _snapshot_from_row(
    locator_payload: object,
    revision: int,
    *,
    media_kind: str,
) -> ReaderCursorPositioned:
    """Validate a trusted stored cursor row; invalid rows are defects."""

    try:
        locator = READER_RESUME_STATE_ADAPTER.validate_python(locator_payload)
        _validate_reader_state_for_media(media_kind, locator)
    except (ValidationError, InvalidRequestError) as exc:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Stored reader state is invalid",
        ) from exc
    if revision < 1:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Stored reader state revision is invalid",
        )
    return ReaderCursorPositioned(revision=revision, locator=locator)


def _cursor_conflict(current: ReaderCursorSnapshot) -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_READER_STATE_CONFLICT,
        "Reader cursor was updated elsewhere",
        details={"current": current.model_dump(mode="json")},
    )


def _visible_media_kind(db: Session, viewer_id: UUID, media_id: UUID) -> str:
    """Resolve the media kind for a visible readable media row or raise."""

    media_kind = db.execute(
        _SELECT_VISIBLE_READER_MEDIA_KIND_SQL,
        {"viewer_id": viewer_id, "media_id": media_id},
    ).scalar_one_or_none()
    if media_kind is None:
        db.rollback()
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if _expected_reader_state_kind(str(media_kind)) is None:
        # Forward-defensive: every current MediaKind maps to a reader kind.
        db.rollback()
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{media_kind}'",
        )
    return str(media_kind)


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


def get_reader_cursor(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    """Get the canonical cursor snapshot for (viewer, media)."""
    media_kind = _visible_media_kind(db, viewer_id, media_id)
    row = db.execute(
        _SELECT_READER_MEDIA_STATE_SQL,
        {"viewer_id": viewer_id, "media_id": media_id},
    ).first()
    if row is None:
        return ReaderCursorEmpty()
    return _snapshot_from_row(row.locator, row.revision, media_kind=media_kind)


def _reconcile_first_insert_race(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    write: CursorWrite,
) -> ReaderCursorPositioned:
    """A concurrent first insert won; resolve to idempotent success or conflict."""
    media_kind = _visible_media_kind(db, viewer_id, media_id)
    row = db.execute(
        _SELECT_READER_MEDIA_STATE_SQL,
        {"viewer_id": viewer_id, "media_id": media_id},
    ).first()
    db.rollback()
    if row is None:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Reader cursor uniqueness race left no winning row",
        )
    current = _snapshot_from_row(row.locator, row.revision, media_kind=media_kind)
    if current.locator == write.locator:
        return current
    raise _cursor_conflict(current)


def put_reader_cursor(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    write: CursorWrite,
) -> ReaderCursorPositioned:
    """Conditionally replace the canonical cursor for (viewer, media).

    Semantics against the current row:
    - Empty + base 0: create at revision 1;
    - equal desired locator at any base: idempotent success at the current
      revision, no mutation;
    - matching base: replace, revision + 1;
    - stale base: 409 conflict carrying the exact current snapshot.
    """

    def attempt() -> ReaderCursorPositioned:
        media_kind = _visible_media_kind(db, viewer_id, media_id)
        try:
            _validate_reader_state_for_media(media_kind, write.locator)
        except InvalidRequestError:
            db.rollback()
            raise
        row = db.execute(
            _SELECT_READER_MEDIA_STATE_SQL,
            {"viewer_id": viewer_id, "media_id": media_id},
        ).first()
        if row is None:
            if write.base_revision != 0:
                db.rollback()
                raise _cursor_conflict(ReaderCursorEmpty())
            db.execute(
                _INSERT_READER_MEDIA_STATE_SQL,
                {
                    "viewer_id": viewer_id,
                    "media_id": media_id,
                    "locator": write.locator.model_dump(mode="json"),
                },
            )
            db.commit()
            return ReaderCursorPositioned(revision=1, locator=write.locator)

        current = _snapshot_from_row(row.locator, row.revision, media_kind=media_kind)
        if current.locator == write.locator:
            db.rollback()
            return current
        if write.base_revision != current.revision:
            db.rollback()
            raise _cursor_conflict(current)
        result = cast(
            CursorResult[Any],
            db.execute(
                _UPDATE_READER_MEDIA_STATE_SQL,
                {
                    "state_id": row.id,
                    "base_revision": current.revision,
                    "locator": write.locator.model_dump(mode="json"),
                },
            ),
        )
        # justify-defect: SERIALIZABLE already read this row at this revision;
        # a concurrent change surfaces as a serialization failure, not rowcount 0.
        assert result.rowcount == 1
        db.commit()
        return ReaderCursorPositioned(revision=current.revision + 1, locator=write.locator)

    try:
        return retry_serializable(db, "reader_cursor_write", attempt)
    except IntegrityError as exc:
        constraint = integrity_constraint_name(exc)
        db.rollback()
        if constraint == READER_MEDIA_STATE_UNIQUE:
            return _reconcile_first_insert_race(db, viewer_id, media_id, write)
        if constraint == READER_MEDIA_STATE_MEDIA_FK:
            # Media deletion can win immediately before a first cursor INSERT.
            visible_kind = db.execute(
                _SELECT_VISIBLE_READER_MEDIA_KIND_SQL,
                {"viewer_id": viewer_id, "media_id": media_id},
            ).scalar_one_or_none()
            db.rollback()
            if visible_kind is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found") from exc
            raise
        raise
