"""Flush-only link materialization and exact preserving unlink; transactional commands.

Materialization and unlink compose inside their caller's transaction. Unlink removes
one owned user/discovery/assistant edge; an absent uuid succeeds without resolving a
replacement. Accepted authored identities retain their canonical binding across
retries and retirement. Every unlink preserves endpoint resources, note content
and creation history. The caller commits or rolls back its complete batch.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, ResourceEdge
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.resource_graph import (
    InsertionSource,
    LinkEndpoint,
    LinkPassageEndpoint,
    LinkResourceEndpoint,
)
from nexus.services import (
    authored_identities,
    highlights,
    notes,
    passage_anchors,
    pdf_highlights,
    writing,
)
from nexus.services.reader_publication import lock_publication_generation
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import visible_refs


def insertion_source_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef
) -> LinkEndpoint | None:
    """Read a visible endpoint's insertion owner without materializing a passage.

    The caller proves this current ref is visible. Exact candidate adjacency stays
    candidate-owned; a saved passage's child order belongs only to its durable anchor.
    A quote that no longer resolves retains its explicit candidate destination, so
    a later materialization can refuse without retargeting the document.
    """
    match capability(ref.scheme).link_mode:
        case "none":
            return None
        case "direct":
            return LinkResourceEndpoint(ref=ref.uri)
        case "materialize_passage":
            from nexus.services.search.pickers import source_identity

            try:
                _, anchor = source_identity(db, viewer_id, ref)
            except NotFoundError:
                # justify-ignore-error: an unavailable locator does not retarget its source.
                anchor = None
            return (
                LinkResourceEndpoint(ref=anchor.uri)
                if anchor is not None
                else LinkPassageEndpoint(candidate_ref=ref.uri)
            )


def materialize_source(
    db: Session, *, viewer_id: UUID, source: InsertionSource
) -> tuple[ResourceRef, bool]:
    """Materialize a frozen source inside its insertion transaction; never commits."""
    if source.kind == "resource" or source.kind == "passage":
        return materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=source), False
    if source.kind == "daily_page":
        existing = db.scalar(
            select(DailyPageBinding.page_id).where(
                DailyPageBinding.user_id == viewer_id,
                DailyPageBinding.local_date == source.local_date,
            )
        )
        return notes.ensure_daily_page(
            db, viewer_id, source.local_date, source.page_id
        ), existing is None
    if source.kind == "fragment_selection":
        result = highlights.create_fragment_highlight_in_txn(
            db,
            viewer_id=viewer_id,
            highlight_id=source.highlight_id,
            fragment_id=source.fragment_id,
            start_offset=source.start_offset,
            end_offset=source.end_offset,
            color=source.color,
            expected_reader_generation=source.expected_reader_generation,
        )
    else:
        assert_ref_visible(db, viewer_id=viewer_id, ref=ResourceRef("media", source.media_id))
        pdf_highlights.lock_pdf_highlight_write_or_404(db, source.media_id)
        if (
            lock_publication_generation(db, media_id=source.media_id)
            != source.expected_reader_generation
        ):
            raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
        result = pdf_highlights.create_pdf_highlight_in_txn(
            db,
            viewer_id=viewer_id,
            highlight_id=source.highlight_id,
            media_id=source.media_id,
            page_number=source.page_number,
            quads=[quad.model_dump() for quad in source.quads],
            exact=source.exact,
            color=source.color,
        )
    return ResourceRef("highlight", result.highlight.id), result.state == "created"


def unlink_in_txn(db: Session, *, viewer_id: UUID, link_id: UUID) -> bool:
    """Remove one exact owned user/discovery/assistant edge, preserving resources.

    Absent succeeds; foreign or unsupported origins conflict. Only flushes; the caller retries,
    notifies once if changed, and commits or rolls back the complete batch.
    """
    known = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=link_id)
    if known is not None:
        writing.identity(db, known.out())
        if known.deleted:
            return False
        link_id = known.canonical.resource_id
    row = db.get(ResourceEdge, link_id)
    if row is None:
        binding = authored_identities.retire(db, viewer_id=viewer_id, kind="link", id=link_id)
        writing.identity(db, binding.out())
        return False
    if row.user_id != viewer_id or row.origin not in ("user", "discovery", "assistant"):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "This connection cannot be removed")
    edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
    return True


def materialize_link_endpoint(
    db: Session, *, viewer_id: UUID, endpoint: LinkEndpoint
) -> ResourceRef:
    """A linkable ref for a resource (the writer checks it is visible), or a passage
    anchor minted or reused for a passage candidate. Only flushes."""
    if endpoint.kind == "resource":
        ref = require_ref(endpoint.ref)
        if capability(ref.scheme).link_mode != "direct":
            raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be linked")
        return ref
    from nexus.services.search.pickers import candidate_owner_and_quote

    candidate = require_ref(endpoint.candidate_ref)
    if capability(candidate.scheme).link_mode != "materialize_passage":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource is not a passage candidate")
    found = candidate_owner_and_quote(db, ref=candidate)
    if found is None:
        raise ConflictError(ApiErrorCode.E_LINK_TARGET_STALE, "Passage candidate no longer exists")
    owner, exact = found
    assert_ref_visible(db, viewer_id=viewer_id, ref=owner)
    anchor = passage_anchors.materialize_or_reuse(
        db, user_id=viewer_id, owner_scheme=owner.scheme, owner_id=owner.id, exact=exact
    )
    return ResourceRef("passage_anchor", anchor.id)


def count_retained_neutral_links(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Links created in the window whose two endpoints are still visible."""
    window = [ResourceEdge.created_at < end]
    if start is not None:
        window.append(ResourceEdge.created_at >= start)
    rows = db.execute(
        select(
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(ResourceEdge.user_id == viewer_id, ResourceEdge.origin == "user", *window)
    ).all()
    refs = [assert_resource_ref(f"{row[i]}:{row[i + 1]}") for row in rows for i in (0, 2)]
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)
    return sum(
        a.uri in visible and b.uri in visible for a, b in zip(refs[::2], refs[1::2], strict=True)
    )
