"""Page/note retention and its transaction-held writer pins.

A cross-owner graph fact retains every live or captured page/note owner, independent
of origin and viewer. Derived rows alone retain nothing. Mutators pin before visibility
checks and touch only changed saved content, order or retaining facts; hydration never
pins or touches. Flush-only.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.services.resource_graph.owners import owner_rows_sql
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
    if not members:
        return {}
    rows = db.execute(
        text(
            owner_rows_sql(
                "SELECT * FROM unnest(CAST(:schemes AS text[]), CAST(:ids AS uuid[])) AS e(scheme, id)"
            )
        ),
        {"schemes": [ref.scheme for ref in members], "ids": [ref.id for ref in members]},
    )
    return {
        assert_resource_ref(f"{scheme}:{id_}"): assert_resource_ref(f"{owner_scheme}:{owner_id}")
        for scheme, id_, owner_scheme, owner_id in rows
    }


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


def retaining_owners(db: Session, rows: Sequence[ResourceEdge]) -> list[ResourceRef]:
    owners = _owner_map(db, edge_endpoints(rows))
    retained: set[ResourceRef] = set()
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
            retained.update(endpoints)
    return sorted(retained, key=lambda ref: (ref.scheme, ref.id))


_INCIDENT_OWNERS = owner_rows_sql(
    "SELECT source_scheme AS scheme, source_id AS id FROM incident"
    " UNION SELECT target_scheme, target_id FROM incident"
)


def retainer_counts(
    db: Session,
    owner_id: UUID,
    refs: Sequence[ResourceRef],
    *,
    excluding_edge_ids: Sequence[UUID] = (),
) -> dict[ResourceRef, int]:
    """Complete retaining facts per page/note of one owner, including snapshots whose
    derived target disappeared. Reads only the facts incident to what each ref owns
    (itself, its passage anchors, evidence spans and content chunks) or captured it;
    every such fact is its owner's own (census C12), so the owner's edge indexes serve."""
    if not refs:
        return {}
    rows = db.execute(
        text(f"""
            WITH targets AS (
                SELECT * FROM unnest(CAST(:schemes AS text[]), CAST(:ids AS uuid[])) AS t(scheme, id)
            ), owned AS (
                SELECT scheme, id FROM targets
                UNION ALL SELECT 'passage_anchor', p.id FROM targets t
                    JOIN passage_anchors p ON (p.owner_scheme, p.owner_id) = (t.scheme, t.id)
                UNION ALL SELECT 'evidence_span', s.id FROM targets t
                    JOIN evidence_spans s ON (s.owner_kind, s.owner_id) = (t.scheme, t.id)
                UNION ALL SELECT 'content_chunk', c.id FROM targets t
                    JOIN content_chunks c ON (c.owner_kind, c.owner_id) = (t.scheme, t.id)
            ), incident AS (
                SELECT e.* FROM resource_edges e WHERE e.user_id = :owner AND e.id IN (
                    SELECT e.id FROM resource_edges e JOIN owned o
                        ON (e.source_scheme, e.source_id) = (o.scheme, o.id) WHERE e.user_id = :owner
                    UNION SELECT e.id FROM resource_edges e JOIN owned o
                        ON (e.target_scheme, e.target_id) = (o.scheme, o.id) WHERE e.user_id = :owner
                    UNION SELECT e.id FROM resource_edges e WHERE e.user_id = :owner
                        AND e.snapshot #>> '{{evidence,target,owner_ref}}' = ANY(:refs))
            ), owners AS ({_INCIDENT_OWNERS}), edge_owners AS (
                SELECT e.id, s.owner_scheme || ':' || s.owner_id AS source_owner,
                    CASE WHEN e.target_scheme IN ('evidence_span', 'content_chunk')
                        AND t.owner_scheme = e.target_scheme
                        THEN COALESCE(e.snapshot #>> '{{evidence,target,owner_ref}}',
                            t.owner_scheme || ':' || t.owner_id)
                        ELSE t.owner_scheme || ':' || t.owner_id END AS target_owner,
                    e.snapshot #>> '{{evidence,target,owner_ref}}' AS captured_owner
                FROM incident e
                JOIN owners s ON (s.scheme, s.id) = (e.source_scheme, e.source_id)
                JOIN owners t ON (t.scheme, t.id) = (e.target_scheme, e.target_id)
                WHERE NOT (e.id = ANY(CAST(:excluded AS uuid[])))
            ), endpoints AS (
                SELECT id, source_owner AS owner_ref FROM edge_owners
                UNION SELECT id, target_owner FROM edge_owners
                UNION SELECT id, captured_owner FROM edge_owners WHERE captured_owner IS NOT NULL
            ), retaining AS (
                SELECT id FROM endpoints GROUP BY id HAVING count(DISTINCT owner_ref) > 1
            )
            SELECT t.scheme || ':' || t.id AS ref,
                (SELECT count(DISTINCT e.id) FROM endpoints e JOIN retaining r USING (id)
                    WHERE e.owner_ref = t.scheme || ':' || t.id) AS retainers
            FROM targets t
        """),
        {
            "owner": owner_id,
            "excluded": list(excluding_edge_ids),
            "refs": [ref.uri for ref in refs],
            "schemes": [ref.scheme for ref in refs],
            "ids": [ref.id for ref in refs],
        },
    )
    return {assert_resource_ref(row.ref): row.retainers for row in rows}


def has_retainer(
    db: Session, owner_id: UUID, ref: ResourceRef, *, excluding_edge_ids: Sequence[UUID] = ()
) -> bool:
    return retainer_counts(db, owner_id, [ref], excluding_edge_ids=excluding_edge_ids)[ref] > 0
