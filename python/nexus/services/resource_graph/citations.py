"""Citation ownership: ordinals, the ``CitationOut`` read-model, concordance (§9.5).

An ordinal marks a citation (D5): the ordinal-bearing ``origin='citation'``
edges of one source output are its citation set, numbered densely. This module
is the single numbering owner and the single backend ``CitationOut`` producer;
``message_retrievals`` keeps telemetry and merely points back via
``cited_edge_id`` (D6).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
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
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.media_intelligence import MediaProjection, read_batch
from nexus.services.resource_graph.edges import create_edge, replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target, resolve_ref
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
from nexus.services.resource_items.routing import resource_activation_for_ref

_MARKDOWN_CITATION_MARKER_RE = re.compile(r"\[(\d+)\](?!\()")
_MARKDOWN_LINKED_CITATION_MARKER_RE = re.compile(r"\[(\d+)\]\(")


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
    """Write one citation edge inside the caller's transaction (chat/Oracle write-through)."""
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
    """Replace the source's citation set atomically inside the caller's transaction.

    Ordinals must be dense (1..N): the ``[N]`` markers in the stored prose depend
    on them.
    """
    _dense_citation_ordinals(citations)
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


def validate_generated_markdown_citations(
    content_md: str,
    citations: Sequence[CitationInput],
) -> None:
    """Validate generated prose markers against the citation-edge input set."""
    citation_ordinals = _dense_citation_ordinals(citations)
    marker_ordinals = generated_markdown_citation_ordinals(content_md)
    if marker_ordinals != citation_ordinals:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Generated markdown citation markers must match citation ordinals exactly; "
            f"markers={marker_ordinals}, citations={citation_ordinals}",
        )


def generated_markdown_citation_ordinals(content_md: str) -> list[int]:
    """Return plain generated citation markers; reject linked marker syntax."""
    linked_marker_ordinals = sorted(
        {int(match.group(1)) for match in _MARKDOWN_LINKED_CITATION_MARKER_RE.finditer(content_md)}
    )
    if linked_marker_ordinals:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Generated markdown citation markers must be plain [N] markers, not links; "
            f"linked_markers={linked_marker_ordinals}",
        )
    return sorted(
        {int(match.group(1)) for match in _MARKDOWN_CITATION_MARKER_RE.finditer(content_md)}
    )


def build_citation_outs(db: Session, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]:
    """Build the shared ``CitationOut`` read-model from the source's citation edges.

    ``role`` is the edge kind and ``deep_link`` is lifted from the edge snapshot.
    The edge stores no locator (position lives in the target grain, D11); the
    in-reader jump ``(media_id, locator)`` is reconstructed here from the target's
    own anchoring (``reader_target_for_citation_target``), uniformly for chat,
    Oracle, and Library Intelligence (G6).

    Media-target chips also carry the LLM ``summary_md`` abstract (snapshot is
    display-only and stores no abstract, N6): it is reconstructed on read via
    ``media_intelligence.read_batch`` — batched once over all media targets of this
    source (no per-edge N+1) — applying the same freshness gate as the result-card
    enrichment. Non-media targets keep ``summary_md = None``.
    """
    return build_citation_outs_for_sources(
        db,
        viewer_id=viewer_id,
        edge_owner_id=viewer_id,
        sources=[source],
    ).get(source.uri, [])


def build_citation_outs_for_sources(
    db: Session,
    *,
    viewer_id: UUID,
    edge_owner_id: UUID,
    sources: Sequence[ResourceRef],
) -> dict[str, list[CitationOut]]:
    """Batch-build ``CitationOut`` lists for sources.

    Citation edge ownership is not always the same as the current reader:
    shared conversations store citation edges under the conversation owner, while
    target jump hydration still uses the current viewer's visibility.
    """
    unique_sources = list({source.uri: source for source in sources}.values())
    out = {source.uri: [] for source in unique_sources}
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
                ResourceEdge.source_scheme,
                ResourceEdge.source_id,
                ResourceEdge.ordinal.asc(),
            )
        )
    )
    media_ids = sorted({row.target_id for row in rows if row.target_scheme == "media"})
    summaries = read_batch(db, media_ids=media_ids) if media_ids else {}
    for row in rows:
        source_uri = f"{row.source_scheme}:{row.source_id}"
        out.setdefault(source_uri, []).append(
            _citation_out(db, viewer_id=viewer_id, row=row, summaries=summaries)
        )
    return out


def citation_reader_target_for_edge(
    db: Session,
    *,
    viewer_id: UUID,
    edge: ResourceEdge,
) -> CitationTargetProjection:
    """Project one citation edge through the same target-owned reader jump logic."""
    assert edge.ordinal is not None and edge.snapshot is not None, (
        f"citation edge {edge.id} lost its ordinal/snapshot pair"
    )
    target = ResourceRef(scheme=cast("ResourceScheme", edge.target_scheme), id=edge.target_id)
    media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=target)
    resolved = resolve_ref(db, viewer_id=viewer_id, ref=target)
    if resolved.missing:
        target_status = "missing"
    elif media_id is not None or locator is not None:
        target_status = "current"
    elif resource_activation_for_ref(db, viewer_id=viewer_id, ref=target).href is not None:
        target_status = "current"
    else:
        target_status = "unanchorable"
    return CitationTargetProjection(
        ordinal=edge.ordinal,
        role=cast("EdgeKind", edge.kind),
        snapshot=snapshot_from_jsonb(edge.snapshot),
        media_id=media_id,
        locator=locator,
        target_status=target_status,
    )


def citation_reader_targets_for_edges(
    db: Session,
    *,
    viewer_id: UUID,
    edges: Sequence[ResourceEdge],
    target_missing_ref_uris: set[str],
    target_routeable_ref_uris: set[str],
) -> dict[UUID, CitationTargetProjection]:
    """Project each unique readable citation target once for a graph page.

    Endpoint hydration already owns visibility and routeability. Locator
    resolution remains entirely in reader_target_for_citation_target; this seam
    only deduplicates repeated targets and avoids resolving endpoint state again.
    """

    citation_edges = [
        edge for edge in edges if edge.origin == "citation" and edge.ordinal is not None
    ]
    targets = {
        f"{edge.target_scheme}:{edge.target_id}": ResourceRef(
            scheme=cast("ResourceScheme", edge.target_scheme),
            id=edge.target_id,
        )
        for edge in citation_edges
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
    for edge in citation_edges:
        assert edge.ordinal is not None and edge.snapshot is not None, (
            f"citation edge {edge.id} lost its ordinal/snapshot pair"
        )
        uri = f"{edge.target_scheme}:{edge.target_id}"
        media_id, locator = reader_targets[uri]
        target_status = (
            "missing"
            if uri in target_missing_ref_uris
            else (
                "current"
                if media_id is not None or locator is not None or uri in target_routeable_ref_uris
                else "unanchorable"
            )
        )
        out[edge.id] = CitationTargetProjection(
            ordinal=edge.ordinal,
            role=cast("EdgeKind", edge.kind),
            snapshot=snapshot_from_jsonb(edge.snapshot),
            media_id=media_id,
            locator=locator,
            target_status=target_status,
        )
    return out


def concordant_sources(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    source_scheme: ResourceScheme,
) -> list[ConcordantSource]:
    """Other ``source_scheme`` outputs citing a target this source also cites (§5.3).

    Concordance is identity equality on ``(target_scheme, target_id)`` —
    locators and snapshots are deliberately excluded from the key.
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
            source=ResourceRef(scheme=source_scheme, id=row[0]),
            shared_target_count=int(row[1]),
        )
        for row in rows
    ]


def _dense_citation_ordinals(citations: Sequence[CitationInput]) -> list[int]:
    ordinals = sorted(citation.ordinal for citation in citations)
    if ordinals != list(range(1, len(ordinals) + 1)):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Citation ordinals must be dense 1..{len(ordinals)}; got {ordinals}",
        )
    return ordinals


def _citation_out(
    db: Session,
    *,
    viewer_id: UUID,
    row: ResourceEdge,
    summaries: Mapping[UUID, MediaProjection],
) -> CitationOut:
    projection = citation_reader_target_for_edge(db, viewer_id=viewer_id, edge=row)
    target_ref = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
    # Only media-scheme targets carry the summary abstract; a content_chunk/span
    # whose parent happens to be media is a finer grain and does not (mirrors the
    # harness's "media targets only" rule, keyed by the media target id).
    media_projection = summaries.get(row.target_id) if row.target_scheme == "media" else None
    summary_md = media_projection.summary_md if media_projection is not None else None
    return CitationOut(
        ordinal=projection.ordinal,
        role=cast("CitationRole", projection.role),
        target_ref=CitationTargetRef(
            type=cast("CitationTargetType", row.target_scheme),
            id=row.target_id,
        ),
        activation=resource_activation_for_ref(
            db,
            viewer_id=viewer_id,
            ref=target_ref,
            missing=projection.target_status == "missing",
        ),
        media_id=projection.media_id,
        # Pydantic coerces the validated locator JSON into the RetrievalLocator union.
        locator=cast("RetrievalLocator | None", projection.locator),
        deep_link=projection.snapshot.deep_link,
        snapshot=CitationSnapshotOut(
            title=projection.snapshot.title,
            excerpt=projection.snapshot.excerpt,
            section_label=projection.snapshot.section_label,
            result_type=projection.snapshot.result_type,
            summary_md=summary_md,
        ),
    )
