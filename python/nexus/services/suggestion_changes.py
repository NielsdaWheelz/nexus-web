"""Suggestions input revision and wakeups, independent of feed registration.

The committing source owner calls ``record_input_change`` after its final domain
operation. The counter is always acquired last; nothing may acquire another
domain lock before that transaction commits.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from nexus.jobs.queue import JobRow
    from nexus.schemas.media_summary import ConsumptionState

CHANNEL = "nexus_suggestions"
NOTIFY_KEY = "changed"


def input_revision(db: Session) -> int:
    """The migration installs exactly one input owner, including before any feed."""
    return int(db.execute(text("SELECT revision FROM suggestion_inputs")).scalar_one())


def notify_suggestions(db: Session) -> None:
    """A transactional wakeup hint; readers always reread durable state."""
    db.execute(text("SELECT pg_notify(:channel, :key)"), {"channel": CHANNEL, "key": NOTIFY_KEY})


def record_input_change(db: Session) -> None:
    """Flush domain writes, advance the input owner and notify, immediately before commit."""
    db.flush()
    db.execute(
        text("UPDATE suggestion_inputs SET revision = revision + 1 RETURNING revision")
    ).scalar_one()
    notify_suggestions(db)

    from nexus.services.writing import effects

    for viewer_id in effects(db).viewer_ids:
        db.execute(text("SELECT pg_notify('nexus_writing', :viewer)"), {"viewer": str(viewer_id)})


def on_suggestion_job_history(db: Session, job: JobRow, execution_id: UUID) -> None:
    """Queue retry/reclaim/dead transitions change observation, never source inputs."""
    notify_suggestions(db)


def delete_suggestion_feeds(db: Session, *, library_id: UUID, user_id: UUID | None = None) -> None:
    """A library's feeds with their publications; only `user_id`'s when that member
    stops administering it (a feed exists only while its user admins the library)."""
    params = {"library_id": library_id, "user_id": user_id}
    feeds = """SELECT id FROM suggestion_feeds WHERE library_id = :library_id
        AND (CAST(:user_id AS uuid) IS NULL OR user_id = CAST(:user_id AS uuid))"""
    db.execute(text(f"DELETE FROM suggestion_shortlists WHERE feed_id IN ({feeds})"), params)
    db.execute(text(f"DELETE FROM suggestion_feeds WHERE id IN ({feeds})"), params)


def _read_state(db: Session, viewer_id: UUID, media_id: UUID) -> ConsumptionState:
    from nexus.services.consumption.projection import media_read_states

    return media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id].state


@dataclass(frozen=True)
class EngagementGate:
    """Taken before an engagement write on one media: its read state, and whether it
    already heads every anchor list the write moves. The write stamps the media's
    engagement now, which puts it first in each such list, so the anchors change
    exactly when one of them was headed by something else. Progress alone is no event."""

    media_id: UUID
    read_state: ConsumptionState
    leads: bool

    def moved(self, db: Session, *, viewer_id: UUID) -> bool:
        db.flush()
        return not self.leads or _read_state(db, viewer_id, self.media_id) != self.read_state


def engagement_gate(
    db: Session, *, viewer_id: UUID, media_id: UUID, listening: bool
) -> EngagementGate:
    """One head read per anchor list the write can move, destinations not yet registered
    as feeds included. Every engagement write leads the lectern's anchors; a library's
    anchors rank an episode (and its show) by listening, so a transcript save on an
    episode leaves them where they were."""
    # Keep queue-history imports light and avoid the ranker's consumption import cycle.
    from nexus.services.library_entries import engagement_anchor_library_ids, library_anchor_facts
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.suggestions import lectern_anchor_refs

    db.flush()
    show = db.scalar(
        text("SELECT podcast_id FROM podcast_episodes WHERE media_id = :id"), {"id": media_id}
    )
    own = {ResourceRef("media", media_id), *([ResourceRef("podcast", show)] if show else [])}
    lists = [lectern_anchor_refs(db, viewer_id=viewer_id)]
    if show is None or listening:
        lists += [
            library_anchor_facts(db, viewer_id=viewer_id, library_id=library_id, limit=1)
            for library_id in engagement_anchor_library_ids(
                db, viewer_id=viewer_id, media_id=media_id
            )
        ]
    return EngagementGate(
        media_id=media_id,
        read_state=_read_state(db, viewer_id, media_id),
        leads=all(anchors and anchors[0] in own for anchors in lists),
    )
