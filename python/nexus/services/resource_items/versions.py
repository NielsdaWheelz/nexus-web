"""Writer-owned context preconditions and readable-evidence invalidation lanes.

Writers lock the lane before incrementing. An absent lane of a live resource is
version one. Authored content carries no lane: its causality is the authored feed.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceVersion
from nexus.services.resource_graph.refs import ResourceRef


def evidence_revision(db: Session, *, viewer_id: UUID) -> str:
    """Opaque equality token for the viewer's readable remote evidence.

    It is independent of authored feed cursors and confers no source access.
    feed responses read this owner in their snapshot.
    Source lanes survive source removal; the sum only advances. Captures use
    their immutable fragment identity, including when they have no saved media.
    """
    return str(
        db.scalar(
            select(func.coalesce(func.sum(ResourceVersion.version), 0)).where(
                ResourceVersion.user_id == viewer_id, ResourceVersion.lane == "evidence"
            )
        )
    )


def invalidate_evidence(db: Session, *, projections: set[tuple[UUID, ResourceRef]]) -> None:
    """Flush authorized audience/source revisions in the caller's transaction."""
    for viewer_id, ref in sorted(
        projections, key=lambda item: (item[0], item[1].scheme, item[1].id)
    ):
        bump_version(db, viewer_id=viewer_id, ref=ref, lane="evidence")


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
        .with_for_update()
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
