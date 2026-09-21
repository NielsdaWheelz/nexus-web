"""Citation ordinals: the single numbering owner and the single ``CitationOut`` producer.

An ordinal marks a citation: the ordinal-bearing ``origin='citation'`` edges of one
source output are its citation set, numbered densely 1..N because the stored prose
carries ``[N]`` markers. The edge stores no locator — position lives in the target — so
the in-reader jump is reconstructed on read from the target's own anchoring.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import and_, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.citation import (
    CitationOut,
    CitationRole,
    CitationTargetRef,
    CitationTargetType,
)
from nexus.schemas.citation import CitationSnapshot as CitationSnapshotOut
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.media_intelligence import MediaProjection, read_batch
from nexus.services.resource_graph.edges import create_edge, replace_edges_for_origin
from nexus.services.resource_graph.reader_targets import reader_target_for_citation_target
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    CitationTargetProjection,
    ConcordantSource,
    EdgeCreate,
    EdgeKind,
    EdgeOut,
    snapshot_from_jsonb,
)
from nexus.services.resource_items.routing import resource_activations_for_refs

_MARKDOWN_CITATION_MARKER_RE = re.compile(r"\[(\d+)\](?:\(([^)\n]*)\))?")


@dataclass(frozen=True, slots=True)
class GeneratedMarkdownCitationMarker:
    ordinal: int
    start: int
    end: int
    linked: bool


def record_citation(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
    ordinal: int,
    kind: EdgeKind,
    snapshot: CitationSnapshot,
) -> EdgeOut:
    """Write one citation edge inside the caller's transaction."""
    return create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=source,
            target=target,
            kind=kind,
            origin="citation",
            ordinal=ordinal,
            snapshot=snapshot,
        ),
    )


def replace_citations_for_output(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    citations: Sequence[CitationInput],
) -> list[EdgeOut]:
    """Replace the source's whole citation set atomically; ordinals must be dense 1..N."""
    ordinals = sorted(citation.ordinal for citation in citations)
    if ordinals != list(range(1, len(ordinals) + 1)):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Citation ordinals must be dense 1..{len(ordinals)}; got {ordinals}",
        )
    return replace_edges_for_origin(
        db,
        viewer_id=viewer_id,
        source=source,
        origin="citation",
        edges=[
            EdgeCreate(
                source=source,
                target=citation.target,
                kind=citation.kind,
                origin="citation",
                ordinal=citation.ordinal,
                snapshot=citation.snapshot,
            )
            for citation in citations
        ],
    )


def parse_generated_markdown_citation_markers(
    content_md: str,
) -> tuple[GeneratedMarkdownCitationMarker, ...]:
    """Parse generated ``[N]`` and ``[N](...)`` citation marker occurrences."""
    return tuple(
        GeneratedMarkdownCitationMarker(
            ordinal=int(match.group(1)),
            start=match.start(),
            end=match.end(),
            linked=match.group(2) is not None,
        )
        for match in _MARKDOWN_CITATION_MARKER_RE.finditer(content_md)
    )


def build_citation_outs(db: Session, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]:
    return build_citation_outs_for_sources(
        db, viewer_id=viewer_id, edge_owner_id=viewer_id, sources=[source]
    ).get(source.uri, [])


def build_citation_outs_for_sources(
    db: Session,
    *,
    viewer_id: UUID,
    edge_owner_id: UUID,
    sources: Sequence[ResourceRef],
) -> dict[str, list[CitationOut]]:
    """Batch-build the ``CitationOut`` list per source, in ordinal order.

    Edge ownership is not always the current reader: a shared conversation stores its
    citation edges under the conversation owner, while jump hydration still uses the
    current viewer's visibility. Media targets carry the LLM ``summary_md`` abstract,
    batched once over all media targets rather than per edge.
    """
    unique_sources = list({source.uri: source for source in sources}.values())
    out: dict[str, list[CitationOut]] = {source.uri: [] for source in unique_sources}
    if not unique_sources:
        return out

    rows = list(
        db.scalars(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == edge_owner_id,
                ResourceEdge.origin == "citation",
                ResourceEdge.ordinal.is_not(None),
                or_(
                    *[
                        and_(
                            ResourceEdge.source_scheme == source.scheme,
                            ResourceEdge.source_id == source.id,
                        )
                        for source in unique_sources
                    ]
                ),
            )
            .order_by(
                ResourceEdge.source_scheme, ResourceEdge.source_id, ResourceEdge.ordinal.asc()
            )
        )
    )
    media_ids = sorted({row.target_id for row in rows if row.target_scheme == "media"})
    summaries = read_batch(db, media_ids=media_ids) if media_ids else {}
    target_refs = list(
        {
            f"{row.target_scheme}:{row.target_id}": ResourceRef(
                scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id
            )
            for row in rows
        }.values()
    )
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=target_refs)
    missing_uris = {
        ref.uri for ref, item in zip(target_refs, resolved, strict=True) if item.missing
    }
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=target_refs, missing_ref_uris=missing_uris
    )
    projections = citation_reader_targets_for_edges(
        db,
        viewer_id=viewer_id,
        edges=rows,
        target_missing_ref_uris=missing_uris,
        target_routeable_ref_uris={
            uri for uri, activation in activations.items() if activation.href is not None
        },
    )
    for row in rows:
        out.setdefault(f"{row.source_scheme}:{row.source_id}", []).append(
            _citation_out(
                row=row,
                projection=projections[row.id],
                activation=activations[f"{row.target_scheme}:{row.target_id}"],
                summaries=summaries,
            )
        )
    return out


def citation_counts_for_sources(
    db: Session, *, source_scheme: ResourceScheme, source_ids: Sequence[UUID]
) -> dict[UUID, int]:
    ordered = list(dict.fromkeys(source_ids))
    if not ordered:
        return {}
    rows = (
        db.execute(
            text(
                """
                SELECT source_id, count(*) AS citation_count
                FROM resource_edges
                WHERE source_scheme = :source_scheme
                  AND source_id = ANY(:source_ids)
                  AND origin = 'citation'
                  AND ordinal IS NOT NULL
                GROUP BY source_id
                """
            ),
            {"source_scheme": source_scheme, "source_ids": ordered},
        )
        .mappings()
        .all()
    )
    return {UUID(str(row["source_id"])): int(row["citation_count"]) for row in rows}


def citation_reader_targets_for_edges(
    db: Session,
    *,
    viewer_id: UUID,
    edges: Sequence[ResourceEdge],
    target_missing_ref_uris: set[str],
    target_routeable_ref_uris: set[str],
) -> dict[UUID, CitationTargetProjection]:
    """Project each unique readable citation target once for a page of edges.

    Endpoint hydration owns visibility and routeability; this only deduplicates repeated
    targets and asks ``reader_target_for_citation_target`` for the jump.
    """
    citation_edges = [
        (edge, edge.ordinal)
        for edge in edges
        if edge.origin == "citation" and edge.ordinal is not None
    ]
    targets = {
        f"{edge.target_scheme}:{edge.target_id}": ResourceRef(
            scheme=cast("ResourceScheme", edge.target_scheme), id=edge.target_id
        )
        for edge, _ in citation_edges
    }
    reader_targets = {
        uri: (
            (None, None)
            if uri in target_missing_ref_uris
            else reader_target_for_citation_target(db, viewer_id=viewer_id, target=target)
        )
        for uri, target in targets.items()
    }
    out: dict[UUID, CitationTargetProjection] = {}
    for edge, ordinal in citation_edges:
        uri = f"{edge.target_scheme}:{edge.target_id}"
        media_id, locator = reader_targets[uri]
        out[edge.id] = CitationTargetProjection(
            ordinal=ordinal,
            role=cast("EdgeKind", edge.kind),
            snapshot=snapshot_from_jsonb(edge.snapshot or {}),
            media_id=media_id,
            locator=locator,
            target_status=(
                "missing"
                if uri in target_missing_ref_uris
                else (
                    "current"
                    if media_id is not None
                    or locator is not None
                    or uri in target_routeable_ref_uris
                    else "unanchorable"
                )
            ),
        )
    return out


def concordant_sources(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    source_scheme: ResourceScheme,
) -> list[ConcordantSource]:
    """Other ``source_scheme`` outputs citing a target this source also cites.

    Concordance is identity equality on ``(target_scheme, target_id)``; locators and
    snapshots are deliberately out of the key.
    """
    rows = db.execute(
        text(
            """
            SELECT e2.source_id,
                   COUNT(DISTINCT (e2.target_scheme, e2.target_id)) AS shared_targets
            FROM resource_edges e1
            JOIN resource_edges e2
              ON e2.target_scheme = e1.target_scheme
             AND e2.target_id = e1.target_id
            WHERE e1.user_id = :viewer_id
              AND e1.source_scheme = :source_scheme
              AND e1.source_id = :source_id
              AND e1.origin = 'citation'
              AND e1.ordinal IS NOT NULL
              AND e2.user_id = :viewer_id
              AND e2.source_scheme = :other_source_scheme
              AND e2.origin = 'citation'
              AND e2.ordinal IS NOT NULL
              AND NOT (
                  e2.source_scheme = :source_scheme AND e2.source_id = :source_id
              )
            GROUP BY e2.source_id
            ORDER BY shared_targets DESC, e2.source_id ASC
            """
        ),
        {
            "viewer_id": viewer_id,
            "source_scheme": source.scheme,
            "source_id": source.id,
            "other_source_scheme": source_scheme,
        },
    ).fetchall()
    return [
        ConcordantSource(
            source=ResourceRef(scheme=source_scheme, id=row[0]), shared_target_count=int(row[1])
        )
        for row in rows
    ]


def _citation_out(
    *,
    row: ResourceEdge,
    projection: CitationTargetProjection,
    activation: ResourceActivationOut,
    summaries: Mapping[UUID, MediaProjection],
) -> CitationOut:
    # Only media-scheme targets carry the summary abstract; a chunk or span whose parent
    # happens to be media is a finer grain and does not.
    media_projection = summaries.get(row.target_id) if row.target_scheme == "media" else None
    return CitationOut(
        ordinal=projection.ordinal,
        role=cast("CitationRole", projection.role),
        target_ref=CitationTargetRef(
            type=cast("CitationTargetType", row.target_scheme), id=row.target_id
        ),
        activation=activation,
        media_id=projection.media_id,
        # Pydantic coerces the validated locator JSON into the RetrievalLocator union.
        locator=cast("RetrievalLocator | None", projection.locator),
        deep_link=projection.snapshot.deep_link,
        snapshot=CitationSnapshotOut(
            title=projection.snapshot.title,
            excerpt=projection.snapshot.excerpt,
            section_label=projection.snapshot.section_label,
            result_type=projection.snapshot.result_type,
            summary_md=media_projection.summary_md if media_projection is not None else None,
        ),
    )
