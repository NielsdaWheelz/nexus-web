"""Citation ownership: ordinals, the ``CitationOut`` read-model, concordance (§9.5).

An ordinal marks a citation (D5): the ordinal-bearing ``origin='citation'``
edges of one source output are its citation set, numbered densely. This module
is the single numbering owner and the single backend ``CitationOut`` producer;
``message_retrievals`` keeps telemetry and merely points back via
``cited_edge_id`` (D6).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast
from uuid import UUID

from sqlalchemy import select, text
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
from nexus.services.media_intelligence import get_ready_summaries
from nexus.services.resource_graph.edges import create_edge, replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    ConcordantSource,
    EdgeCreate,
    EdgeKind,
    EdgeOut,
    snapshot_from_jsonb,
)


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

    The LI promote calls this in the same transaction that moves
    ``current_revision_id`` (§5.5), so an artifact's citations swap with its
    content. Ordinals must be dense (1..N): the ``[N]`` markers in the stored
    prose depend on them.
    """
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


def build_citation_outs(db: Session, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]:
    """Build the shared ``CitationOut`` read-model from the source's citation edges.

    ``role`` is the edge kind and ``deep_link`` is lifted from the edge snapshot.
    The edge stores no locator (position lives in the target grain, D11); the
    in-reader jump ``(media_id, locator)`` is reconstructed here from the target's
    own anchoring (``reader_target_for_citation_target``), uniformly for chat,
    Oracle, and Library Intelligence (G6).

    Media-target chips also carry the LLM ``summary_md`` abstract (snapshot is
    display-only and stores no abstract, N6): it is reconstructed on read via
    ``media_intelligence.get_ready_summaries`` — batched once over all media
    targets of this source (no per-edge N+1) — applying the same freshness gate
    as the result-card enrichment. Non-media targets keep ``summary_md = None``.
    """
    rows = (
        db.execute(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.source_scheme == source.scheme,
                ResourceEdge.source_id == source.id,
                ResourceEdge.origin == "citation",
                ResourceEdge.ordinal.is_not(None),
            )
            .order_by(ResourceEdge.ordinal.asc())
        )
        .scalars()
        .all()
    )
    media_ids = sorted({row.target_id for row in rows if row.target_scheme == "media"})
    summaries = get_ready_summaries(db, media_ids=media_ids) if media_ids else {}
    return [_citation_out(db, viewer_id=viewer_id, row=row, summaries=summaries) for row in rows]


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


def _citation_out(
    db: Session,
    *,
    viewer_id: UUID,
    row: ResourceEdge,
    summaries: Mapping[UUID, str],
) -> CitationOut:
    assert row.ordinal is not None and row.snapshot is not None, (
        f"citation edge {row.id} lost its ordinal/snapshot pair"
    )
    snapshot = snapshot_from_jsonb(row.snapshot)
    target = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
    media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=target)
    # Only media-scheme targets carry the summary abstract; a content_chunk/span
    # whose parent happens to be media is a finer grain and does not (mirrors the
    # harness's "media targets only" rule, keyed by the media target id).
    summary_md = summaries.get(row.target_id) if row.target_scheme == "media" else None
    return CitationOut(
        ordinal=row.ordinal,
        role=cast("CitationRole", row.kind),
        target_ref=CitationTargetRef(
            type=cast("CitationTargetType", row.target_scheme),
            id=row.target_id,
        ),
        media_id=media_id,
        # Pydantic coerces the validated locator JSON into the RetrievalLocator union.
        locator=cast("RetrievalLocator | None", locator),
        deep_link=snapshot.deep_link,
        snapshot=CitationSnapshotOut(
            title=snapshot.title,
            excerpt=snapshot.excerpt,
            section_label=snapshot.section_label,
            result_type=snapshot.result_type,
            summary_md=summary_md,
        ),
    )
