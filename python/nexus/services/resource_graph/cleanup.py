"""Machine-fact cleanup when a server-owned resource dies; ``resource_edges`` has no cascades.

1. A cited (ordinal) edge dies only with its source unless the dying resource's owner
   requests removal of inbound citations too.
2. Every other machine fact dies with either endpoint.
3. An authored link never dies here: it is canonical state with its own observed-remove
   liveness, and its projection row and endpoint positions stay. A gone endpoint is a
   source stub to devices and unreadable to every server reader.

View states go before their edges, and external snapshots no longer cited by anything
go too. Flush-only; death is global, so nothing here filters by viewer.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    String,
    and_,
    any_,
    cast,
    delete,
    exists,
    literal,
    or_,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import InstrumentedAttribute, Session

from nexus.db.models import (
    MessageRetrieval,
    ResourceEdge,
    ResourceExternalSnapshot,
    ResourceViewState,
    XPostSource,
)
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS
from nexus.services.resource_graph.refs import ResourceRef


def delete_edges_for_deleted_resource(
    db: Session, *, ref: ResourceRef, remove_inbound_citations: bool = False
) -> None:
    delete_edges_for_deleted_resources(
        db, refs=[ref], remove_inbound_citations=remove_inbound_citations
    )


def delete_edges_for_deleted_resources(
    db: Session, *, refs: Iterable[ResourceRef], remove_inbound_citations: bool = False
) -> None:
    dead: dict[str, set[UUID]] = {}
    for ref in refs:
        dead.setdefault(ref.scheme, set()).add(ref.id)
    if not dead:
        return

    def at(
        scheme: InstrumentedAttribute[str], id_: InstrumentedAttribute[UUID]
    ) -> ColumnElement[bool]:
        # One uuid[] per scheme keeps the statement one size for any number of refs;
        # a row-value IN list grows with them and overflows postgres's stack near 7,500.
        return or_(
            *(
                and_(scheme == name, id_ == any_(literal(list(ids), ARRAY(PG_UUID(as_uuid=True)))))
                for name, ids in dead.items()
            )
        )

    at_source = at(ResourceEdge.source_scheme, ResourceEdge.source_id)
    at_target = at(ResourceEdge.target_scheme, ResourceEdge.target_id)
    dying = select(ResourceEdge.id).where(
        ResourceEdge.origin.not_in(AUTHORED_LINK_ORIGINS),
        or_(
            at_source,
            at_target
            if remove_inbound_citations
            else and_(ResourceEdge.ordinal.is_(None), at_target),
        ),
    )
    from nexus.services.library_entries import lock_media_rows_in_order

    retained_media = lock_media_rows_in_order(
        db,
        list(
            db.scalars(
                select(XPostSource.media_id)
                .join(
                    ResourceEdge,
                    ResourceEdge.snapshot[("evidence", "target", "owner_ref")].astext
                    == "media:" + cast(XPostSource.media_id, String),
                )
                .where(
                    ResourceEdge.id.in_(dying),
                    ResourceEdge.origin == "citation",
                    ResourceEdge.ordinal.is_not(None),
                )
                .distinct()
            )
        ),
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(dying)))
    deleted = db.execute(
        delete(ResourceEdge)
        .where(ResourceEdge.id.in_(dying))
        .returning(ResourceEdge.ordinal, ResourceEdge.target_scheme, ResourceEdge.target_id)
    ).all()
    if retained_media:
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        for media_id in retained_media:
            claim_document_teardown_if_unreferenced_locked(db, media_id)
    delete_orphaned_external_snapshots(
        db,
        snapshot_ids=[
            target_id
            for ordinal, scheme, target_id in deleted
            if ordinal is not None and scheme == "external_snapshot"
        ],
    )


def delete_orphaned_external_snapshots(db: Session, *, snapshot_ids: Iterable[UUID]) -> None:
    """Delete captured web snapshots that no edge and no retrieval row references."""
    ids = list(set(snapshot_ids))
    if not ids:
        return
    db.execute(
        delete(ResourceExternalSnapshot).where(
            ResourceExternalSnapshot.id.in_(ids),
            ~exists().where(
                ResourceEdge.target_scheme == "external_snapshot",
                ResourceEdge.target_id == ResourceExternalSnapshot.id,
            ),
            ~exists().where(
                MessageRetrieval.result_type == "web_result",
                MessageRetrieval.source_id == cast(ResourceExternalSnapshot.id, String),
            ),
        )
    )
