"""current saved presentations and acquisition work for readable x evidence.

capture bodies stay immutable. this projection alone combines logical identity,
physical holdings and the source owner's current obligations, in one snapshot.
read permission makes work observable; only a personal holding makes a post saved.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import non_system_media_ref_exists_sql, visible_media_ids_cte_sql
from nexus.schemas.x_captures import (
    XPostAcquisition,
    XPostSaveConflict,
    XPostSaveResolved,
    XPostSaveState,
    XPostSaveStateOut,
    XPostSaveUnavailable,
)
from nexus.services.imports import read_media_source_obligations
from nexus.services.reader_publication import ready_publication_rows_sql
from nexus.services.x_source import (
    readable_x_capture_ids_sql,
    x_primary_post_captures_sql,
    x_thread_candidates,
)


def read_x_post_save_states(
    db: Session, *, viewer_id: UUID, capture_ids: Sequence[UUID]
) -> XPostSaveStateOut:
    """one ordered answer per capture; ambiguity and lost authority stay item-local."""
    captures = {
        row.id: (row.post_id, row.source_revision_id)
        for row in db.execute(
            text(f"""
                SELECT id, post_id, source_revision_id FROM x_post_captures
                WHERE id = ANY(:capture_ids) AND id IN ({readable_x_capture_ids_sql()})
            """),
            {"viewer_id": viewer_id, "capture_ids": list(capture_ids)},
        )
    }
    if not captures:
        return XPostSaveStateOut(
            items=[XPostSaveUnavailable(capture_id=identity) for identity in capture_ids]
        )
    threads: dict[UUID, set[UUID]] = {}
    standalone: dict[UUID, UUID] = {}
    for row in db.execute(
        text(f"""
            SELECT primary_post.post_id, primary_post.media_id, primary_post.scope
            FROM ({x_primary_post_captures_sql()}) primary_post
            JOIN ({ready_publication_rows_sql()}) publication
              ON publication.media_id = primary_post.media_id
            WHERE primary_post.post_id = ANY(:post_ids)
              AND primary_post.media_id IN ({visible_media_ids_cte_sql()})
              AND {non_system_media_ref_exists_sql("primary_post.media_id")}
        """),
        {"viewer_id": viewer_id, "post_ids": list({post_id for post_id, _ in captures.values()})},
    ):
        if row.scope == "author_thread":
            threads.setdefault(row.post_id, set()).add(row.media_id)
        else:
            standalone[row.post_id] = row.media_id
    candidates = x_thread_candidates(
        db,
        viewer_id=viewer_id,
        revision_ids=[
            revision for post_id, revision in captures.values() if not threads.get(post_id)
        ],
    )
    destinations: dict[UUID, UUID | None] = {}
    work: dict[UUID, UUID] = {}
    conflicts: set[UUID] = set()
    for capture_id, (post_id, revision) in captures.items():
        saved_threads = threads.get(post_id, set())
        if len(saved_threads) == 1:
            media_id = next(iter(saved_threads))
            destinations[capture_id] = media_id
            work[capture_id] = media_id
            continue
        destinations[capture_id] = standalone.get(post_id)
        if len(saved_threads) > 1:
            conflicts.add(capture_id)
            continue
        targets = candidates[revision]
        if len(targets) > 1:
            conflicts.add(capture_id)
        elif targets:
            work[capture_id] = targets[0]
    obligations = read_media_source_obligations(
        db, viewer_id=viewer_id, media_ids=sorted(set(work.values()))
    )
    items: list[XPostSaveState] = []
    for capture_id in capture_ids:
        if capture_id not in captures:
            items.append(XPostSaveUnavailable(capture_id=capture_id))
        elif capture_id in conflicts:
            items.append(
                XPostSaveConflict(capture_id=capture_id, saved_media_id=destinations[capture_id])
            )
        else:
            acquisition = None
            media_id = work.get(capture_id)
            if media_id is not None and (current := obligations.get(media_id)) is not None:
                attempt_id, obligation = current
                acquisition = XPostAcquisition(
                    media_id=media_id, source_attempt_id=attempt_id, obligation=obligation
                )
            items.append(
                XPostSaveResolved(
                    capture_id=capture_id,
                    saved_media_id=destinations[capture_id],
                    acquisition=acquisition,
                )
            )
    return XPostSaveStateOut(items=items)
