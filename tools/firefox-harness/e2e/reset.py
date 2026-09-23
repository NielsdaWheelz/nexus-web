"""temporary: remove the harness user's media and upload sessions through the product's deletion owner.

run with the backend environment: cd python && <env> uv run --frozen --no-sync python ../tools/firefox-harness/e2e/reset.py
"""

from __future__ import annotations

import os
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.services.media_deletion import (
    delete_document_media_if_unreferenced,
    delete_document_storage_objects,
)

USER_ID = UUID(os.environ.get("HARNESS_USER_ID", "d996e991-2dcd-4c04-b52e-6bc569359321"))


def main() -> None:
    db = get_session_factory()()
    try:
        media_ids = [
            row[0]
            for row in db.execute(
                text("SELECT id FROM media WHERE created_by_user_id = :u"), {"u": USER_ID}
            ).fetchall()
        ]
        removed = []
        for media_id in media_ids:
            db.execute(text("DELETE FROM library_entries WHERE media_id = :m"), {"m": media_id})
            db.execute(text("DELETE FROM user_media_deletions WHERE media_id = :m"), {"m": media_id})
            paths = delete_document_media_if_unreferenced(db, media_id)
            db.commit()
            if paths is not None:
                delete_document_storage_objects(paths)
                removed.append(str(media_id))
        session_ids = [
            row[0]
            for row in db.execute(
                text("SELECT id FROM media_upload_sessions WHERE created_by_user_id = :u"),
                {"u": USER_ID},
            ).fetchall()
        ]
        for session_id in session_ids:
            db.execute(text("DELETE FROM media_upload_events WHERE session_id = :s"), {"s": session_id})
            db.execute(
                text("DELETE FROM media_upload_session_destinations WHERE upload_session_id = :s"),
                {"s": session_id},
            )
            db.execute(text("DELETE FROM media_upload_sessions WHERE id = :s"), {"s": session_id})
        db.commit()
        print(f"reset: removed media {removed}, sessions {len(session_ids)}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
