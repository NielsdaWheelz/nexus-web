"""Page/note retention and its transaction-held writer pins.

A cross-owner graph fact retains every live or captured page/note owner, independent
of origin and viewer. Saved dossier heads retain their subject. Derived rows alone
retain nothing. Mutators pin before visibility checks and touch only changed saved
content, order or retaining facts; hydration never pins or touches. Flush-only.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.services.resource_graph.owners import DERIVED_SCHEMES, owner_rows_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref


def canonical_blank(body: object) -> bool:
    return (
        isinstance(body, dict)
        and body.get("type") == "paragraph"
        and set(body) <= {"type", "content", "attrs", "marks"}
        and body.get("content", []) == []
        and body.get("attrs", {}) == {}
        and body.get("marks", []) == []
    )


def _owner_map(db: Session, refs: Iterable[ResourceRef]) -> dict[ResourceRef, ResourceRef]:
    members = list(set(refs))
    owners = {ref: ref for ref in members if ref.scheme not in DERIVED_SCHEMES}
    derived = [ref for ref in members if ref.scheme in DERIVED_SCHEMES]
    if not derived:
        return owners
    rows = db.execute(
        text(
            owner_rows_sql(
                "SELECT * FROM unnest(CAST(:schemes AS text[]), CAST(:ids AS uuid[])) AS e(scheme, id)",
                derived_schemes={ref.scheme for ref in derived},
            )
        ),
        {"schemes": [ref.scheme for ref in derived], "ids": [ref.id for ref in derived]},
    )
    owners.update(
        {
            assert_resource_ref(f"{scheme}:{id_}"): assert_resource_ref(
                f"{owner_scheme}:{owner_id}"
            )
            for scheme, id_, owner_scheme, owner_id in rows
        }
    )
    return owners


def resolve_owners(db: Session, refs: Iterable[ResourceRef]) -> list[ResourceRef]:
    return sorted(set(_owner_map(db, refs).values()), key=lambda ref: (ref.scheme, ref.id))


def pin_owners(db: Session, refs: Iterable[ResourceRef]) -> list[ResourceRef]:
    """Pin live note/page owners in stable order before validating a live attachment."""
    pinned = []
    for ref in resolve_owners(db, refs):
        if ref.scheme not in ("page", "note_block"):
            continue
        model = Page if ref.scheme == "page" else NoteBlock
        if (
            db.scalar(
                select(model.id)
                .where(model.id == ref.id)
                .with_for_update(read=True, key_share=True)
            )
            is not None
        ):
            pinned.append(ref)
    return pinned


def touch_owners(db: Session, refs: Iterable[ResourceRef]) -> None:
    for ref in pin_owners(db, refs):
        model = Page if ref.scheme == "page" else NoteBlock
        db.execute(
            update(model)
            .where(model.id == ref.id)
            .values(last_activity_at=func.greatest(model.last_activity_at, func.clock_timestamp()))
        )


def edge_endpoints(rows: Iterable[ResourceEdge]) -> list[ResourceRef]:
    refs: set[ResourceRef] = set()
    for row in rows:
        refs.add(assert_resource_ref(f"{row.source_scheme}:{row.source_id}"))
        refs.add(assert_resource_ref(f"{row.target_scheme}:{row.target_id}"))
        captured = captured_owner(row)
        if captured is not None:
            refs.add(captured)
    return list(refs)


def captured_owner(row: ResourceEdge) -> ResourceRef | None:
    if row.snapshot is None:
        return None
    evidence = CitationSnapshot.model_validate(row.snapshot).evidence
    captured = evidence.target.owner_ref if evidence is not None else None
    return assert_resource_ref(captured) if captured is not None else None


def _retaining_edges(
    rows: Sequence[ResourceEdge], owners: dict[ResourceRef, ResourceRef]
) -> Iterator[tuple[UUID, set[ResourceRef]]]:
    for row in rows:
        source = assert_resource_ref(f"{row.source_scheme}:{row.source_id}")
        target = assert_resource_ref(f"{row.target_scheme}:{row.target_id}")
        captured = captured_owner(row)
        target_owner = owners[target]
        if (
            captured is not None
            and target.scheme in ("evidence_span", "content_chunk")
            and target_owner == target
        ):
            target_owner = captured
        endpoints = {owners[source], target_owner}
        if captured is not None:
            endpoints.add(captured)
        if len(endpoints) > 1:
            yield row.id, endpoints


def retaining_owners(db: Session, rows: Sequence[ResourceEdge]) -> list[ResourceRef]:
    owners = _owner_map(db, edge_endpoints(rows))
    retained: set[ResourceRef] = set()
    for _, endpoints in _retaining_edges(rows, owners):
        retained.update(endpoints)
    return sorted(retained, key=lambda ref: (ref.scheme, ref.id))


def retainer_count(
    db: Session, ref: ResourceRef, *, excluding_edge_ids: Sequence[UUID] = ()
) -> int:
    """Count one owner's retaining edges and saved heads in the writer's snapshot.

    A page owns only itself. A note may also own passage anchors, spans and
    chunks; an edge's captured owner remains relevant after a derived row goes
    away. The opposite endpoint is resolved from the same candidate edges.
    """
    assert ref.scheme in ("page", "note_block")
    owned = "SELECT CAST(:scheme AS text) AS scheme, CAST(:id AS uuid) AS id"
    if ref.scheme == "note_block":
        owned += """
            UNION ALL SELECT 'passage_anchor', id FROM passage_anchors
                WHERE owner_scheme = :scheme AND owner_id = :id
            UNION ALL SELECT 'evidence_span', id FROM evidence_spans
                WHERE owner_kind = :scheme AND owner_id = :id
            UNION ALL SELECT 'content_chunk', id FROM content_chunks
                WHERE owner_kind = :scheme AND owner_id = :id
        """
    rows = db.scalars(
        select(ResourceEdge)
        .from_statement(
            text(f"""
            WITH owned AS ({owned})
            SELECT e.* FROM resource_edges e
            WHERE NOT (e.id = ANY(CAST(:excluded AS uuid[])))
                AND ((e.source_scheme, e.source_id) IN (SELECT scheme, id FROM owned)
                    OR (e.target_scheme, e.target_id) IN (SELECT scheme, id FROM owned)
                    OR e.snapshot #>> '{{evidence,target,owner_ref}}' = :ref)
        """)
        )
        .execution_options(populate_existing=True),
        {"scheme": ref.scheme, "id": ref.id, "ref": ref.uri, "excluded": list(excluding_edge_ids)},
    ).all()
    owners = _owner_map(db, edge_endpoints(rows))
    retained = sum(ref in endpoints for _, endpoints in _retaining_edges(rows, owners))
    saved = db.execute(
        text("SELECT count(*) FROM artifacts WHERE subject_scheme=:scheme AND subject_id=:id"),
        {"scheme": ref.scheme, "id": ref.id},
    ).scalar_one()
    return retained + saved


def has_retainer(db: Session, ref: ResourceRef, *, excluding_edge_ids: Sequence[UUID] = ()) -> bool:
    return retainer_count(db, ref, excluding_edge_ids=excluding_edge_ids) > 0
