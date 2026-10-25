"""independent viewer/show playback defaults.

create resends its client id with version zero. an update first verifies row
identity, accepts the exact desired pair inertly, otherwise requires the captured
version and advances it. subscription changes never delete these settings.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas import podcast as wire
from nexus.services import users
from nexus.services.consumption import observation


def get_settings(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastPlaybackSettingsOut:
    if db.scalar(text("SELECT id FROM podcasts WHERE id=:id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return get_settings_many(db, viewer_id, [podcast_id])[podcast_id]


def get_settings_many(
    db: Session, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, wire.PodcastPlaybackSettingsOut]:
    """Defaults for known shows, including absent viewer rows, in one read."""
    rows = {
        row.podcast_id: row
        for row in db.execute(
            text(
                "SELECT * FROM podcast_playback_settings WHERE user_id=:viewer AND podcast_id=ANY(:ids)"
            ),
            {"viewer": viewer_id, "ids": podcast_ids},
        )
    }
    result = {}
    for podcast_id in podcast_ids:
        row = rows.get(podcast_id)
        result[podcast_id] = wire.PodcastPlaybackSettingsOut(
            id=row.id if row else None,
            podcast_id=podcast_id,
            settings_version=str(row.settings_version) if row else "0",
            default_playback_speed=row.default_playback_speed if row else None,
            pause_shortening_mode=row.pause_shortening_mode if row else None,
        )
    return result


def put_settings(
    db: Session, viewer_id: UUID, podcast_id: UUID, body: wire.PodcastPlaybackSettingsRequest
) -> wire.PodcastPlaybackSettingsOut:
    def attempt() -> wire.PodcastPlaybackSettingsOut:
        users.lock_viewer(db, viewer_id)
        if (
            db.scalar(text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
            is None
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        taken = db.execute(
            text("SELECT user_id,podcast_id FROM podcast_playback_settings WHERE id=:id"),
            {"id": body.id},
        ).first()
        if taken is not None and (taken.user_id != viewer_id or taken.podcast_id != podcast_id):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Playback settings id is taken")
        current = get_settings(db, viewer_id, podcast_id)
        if current.id is None:
            if body.expected_settings_version != "0":
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Playback settings changed")
            inserted = db.scalar(
                text("""
                INSERT INTO podcast_playback_settings
                    (id,user_id,podcast_id,default_playback_speed,pause_shortening_mode)
                VALUES (:id,:viewer,:podcast,:speed,:pause)
                ON CONFLICT (id) DO NOTHING RETURNING id
            """),
                {
                    "id": body.id,
                    "viewer": viewer_id,
                    "podcast": podcast_id,
                    "speed": body.default_playback_speed,
                    "pause": body.pause_shortening_mode,
                },
            )
            if inserted is None:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Playback settings id is taken"
                )
            observation.advance(db, viewer_id)
            return get_settings(db, viewer_id, podcast_id)
        if current.id != body.id:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Playback settings changed")
        if (
            current.default_playback_speed == body.default_playback_speed
            and current.pause_shortening_mode == body.pause_shortening_mode
        ):
            return current
        if current.settings_version != body.expected_settings_version:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Playback settings changed")
        db.execute(
            text("""UPDATE podcast_playback_settings SET settings_version=settings_version+1,
                           default_playback_speed=:speed,pause_shortening_mode=:pause,updated_at=now()
                           WHERE id=:id"""),
            {
                "id": body.id,
                "speed": body.default_playback_speed,
                "pause": body.pause_shortening_mode,
            },
        )
        observation.advance(db, viewer_id)
        return get_settings(db, viewer_id, podcast_id)

    return retry_read_committed(db, "podcast_playback_settings", attempt)
