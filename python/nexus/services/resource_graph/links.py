"""Flush-only link endpoint materialization, machine-fact removal and link statistics.

A passage candidate with a captured ``passage_target`` materializes only where it was
captured: the candidate is recaptured through that reading owner and must name the
same owner, body identity and canonical extent, else it is stale (409); a candidate
the viewer cannot capture, gone or invisible, is a masked 404. Its anchor belongs to
that owner (a piece keeps its piece) and is an authored passage record. A null target
is the context-free canonical action: the viewer's current reading owner of the
candidate.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_evidence import CapturedPassageTarget
from nexus.schemas.resource_graph import LinkEndpoint
from nexus.services import passage_anchors
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.evidence import capture_evidence
from nexus.services.resource_items.items import visible_refs


def materialize_link_endpoint(
    db: Session, *, viewer_id: UUID, endpoint: LinkEndpoint
) -> ResourceRef:
    """A linkable ref for a resource (the writer checks it is visible), or the authored
    passage captured for a passage candidate. Only flushes."""
    if endpoint.kind == "resource":
        ref = require_ref(endpoint.ref)
        if capability(ref.scheme).link_mode != "direct":
            raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be linked")
        return ref
    candidate = require_ref(endpoint.candidate_ref)
    if capability(candidate.scheme).link_mode != "materialize_passage":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource is not a passage candidate")
    expected = endpoint.passage_target
    reading = None if expected is None else assert_resource_ref(expected.owner_ref)
    try:
        evidence = capture_evidence(
            db,
            viewer_id=viewer_id,
            ref=candidate,
            reading_media_id=None if reading is None or reading.scheme != "media" else reading.id,
        )
    except ConflictError as exc:
        raise ConflictError(ApiErrorCode.E_LINK_TARGET_STALE, "Passage candidate changed") from exc
    captured = evidence.target
    if (
        not isinstance(captured, CapturedPassageTarget)
        or evidence.quote is None
        or (expected is not None and _place(captured) != _place(expected))
    ):
        raise ConflictError(ApiErrorCode.E_LINK_TARGET_STALE, "Passage candidate changed")
    owner = assert_resource_ref(captured.owner_ref)
    assert_ref_visible(db, viewer_id=viewer_id, ref=owner)
    return passage_anchors.materialize_or_reuse(
        db,
        user_id=viewer_id,
        owner_scheme=owner.scheme,
        owner_id=owner.id,
        exact=evidence.quote.exact,
    )


def _place(target: CapturedPassageTarget) -> tuple[object, ...]:
    """Owner, body identity and canonical extent; quote context is presentation."""
    return (
        target.owner_ref,
        target.source_identity,
        target.locator.model_dump(mode="json", exclude={"text_quote_selector"}),
    )


def remove_machine_fact(db: Session, *, viewer_id: UUID, edge_id: UUID) -> bool:
    """Remove one owned discovery or assistant fact, preserving both endpoints.

    Absent succeeds; another owner's id, an authored link or any other origin conflicts.
    Flush-only; returns whether a fact went."""
    row = db.get(ResourceEdge, edge_id)
    if row is None:
        return False
    if row.user_id != viewer_id or row.origin not in ("discovery", "assistant"):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "This connection cannot be removed")
    edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    return True


def count_retained_neutral_links(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Live user links created in the window whose two endpoints are still visible."""
    window = [ResourceEdge.created_at < end]
    if start is not None:
        window.append(ResourceEdge.created_at >= start)
    rows = db.execute(
        select(
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            text(edge_live_sql("resource_edges")),
            *window,
        )
    ).all()
    refs = [assert_resource_ref(f"{row[i]}:{row[i + 1]}") for row in rows for i in (0, 2)]
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)
    return sum(
        a.uri in visible and b.uri in visible for a, b in zip(refs[::2], refs[1::2], strict=True)
    )
