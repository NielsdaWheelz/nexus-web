"""A resource's identity for one viewer: label, summary, where it opens.

Visibility is the resolver's verdict: an invisible ref comes back ``missing`` with a
``none`` activation. Notes, pickers and nexus find all read this one projection.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceRef
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
    return [
        ResourceItemOut(
            ref=ref.uri,
            scheme=ref.scheme,
            id=ref.id,
            label=item.label,
            summary=item.summary,
            activation=activations[ref.uri],
            missing=item.missing,
        )
        for ref, item in zip(refs, resolved, strict=True)
    ]


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    return resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]
