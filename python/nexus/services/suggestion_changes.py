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
    from nexus.schemas.media import MediaReadState
    from nexus.services.resource_graph.refs import ResourceRef

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


def on_suggestion_job_history(db: Session, job: JobRow, execution_id: UUID) -> None:
    """Queue retry/reclaim/dead transitions change observation, never source inputs."""
    notify_suggestions(db)


def delete_suggestion_feeds_for_library(db: Session, *, library_id: UUID) -> None:
    db.execute(
        text("""DELETE FROM suggestion_shortlists WHERE feed_id IN (
            SELECT id FROM suggestion_feeds WHERE library_id = :id)"""),
        {"id": library_id},
    )
    db.execute(text("DELETE FROM suggestion_feeds WHERE library_id = :id"), {"id": library_id})


@dataclass(frozen=True)
class EngagementInputs:
    """Ordered identities and read state; progress timestamps alone are not events."""

    lectern: tuple[ResourceRef, ...]
    libraries: tuple[tuple[UUID, tuple[ResourceRef, ...]], ...]
    read_state: MediaReadState


def engagement_inputs(db: Session, *, viewer_id: UUID, media_id: UUID) -> EngagementInputs:
    """Cheap exact anchor facts, including destinations not yet registered as feeds."""
    # Keep queue-history imports light and avoid the ranker's consumption import cycle.
    from nexus.services.consumption.projection import media_read_states
    from nexus.services.library_entries import engagement_anchor_library_ids, library_anchor_facts
    from nexus.services.suggestions import SUGGESTION_ANCHOR_LIMIT, lectern_anchor_refs

    db.flush()
    libraries = engagement_anchor_library_ids(db, viewer_id=viewer_id, media_id=media_id)
    return EngagementInputs(
        lectern_anchor_refs(db, viewer_id=viewer_id),
        tuple(
            (
                id_,
                library_anchor_facts(
                    db, viewer_id=viewer_id, library_id=id_, limit=SUGGESTION_ANCHOR_LIMIT
                ),
            )
            for id_ in libraries
        ),
        media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id].state,
    )
