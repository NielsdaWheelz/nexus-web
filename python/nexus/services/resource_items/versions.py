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
        select(ResourceVersion).where(
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
    row.version += 1
    row.updated_at = func.now()
    db.flush()


def versions_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> dict[str, int]:
    rows = db.execute(
        select(ResourceVersion.lane, ResourceVersion.version).where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme == ref.scheme,
            ResourceVersion.resource_id == ref.id,
        )
    ).all()
    return {str(lane): int(version) for lane, version in rows}
