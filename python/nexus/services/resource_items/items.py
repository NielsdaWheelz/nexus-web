"""A resource's identity for one viewer: label, summary, where it opens, its lane versions.

Visibility is the resolver's verdict: an invisible ref comes back ``missing`` with a
``none`` activation. Notes, pickers and nexus find all read this one projection.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceVersion
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_items.routing import resource_activations_for_refs


def resource_items_out(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> list[ResourceItemOut]:
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=refs)
    missing = {ref.uri for ref, item in zip(refs, resolved, strict=True) if item.missing}
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=refs, missing_ref_uris=missing
    )
    rows = db.execute(
        select(
            ResourceVersion.resource_scheme,
            ResourceVersion.resource_id,
            ResourceVersion.lane,
            ResourceVersion.version,
        ).where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme.in_({ref.scheme for ref in refs}),
            ResourceVersion.resource_id.in_({ref.id for ref in refs}),
        )
    ).all()
    # An absent version row reads as version 1.
    versions: dict[str, dict[str, int]] = {}
    for ref in refs:
        lanes = {"page": ("links", "title"), "note_block": ("links", "body")}
        versions[ref.uri] = dict.fromkeys(lanes.get(ref.scheme, ("links",)), 1)
    for scheme, resource_id, lane, version in rows:
        uri = ResourceRef(scheme=cast(ResourceScheme, scheme), id=resource_id).uri
        if uri in versions:
            versions[uri][str(lane)] = int(version)
    return [
        ResourceItemOut(
            ref=ref.uri,
            scheme=ref.scheme,
            id=ref.id,
            label=item.label,
            summary=item.summary,
            activation=activations[ref.uri],
            missing=item.missing,
            version_by_lane=versions[ref.uri],
        )
        for ref, item in zip(refs, resolved, strict=True)
    ]


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    return resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]
