"""Source-owned citations: one occurrence and both endpoints.

Imported and oracle sources store observed evidence with the occurrence. Imported owners
bind their occurrences to these rows; only their fenced completion may fill unknown
observations, and an oracle citation remains frozen. A message's citations are the local
projection of its retrieval targets: a sparse subset of the message's citation ordinals
(url targets have no edge), with no evidence. Their words are read live from the target.
Source authority admits the relationship, while evidence authority admits its words.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast
from uuid import UUID

from sqlalchemy import ColumnElement, String, and_, bindparam, false, or_, select, text, union_all
from sqlalchemy import cast as sql_cast
from sqlalchemy.orm import Session

from nexus.db.models import (
    DocumentEmbed,
    Fragment,
    ResourceEdge,
    XPostAlias,
    XPostCapture,
    XPostCaptureContext,
    XPostMedia,
    XThreadPost,
)
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.citation import CitationOut
from nexus.schemas.resource_evidence import CapturedEvidence
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.schemas.resource_items import CitationSourceTargetKey
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref

if TYPE_CHECKING:
    from nexus.services.resource_graph.edges import EdgeOut


@dataclass(frozen=True, slots=True)
class CitationInput:
    target: ResourceRef
    ordinal: int
    # None exactly for a message source.
    snapshot: CitationSnapshot | None


def generated_citation_source_visible_sql(edge_alias: str, viewer_bind: str = ":viewer_id") -> str:
    """Generated source authority only; safe inside the nonrecursive capture roots."""
    return f"""(
        ({edge_alias}.source_scheme='message' AND EXISTS (
            SELECT 1 FROM messages citation_message
            WHERE citation_message.id={edge_alias}.source_id
              AND citation_message.status<>'pending'
              AND citation_message.owner_user_id={viewer_bind}))
        OR ({edge_alias}.source_scheme='oracle_reading' AND EXISTS (
            SELECT 1 FROM oracle_readings citation_oracle
            WHERE citation_oracle.id={edge_alias}.source_id
              AND citation_oracle.user_id={viewer_bind})))"""


def citation_source_visible_sql(edge_alias: str, viewer_bind: str = ":viewer_id") -> str:
    """Authority of a citation's source, never authority obtained from its target."""
    from nexus.auth.permissions import visible_media_ids_cte_sql
    from nexus.services.x_source import readable_x_capture_ids_sql

    visible_media = visible_media_ids_cte_sql().replace(":viewer_id", viewer_bind)
    return f"""(
        {generated_citation_source_visible_sql(edge_alias, viewer_bind)}
        OR ({edge_alias}.source_scheme='media'
            AND {edge_alias}.source_id IN ({visible_media}))
        OR ({edge_alias}.source_scheme='fragment' AND EXISTS (
            SELECT 1 FROM fragments citation_source_fragment
            WHERE citation_source_fragment.id={edge_alias}.source_id
              AND citation_source_fragment.x_post_capture_id IN (
                {readable_x_capture_ids_sql(viewer_bind)}))))"""


def external_snapshot_visible_sql(snapshot_alias: str, viewer_bind: str = ":viewer_id") -> str:
    """A personal observation or a declared target of a readable source citation."""
    return f"""({snapshot_alias}.user_id={viewer_bind} OR EXISTS (
        SELECT 1 FROM resource_edges citation_external_ref
        WHERE citation_external_ref.target_scheme='external_snapshot'
          AND citation_external_ref.target_id={snapshot_alias}.id
          AND citation_external_ref.origin='citation'
          AND citation_external_ref.ordinal IS NOT NULL
          AND citation_external_ref.user_id IS NULL
          AND {edge_live_sql("citation_external_ref")}
          AND {citation_source_visible_sql("citation_external_ref", viewer_bind)}))"""


def edge_readable_filter(viewer_id: UUID) -> ColumnElement[bool]:
    """Shared graph admission: personal facts and source-owned ordinal citations."""
    return or_(
        and_(ResourceEdge.user_id == viewer_id, ResourceEdge.ordinal.is_(None)),
        and_(
            ResourceEdge.user_id.is_(None),
            ResourceEdge.origin == "citation",
            ResourceEdge.ordinal.is_not(None),
            text(citation_source_visible_sql("resource_edges")).bindparams(
                bindparam("viewer_id", viewer_id, unique=True)
            ),
        ),
    )


def citation_endpoint_match(
    refs: Sequence[ResourceRef], side: Literal["source", "target"]
) -> ColumnElement[bool]:
    """Additional citation incidence for exact evidence and primary X presentations.

    Outgoing membership uses only currently selected primary captures. Incoming
    membership follows a proved post identity; its evidence stays at the cited revision.
    No quoted context or article embed enrolls its parent as a post presentation.
    """
    matches: list[ColumnElement[bool]] = []
    media_ids = [ref.id for ref in refs if ref.scheme == "media"]
    evidence_owner = ResourceEdge.snapshot[("evidence", "target", "owner_ref")].astext
    completed_body = and_(
        evidence_owner.startswith("external_snapshot:"),
        ResourceEdge.snapshot[("evidence", "completion_ref")].astext.is_not(None),
    )
    if side == "target":
        fragment_refs = [ref.uri for ref in refs if ref.scheme == "fragment"]
        if fragment_refs:
            matches.append(
                or_(
                    evidence_owner.in_(fragment_refs),
                    and_(
                        completed_body,
                        ResourceEdge.snapshot[("evidence", "completion_ref")].astext.in_(
                            fragment_refs
                        ),
                    ),
                )
            )
    if media_ids:
        primary = union_all(
            select(XPostMedia.capture_id).where(XPostMedia.media_id.in_(media_ids)),
            select(XThreadPost.capture_id).where(XThreadPost.thread_media_id.in_(media_ids)),
        ).subquery("citation_primary")
        if side == "source":
            matches.append(
                and_(
                    ResourceEdge.source_scheme == "fragment",
                    select(Fragment.id)
                    .where(
                        Fragment.id == ResourceEdge.source_id,
                        Fragment.x_post_capture_id.in_(select(primary.c.capture_id)),
                    )
                    .correlate(ResourceEdge)
                    .exists(),
                )
            )
        else:
            primary_post_ids = select(XPostCapture.post_id).where(
                XPostCapture.id.in_(select(primary.c.capture_id))
            )
            target_capture = XPostCapture.__table__.alias("citation_target_capture")
            target_fragment = Fragment.__table__.alias("citation_target_fragment")
            matches.append(
                select(target_fragment.c.id)
                .join(
                    target_capture,
                    target_capture.c.id == target_fragment.c.x_post_capture_id,
                )
                .where(
                    target_capture.c.post_id.in_(primary_post_ids),
                    or_(
                        and_(
                            ResourceEdge.target_scheme == "fragment",
                            ResourceEdge.target_id == target_fragment.c.id,
                        ),
                        evidence_owner == "fragment:" + sql_cast(target_fragment.c.id, String),
                        and_(
                            completed_body,
                            ResourceEdge.snapshot[("evidence", "completion_ref")].astext
                            == "fragment:" + sql_cast(target_fragment.c.id, String),
                        ),
                    ),
                )
                .correlate(ResourceEdge)
                .exists()
            )
            quoted_revision = (
                select(XPostCaptureContext.referenced_revision_id)
                .where(XPostCaptureContext.citation_id == ResourceEdge.id)
                .correlate(ResourceEdge)
            )
            embedded_revision = (
                select(DocumentEmbed.provider_target_ref)
                .where(DocumentEmbed.citation_id == ResourceEdge.id)
                .correlate(ResourceEdge)
            )
            matches.append(
                select(XPostAlias.id)
                .where(
                    XPostAlias.post_id.in_(primary_post_ids),
                    or_(
                        XPostAlias.revision_id.in_(quoted_revision),
                        XPostAlias.revision_id.in_(embedded_revision),
                    ),
                )
                .correlate(ResourceEdge)
                .exists()
            )
    return (
        and_(ResourceEdge.origin == "citation", ResourceEdge.ordinal.is_not(None), or_(*matches))
        if matches
        else false()
    )


def replace_citations_for_source(
    db: Session,
    *,
    source: ResourceRef,
    citations: Sequence[CitationInput],
) -> list[EdgeOut]:
    """Publish one complete citation set; imported owners must first retire old bindings.

    Evidence-owning sources number their citations densely. A message passes its own
    citation ordinals, which also number its url citations, so its edges may skip."""
    from nexus.services.resource_graph.edges import EdgeCreate, replace_edges_for_origin

    ordinals = sorted(citation.ordinal for citation in citations)
    if source.scheme != "message" and ordinals != list(range(1, len(ordinals) + 1)):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Citation ordinals must be dense 1..{len(ordinals)}; got {ordinals}",
        )
    existing = select(ResourceEdge.id).where(
        ResourceEdge.source_scheme == source.scheme,
        ResourceEdge.source_id == source.id,
        ResourceEdge.origin == "citation",
        ResourceEdge.ordinal.is_not(None),
    )
    if source.scheme in ("media", "fragment") and (
        db.scalar(select(DocumentEmbed.id).where(DocumentEmbed.citation_id.in_(existing)).limit(1))
        or db.scalar(
            select(XPostCaptureContext.id)
            .where(XPostCaptureContext.citation_id.in_(existing))
            .limit(1)
        )
    ):
        raise RuntimeError("A bound source citation must be completed or retired by its occurrence")
    edges = [
        EdgeCreate(source, c.target, "context", "citation", ordinal=c.ordinal, snapshot=c.snapshot)
        for c in citations
    ]
    return replace_edges_for_origin(
        db, viewer_id=None, source=source, origin="citation", edges=edges
    )


def complete_citation_evidence(edge: ResourceEdge, observation: CapturedEvidence) -> bool:
    """Bind one immutable completion proof; caller locks and proves exact source authority.

    Original evidence remains intact. Reads admit this proof separately before
    projecting its null-only additions; copying evidence therefore keeps its proof.
    """
    if (
        edge.origin != "citation"
        or edge.ordinal is None
        or edge.source_scheme
        not in (
            "media",
            "fragment",
        )
    ):
        raise RuntimeError("Only bound imported citations may complete their evidence")
    snapshot = CitationSnapshot.model_validate(edge.snapshot)
    evidence = snapshot.evidence
    if (
        evidence is None
        or not (observation.target.owner_ref or "").startswith("fragment:")
        or observation.completion_ref is not None
    ):
        raise RuntimeError("Citation completion requires exact captured evidence")
    if evidence.completion_ref is not None:
        return False
    unknown_body = (evidence.target.owner_ref or "").startswith("external_snapshot:")
    if unknown_body and evidence.quote is not None:
        raise RuntimeError("An uncaptured imported reference cannot already contain a quote")
    source = evidence.source.model_dump()
    unknown_metadata = any(
        field != "ref" and source[field] is None and value is not None
        for field, value in observation.source.model_dump().items()
    )
    if not unknown_body and not unknown_metadata:
        return False
    completed = evidence.model_copy(update={"completion_ref": observation.target.owner_ref})
    edge.snapshot = CitationSnapshot(evidence=completed).model_dump(mode="json")
    return True


def build_citation_outs(db: Session, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]:
    return build_citation_outs_for_sources(db, viewer_id=viewer_id, sources=[source])[source.uri]


def build_citation_outs_for_sources(
    db: Session, *, viewer_id: UUID, sources: Sequence[ResourceRef]
) -> dict[str, list[CitationOut]]:
    """Each readable evidence-owning source's citations in source-local order.

    A message has no captured evidence to hydrate; its timeline owner presents its
    live retrieval targets."""
    if any(source.scheme == "message" for source in sources):
        raise ValueError("message citations are live references, not captured evidence")
    out: dict[str, list[CitationOut]] = {source.uri: [] for source in sources}
    if not sources:
        return out
    rows = db.scalars(
        select(ResourceEdge)
        .where(
            edge_readable_filter(viewer_id),
            ResourceEdge.origin == "citation",
            ResourceEdge.ordinal.is_not(None),
            or_(
                *(
                    and_(
                        ResourceEdge.source_scheme == source.scheme,
                        ResourceEdge.source_id == source.id,
                    )
                    for source in sources
                )
            ),
            text(edge_live_sql("resource_edges")),
        )
        .order_by(ResourceEdge.ordinal, ResourceEdge.id)
    ).all()
    for row, citation in zip(
        rows, citation_outs_for_rows(db, viewer_id=viewer_id, rows=rows), strict=True
    ):
        out[f"{row.source_scheme}:{row.source_id}"].append(citation)
    return out


def citation_outs_for_rows(
    db: Session, *, viewer_id: UUID, rows: Sequence[ResourceEdge]
) -> list[CitationOut]:
    """Hydrate already authorized evidence-owning rows without changing their order."""
    from nexus.services.resource_items.evidence import evidence_items

    occurrences = []
    for row in rows:
        snapshot = CitationSnapshot.model_validate(row.snapshot)
        assert snapshot.evidence is not None and row.ordinal is not None
        occurrences.append(
            (
                assert_resource_ref(f"{row.target_scheme}:{row.target_id}"),
                snapshot.evidence,
                CitationSourceTargetKey(edge_id=row.id, side="target"),
            )
        )
    items = evidence_items(db, viewer_id=viewer_id, occurrences=occurrences)
    return [
        CitationOut(edge_id=row.id, ordinal=cast(int, row.ordinal), item=item)
        for row, item in zip(rows, items, strict=True)
    ]
