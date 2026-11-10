"""First account acquisition and explicit saves; removal never rewinds discovery."""

from collections.abc import Sequence
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.suggestion_changes import record_input_change

Origin = Literal["followed_source", "manual", "history"]


def record_arrivals(
    db: Session, *, user_ids: Sequence[UUID], media_ids: Sequence[UUID], origin: Origin
) -> None:
    """Compose with the acquisition transaction under its media reference barrier."""
    if not user_ids or not media_ids:
        return
    rows = db.execute(
        text("""
            INSERT INTO viewer_media_discoveries(user_id,media_id,first_discovered_at,origin,manually_saved)
            SELECT viewer,media,now(),:origin,false
            FROM unnest(CAST(:users AS uuid[])) viewer CROSS JOIN unnest(CAST(:media AS uuid[])) media
            WHERE NOT EXISTS (SELECT 1 FROM viewer_media_discoveries d
                              WHERE d.user_id=viewer AND d.media_id=media)
            RETURNING user_id,media_id
        """),
        {"users": sorted(set(user_ids)), "media": sorted(set(media_ids)), "origin": origin},
    ).all()
    if rows:
        record_input_change(db, owners=[f"discovery:{row.user_id}:{row.media_id}" for row in rows])


def record_library_arrivals(
    db: Session, *, library_id: UUID, media_ids: Sequence[UUID], origin: Origin
) -> None:
    viewers = list(
        db.scalars(
            text("""
        SELECT m.user_id FROM memberships m JOIN libraries l ON l.id=m.library_id
        WHERE m.library_id=:id AND l.system_key IS NULL ORDER BY m.user_id
    """),
            {"id": library_id},
        )
    )
    record_arrivals(db, user_ids=viewers, media_ids=media_ids, origin=origin)


def mark_manual_save(db: Session, *, user_id: UUID, media_id: UUID) -> None:
    """An individually accepted save is intent even when its placement already exists."""
    record_arrivals(db, user_ids=[user_id], media_ids=[media_id], origin="manual")
    db.execute(
        text("""
        UPDATE viewer_media_discoveries SET manually_saved=true,last_manually_saved_at=now()
        WHERE user_id=:user AND media_id=:media
    """),
        {"user": user_id, "media": media_id},
    )
    record_input_change(db, owners=[f"discovery:{user_id}:{media_id}"])


def transfer(db: Session, *, source_id: UUID, target_id: UUID) -> None:
    """Merge under both media locks; an unknown baseline absorbs a later timestamp."""
    rows = db.execute(
        text("""
        SELECT user_id,first_discovered_at,origin,manually_saved,last_manually_saved_at
        FROM viewer_media_discoveries WHERE media_id=:source ORDER BY user_id
    """),
        {"source": source_id},
    ).all()
    for row in rows:
        prior = db.execute(
            text("""
            SELECT first_discovered_at,origin,manually_saved,last_manually_saved_at FROM viewer_media_discoveries
            WHERE user_id=:user AND media_id=:target
        """),
            {"user": row.user_id, "target": target_id},
        ).first()
        params = {
            "user": row.user_id,
            "target": target_id,
            "at": row.first_discovered_at,
            "origin": row.origin,
            "manual": row.manually_saved,
            "manual_at": row.last_manually_saved_at,
        }
        if prior is None:
            db.execute(
                text("""
                INSERT INTO viewer_media_discoveries(user_id,media_id,first_discovered_at,origin,manually_saved,last_manually_saved_at)
                VALUES(:user,:target,:at,:origin,:manual,:manual_at)
            """),
                params,
            )
        else:
            if prior.first_discovered_at is None or (
                row.first_discovered_at is not None
                and prior.first_discovered_at <= row.first_discovered_at
            ):
                params.update(at=prior.first_discovered_at, origin=prior.origin)
            if prior.first_discovered_at == row.first_discovered_at:
                params["origin"] = min(
                    (prior.origin, row.origin),
                    key=lambda origin: (origin != "existing", origin != "history", origin),
                )
            params["manual"] = prior.manually_saved or row.manually_saved
            manual_times = [
                stamp
                for stamp in (prior.last_manually_saved_at, row.last_manually_saved_at)
                if stamp is not None
            ]
            params["manual_at"] = max(manual_times) if manual_times else None
            db.execute(
                text("""
                UPDATE viewer_media_discoveries SET first_discovered_at=:at,origin=:origin,
                    manually_saved=:manual,last_manually_saved_at=:manual_at WHERE user_id=:user AND media_id=:target
            """),
                params,
            )
    db.execute(text("DELETE FROM viewer_media_discoveries WHERE media_id=:id"), {"id": source_id})
    if rows:
        record_input_change(db, owners=[f"discovery:{row.user_id}:{target_id}" for row in rows])
