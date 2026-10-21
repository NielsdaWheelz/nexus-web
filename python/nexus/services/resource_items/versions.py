from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceVersion
from nexus.services.resource_graph.refs import ResourceRef


def ensure_version(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    lane: str,
) -> ResourceVersion:
    row = db.scalar(
        select(ResourceVersion)
        .execution_options(populate_existing=True)
        .where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme == ref.scheme,
            ResourceVersion.resource_id == ref.id,
            ResourceVersion.lane == lane,
        )
    )
    if row is not None:
        return row
    row = ResourceVersion(
        user_id=viewer_id,
        resource_scheme=ref.scheme,
        resource_id=ref.id,
        lane=lane,
        version=1,
    )
    db.add(row)
    db.flush()
    return row


def bump_version(db: Session, *, viewer_id: UUID, ref: ResourceRef, lane: str) -> None:
    row = ensure_version(db, viewer_id=viewer_id, ref=ref, lane=lane)
    if lane == "links" and _BUMPED in db.info:
        db.info[_BUMPED].setdefault((viewer_id, ref), row.version)
    row.version += 1
    row.updated_at = func.now()
    db.flush()


_BUMPED = "nexus.bumped_links"


def collect_bumped_links(db: Session) -> None:
    """Record each links lane's version before its first bump in this outline batch."""
    db.info[_BUMPED] = {}


def links_at_batch_start(db: Session, viewer_id: UUID, ref: ResourceRef) -> int:
    """The lane's version when the collecting batch began (a missing row reads 1)."""
    started = db.info[_BUMPED].get((viewer_id, ref))
    if started is not None:
        return started
    return versions_for_ref(db, viewer_id=viewer_id, ref=ref).get("links", 1)


def bumped_links(db: Session, viewer_id: UUID) -> list[ResourceRef]:
    """End the collecting batch: the viewer's lanes it bumped."""
    return [ref for user_id, ref in db.info.pop(_BUMPED) if user_id == viewer_id]


def versions_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> dict[str, int]:
    rows = db.execute(
        select(ResourceVersion.lane, ResourceVersion.version).where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme == ref.scheme,
            ResourceVersion.resource_id == ref.id,
        )
    ).all()
    return {str(lane): int(version) for lane, version in rows}
