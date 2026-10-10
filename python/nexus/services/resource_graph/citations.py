"""Citations: the ordinal ``origin='citation'`` edges of a generated output, numbered 1..N
because its prose carries ``[N]``. The edge stores no locator; the jump is recomputed
from the target on read, and a dead target keeps its chip (snapshot) and fails closed.
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
from nexus.schemas.citation import CitationOut, CitationRole, CitationSnapshotOut, CitationTargetRef
from nexus.schemas.resource_graph import CitationSnapshot, EdgeKind
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.media_intelligence import read_batch
from nexus.services.resource_graph.edges import (
    EdgeCreate,
    EdgeOut,
    replace_edges_for_origin,
    source_is,
)
from nexus.services.resource_graph.reader_targets import reader_target_for_citation_target
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_items.routing import resource_activations_for_refs

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


def hydrate_citation(
    db: Session,
    *,
    viewer_id: UUID,
    target: ResourceRef,
    ordinal: int,
    role: CitationRole,
    deep_link: str | None,
    snapshot: CitationSnapshotOut | None,
) -> CitationOut:
    """Current visibility and jump for a citation saved outside the graph, with the
    caller's snapshot; writes nothing."""
    stored = CitationSnapshot(deep_link=deep_link)
    citation = _citation_outs(db, viewer_id, [(target, ordinal, role, stored)])[0]
    return citation.model_copy(update={"snapshot": snapshot})


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
    facts: list[tuple[ResourceRef, int, CitationRole, CitationSnapshot]],
) -> list[CitationOut]:
    """The one citation hydration: visibility, activation, jump and, for a media
    target, its summary abstract, each looked up once per distinct target."""
    targets = list({target.uri: target for target, *_ in facts}.values())
    resolved = resolve_refs(
        db, viewer_id=viewer_id, refs=targets, include_media_document_summary=False
    )
    missing = {item.uri for item in resolved if item.missing}
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=targets, missing_ref_uris=missing
    )
    jumps = {
        target.uri: (None, None)
        if target.uri in missing
        else reader_target_for_citation_target(db, viewer_id=viewer_id, target=target)
        for target in targets
    }
    # Only a media target carries the abstract; a span or chunk of it does not.
    media_ids = [target.id for target in targets if target.scheme == "media"]
    summaries = read_batch(db, media_ids=media_ids) if media_ids else {}
    out = []
    for target, ordinal, role, snapshot in facts:
        media_id, locator = jumps[target.uri]
        summary = summaries.get(target.id) if target.scheme == "media" else None
        out.append(
            CitationOut(
                ordinal=ordinal,
                role=role,
                target_ref=CitationTargetRef(type=target.scheme, id=target.id),
                activation=activations[target.uri],
                media_id=media_id,
                # Pydantic validates the stored locator json into the union.
                locator=cast("RetrievalLocator | None", locator),
                deep_link=snapshot.deep_link,
                snapshot=CitationSnapshotOut(
                    title=snapshot.title,
                    excerpt=snapshot.excerpt,
                    section_label=snapshot.section_label,
                    result_type=snapshot.result_type,
                    summary_md=summary.summary_md if summary is not None else None,
                ),
            )
        )
    return out
