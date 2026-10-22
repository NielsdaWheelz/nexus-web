"""Writer-owned lane versions and authorized read-only version probes.

Writers lock each lane before incrementing, and collect its first baseline in
the current transaction. An absent lane of a live resource is version one;
an unavailable resource never receives that implicit version in a probe.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceVersion
from nexus.services import writing
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
        .with_for_update()
        .where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme == ref.scheme,
            ResourceVersion.resource_id == ref.id,
            ResourceVersion.lane == lane,
        )
    )
    if row is not None:
        writing.lane(db, viewer_id=viewer_id, ref=ref, name=lane, before=row.version)
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
    writing.lane(db, viewer_id=viewer_id, ref=ref, name=lane, before=1)
    return row


def bump_version(db: Session, *, viewer_id: UUID, ref: ResourceRef, lane: str) -> None:
    row = ensure_version(db, viewer_id=viewer_id, ref=ref, lane=lane)
    row.version += 1
    writing.changed(db, viewer_id)
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


def query(db: Session, *, viewer_id: UUID, refs: list[str]):
    """One authorized snapshot; absent resources never inherit version one."""
    from nexus.db.models import Highlight
    from nexus.schemas.writing import ResourceVersionsOut, ResourceVersionState
    from nexus.services.highlights import highlight_version
    from nexus.services.resource_graph.refs import require_ref
    from nexus.services.resource_items.capabilities import capability
    from nexus.services.resource_items.items import visible_refs

    parsed = [require_ref(raw) for raw in refs]
    visible = visible_refs(db, viewer_id=viewer_id, refs=parsed)
    items: list[ResourceVersionState] = []
    for ref in parsed:
        live = ref.uri in visible
        lanes = versions_for_ref(db, viewer_id=viewer_id, ref=ref) if live else {}
        highlight = db.get(Highlight, ref.id) if live and ref.scheme == "highlight" else None
        items.append(
            ResourceVersionState(
                ref=ref.uri,
                state="live" if live else "unavailable",
                body_version=lanes.get("body", 1) if live and ref.scheme == "note_block" else None,
                title_version=lanes.get("title", 1) if live and ref.scheme == "page" else None,
                links_version=lanes.get("links", 1)
                if live and capability(ref.scheme).adjacency_source
                else None,
                annotations_version=lanes.get("annotations", 1)
                if live and ref.scheme == "media"
                else None,
                highlight_version=highlight_version(highlight) if highlight is not None else None,
            )
        )
    return ResourceVersionsOut(items=items)
