"""Citations: ordinal ``origin='citation'`` edges numbered by output markers ``[N]``.

Each edge preserves evidence captured before generation: words, attribution and
the intended source extent. Reads validate that extent against the readable source;
they never substitute current target words or location for the historical evidence.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.citation import CitationOut, CitationRole
from nexus.schemas.resource_graph import CitationSnapshot, EdgeKind
from nexus.schemas.resource_items import CitationSourceTargetKey
from nexus.services.resource_graph.edges import (
    EdgeCreate,
    EdgeOut,
    replace_edges_for_origin,
    source_is,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_items.evidence import evidence_items

_MARKER = re.compile(r"\[(\d+)\](?:\(([^)\n]*)\))?")


@dataclass(frozen=True, slots=True)
class CitationInput:
    target: ResourceRef
    ordinal: int
    kind: EdgeKind
    snapshot: CitationSnapshot


@dataclass(frozen=True, slots=True)
class GeneratedMarkdownCitationMarker:
    ordinal: int
    start: int
    end: int
    linked: bool


def replace_citations_for_output(
    db: Session, *, viewer_id: UUID, source: ResourceRef, citations: Sequence[CitationInput]
) -> list[EdgeOut]:
    """Replace the output's whole citation set; ordinals must be dense 1..N. The edges
    come back in input order."""
    ordinals = sorted(citation.ordinal for citation in citations)
    if ordinals != list(range(1, len(ordinals) + 1)):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Citation ordinals must be dense 1..{len(ordinals)}; got {ordinals}",
        )
    edges = [
        EdgeCreate(source, c.target, c.kind, "citation", ordinal=c.ordinal, snapshot=c.snapshot)
        for c in citations
    ]
    return replace_edges_for_origin(
        db, viewer_id=viewer_id, source=source, origin="citation", edges=edges
    )


def parse_generated_markdown_citation_markers(
    content_md: str,
) -> tuple[GeneratedMarkdownCitationMarker, ...]:
    """Every ``[N]`` and ``[N](...)`` marker in generated markdown."""
    return tuple(
        GeneratedMarkdownCitationMarker(
            int(match.group(1)), match.start(), match.end(), match.group(2) is not None
        )
        for match in _MARKER.finditer(content_md)
    )


def build_citation_outs(db: Session, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]:
    return build_citation_outs_for_sources(
        db, viewer_id=viewer_id, edge_owner_id=viewer_id, sources=[source]
    )[source.uri]


def build_citation_outs_for_sources(
    db: Session, *, viewer_id: UUID, edge_owner_id: UUID, sources: Sequence[ResourceRef]
) -> dict[str, list[CitationOut]]:
    """Each output's citations in ordinal order. The edges may belong to another user (a
    shared chat's owner); visibility and the jump are the viewer's."""
    out: dict[str, list[CitationOut]] = {source.uri: [] for source in sources}
    if not sources:
        return out
    rows = db.scalars(
        select(ResourceEdge)
        .where(
            ResourceEdge.user_id == edge_owner_id,
            ResourceEdge.origin == "citation",
            ResourceEdge.ordinal.is_not(None),
            or_(*(source_is(source) for source in sources)),
        )
        .order_by(ResourceEdge.ordinal)
    ).all()
    citations = _citation_outs(
        db,
        viewer_id,
        [
            (
                row.id,
                assert_resource_ref(f"{row.target_scheme}:{row.target_id}"),
                cast(int, row.ordinal),
                cast(CitationRole, row.kind),
                CitationSnapshot.model_validate(row.snapshot),
            )
            for row in rows
        ],
    )
    for row, citation in zip(rows, citations, strict=True):
        out[f"{row.source_scheme}:{row.source_id}"].append(citation)
    return out


def citation_counts_for_sources(
    db: Session, *, source_scheme: ResourceScheme, source_ids: Sequence[UUID]
) -> dict[UUID, int]:
    if not source_ids:
        return {}
    rows = db.execute(
        text("""
        SELECT source_id, count(*) FROM resource_edges
        WHERE source_scheme = :scheme AND source_id = ANY(:ids)
          AND origin = 'citation' AND ordinal IS NOT NULL
        GROUP BY source_id
        """),
        {"scheme": source_scheme, "ids": list(set(source_ids))},
    ).all()
    return {source_id: count for source_id, count in rows}


def _citation_outs(
    db: Session,
    viewer_id: UUID,
    facts: list[tuple[UUID, ResourceRef, int, CitationRole, CitationSnapshot]],
) -> list[CitationOut]:
    occurrences = []
    for edge_id, target, _, _, snapshot in facts:
        assert snapshot.evidence is not None
        occurrences.append((target, snapshot.evidence, CitationSourceTargetKey(edge_id=edge_id)))
    items = evidence_items(db, viewer_id=viewer_id, occurrences=occurrences)
    return [
        CitationOut(edge_id=edge_id, ordinal=ordinal, role=role, item=item)
        for (edge_id, _, ordinal, role, _), item in zip(facts, items, strict=True)
    ]
