"""Server reads of the highlight projection: reader maps, action facts and statistics.

A highlight is an independently identified authored annotation whose canonical
selection lives in ``authored_resources``; these rows are its projection. Readers
see only ``authored_visible`` highlights through the shared highlight predicates.
Overlapping highlights stay distinct and each lists its attached notes in its own
endpoint order. Projected changes invalidate the readable audience's document maps
through the media ``annotations`` lane that grants and libraries also bump. A missing fragment cache stays locator-less: relocation belongs to
the client that holds the saved quote, never to a server rewrite of the projection.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    highlight_readability_filter,
    highlight_readability_sql,
    highlight_visibility_filter,
    requested_media_ids_cte_sql,
    visible_media_ids_cte_sql,
)
from nexus.db.models import Fragment, Highlight, HighlightFragmentAnchor, HighlightPdfAnchor, Media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.highlights import (
    HIGHLIGHT_COLORS,
    FragmentAnchorOut,
    LinkedConversationRef,
    LinkedNoteBlockRef,
    PdfAnchorOut,
    PdfQuadOut,
    TypedHighlightOut,
)
from nexus.services import note_bodies
from nexus.services.media_text_scope import (
    highlight_in_reading_scope_sql,
    read_media_text_scope,
    text_scope_rows_sql,
)
from nexus.services.resource_grants import invalidate_annotation_visibility
from nexus.services.resource_graph.context import batch_conversations_with_any_edge_to_ref
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights

AFFIX_CODEPOINTS = 64


def _parent_media_id(highlight: Highlight) -> UUID:
    if highlight.anchor_media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight.anchor_media_id


@dataclass(frozen=True, slots=True)
class HighlightActionFacts:
    is_owner: bool
    edit_bounds_applicable: bool


def highlight_action_facts(
    db: Session, *, viewer_id: UUID, highlight_ids: list[UUID]
) -> dict[UUID, HighlightActionFacts]:
    """Action facts for readable highlights."""

    ordered = list(dict.fromkeys(highlight_ids))
    if not ordered:
        return {}
    rows = db.execute(
        select(Highlight.id, Highlight.user_id, Highlight.anchor_kind).where(
            Highlight.id.in_(ordered), highlight_readability_filter(viewer_id)
        )
    ).all()
    return {
        highlight_id: HighlightActionFacts(
            is_owner=user_id == viewer_id,
            edit_bounds_applicable=anchor_kind == "fragment_offsets",
        )
        for highlight_id, user_id, anchor_kind in rows
    }


@dataclass(frozen=True, slots=True)
class RecentHighlightAnchorFact:
    media_id: UUID
    activity_at: datetime


def count_retained_highlights(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Visible viewer-authored highlights over currently visible media."""
    return int(
        db.scalar(
            text(
                f"""
                SELECT count(*)
                FROM highlights h
                WHERE h.user_id = :viewer_id AND {highlight_readability_sql("h")}
                  AND (
                    CAST(:start AS timestamptz) IS NULL
                    OR h.created_at >= CAST(:start AS timestamptz)
                  )
                  AND h.created_at < :end
                """
            ),
            {"viewer_id": viewer_id, "start": start, "end": end},
        )
        or 0
    )


def recent_highlight_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentHighlightAnchorFact, ...]:
    """Newest distinct readable media the viewer's highlights touched."""
    if limit < 1:
        return ()
    rows = db.execute(
        text(f"""
            WITH readable AS ({visible_media_ids_cte_sql()}),
            newest_per_media AS (
                SELECT DISTINCT ON (owner.media_id) owner.media_id,h.updated_at AS activity_at
                FROM highlights h
                CROSS JOIN LATERAL (
                    SELECT reading.media_id FROM readable reading
                    WHERE reading.media_id=h.anchor_media_id
                       OR {highlight_in_reading_scope_sql("h.id", "reading.media_id")}
                    ORDER BY (reading.media_id=h.anchor_media_id) DESC,
                        (SELECT COALESCE(sum(scope.end_offset-scope.start_offset),0)
                         FROM ({text_scope_rows_sql("SELECT reading.media_id")}) scope),
                        reading.media_id
                    LIMIT 1
                ) owner
                WHERE h.user_id=:viewer_id AND h.authored_visible
                  AND h.anchor_kind IN ('fragment_offsets','pdf_page_geometry')
                ORDER BY owner.media_id,h.updated_at DESC,h.id ASC
            )
            SELECT media_id,activity_at FROM newest_per_media
            ORDER BY activity_at DESC,media_id ASC LIMIT :limit
        """),
        {"viewer_id": viewer_id, "limit": limit},
    ).mappings()
    return tuple(
        RecentHighlightAnchorFact(
            media_id=UUID(str(row["media_id"])), activity_at=row["activity_at"]
        )
        for row in rows
    )


def _anchor_out(highlight: Highlight) -> FragmentAnchorOut | PdfAnchorOut:
    pdf_anchor = highlight.pdf_anchor
    if highlight.anchor_kind == "pdf_page_geometry" and pdf_anchor is not None:
        return PdfAnchorOut(
            media_id=pdf_anchor.media_id,
            page_number=pdf_anchor.page_number,
            quads=[
                PdfQuadOut.model_validate(quad, from_attributes=True)
                for quad in sorted(highlight.pdf_quads, key=lambda quad: quad.quad_idx)
            ],
        )
    fragment_anchor = highlight.fragment_anchor
    if highlight.anchor_kind == "fragment_offsets" and fragment_anchor is not None:
        return FragmentAnchorOut(
            media_id=_parent_media_id(highlight),
            fragment_id=fragment_anchor.fragment_id,
            start_offset=fragment_anchor.start_offset,
            end_offset=fragment_anchor.end_offset,
        )
    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def annotations_changed(db: Session, highlight_ids: Iterable[UUID]) -> None:
    """Invalidate the document maps listing these highlights for their readable audience.

    The authored projection calls this under the account head for every projected
    highlight and every highlight endpoint of a projected link. The audience is the
    author, library peers of the author holding the media family, and the highlight's
    grant parties; each bumps every reading of the family they can read now. Only media
    readability is checked, so a deletion still reaches everyone who could read it.
    Flush-only; the wake publishes with the caller's commit.
    """
    pairs: set[tuple[UUID, UUID]] = set()
    for highlight in db.scalars(select(Highlight).where(Highlight.id.in_(set(highlight_ids)))):
        media_id = highlight.anchor_media_id
        if media_id is None:
            continue
        family = {media_id}
        family.update(
            db.scalars(
                text(f"""
            SELECT DISTINCT scope.reading_media_id
            FROM ({text_scope_rows_sql("SELECT id AS media_id FROM media")}) scope
            WHERE scope.source_media_id=:source
              AND {highlight_in_reading_scope_sql(":highlight", "scope.reading_media_id")}
        """),
                {"source": media_id, "highlight": highlight.id},
            )
        )
        audience = {highlight.user_id}
        audience.update(
            db.scalars(
                text("""
            SELECT DISTINCT peer.user_id FROM library_entries e
            JOIN libraries l ON l.id=e.library_id AND l.system_key IS NULL
            JOIN memberships author ON author.library_id=e.library_id AND author.user_id=:author
            JOIN memberships peer ON peer.library_id=e.library_id
            WHERE e.media_id=ANY(:family)
        """),
                {"author": highlight.user_id, "family": list(family)},
            )
        )
        for creator, grantee in db.execute(
            text("""
            SELECT created_by_user_id,grantee_user_id FROM resource_grants
            WHERE subject_scheme='highlight' AND subject_id=:id
        """),
            {"id": highlight.id},
        ):
            audience.add(creator)
            if grantee is not None:
                audience.add(grantee)
        pairs.update(
            (viewer, reading)
            for viewer in audience
            for reading in family
            if can_read_media(db, viewer, reading)
        )
    invalidate_annotation_visibility(db, pairs)


def _highlight_out(
    highlight: Highlight,
    viewer_id: UUID,
    anchor: FragmentAnchorOut | PdfAnchorOut,
    conversations: list[LinkedConversationRef],
    note_blocks: list[LinkedNoteBlockRef],
) -> TypedHighlightOut:
    return TypedHighlightOut(
        id=highlight.id,
        anchor=anchor,
        color=cast(HIGHLIGHT_COLORS, highlight.color),
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        created_at=highlight.created_at,
        updated_at=highlight.updated_at,
        author_user_id=highlight.user_id,
        is_owner=highlight.user_id == viewer_id,
        linked_conversations=conversations,
        linked_note_blocks=note_blocks,
    )


def _project_anchored(
    db: Session, viewer_id: UUID, anchored: list[tuple[Highlight, FragmentAnchorOut | PdfAnchorOut]]
) -> list[TypedHighlightOut]:
    from nexus.services.resource_items.items import resource_items_out

    ids = [highlight.id for highlight, _ in anchored]
    conversations = {
        highlight_id: [LinkedConversationRef(conversation_id=r.id, title=r.title) for r in rows]
        for highlight_id, rows in batch_conversations_with_any_edge_to_ref(
            db, viewer_id=viewer_id, targets=ids, target_scheme="highlight"
        ).items()
    }
    attached = linked_note_blocks_for_highlights(db, viewer_id, ids)
    embeds = {
        note.id: embed
        for links in attached.values()
        for _, note in links
        if (embed := note_bodies.sole_embed(note.body_pm_json)) is not None
    }
    items = {
        item.ref: item
        for item in resource_items_out(
            db, viewer_id=viewer_id, refs=list({ref.uri: ref for ref in embeds.values()}.values())
        )
    }
    notes = {
        highlight_id: [
            LinkedNoteBlockRef(
                link_id=link_id,
                note_block_id=note.id,
                body_pm_json=note.body_pm_json,
                body_text=note.body_text,
                embedded_item=items.get(embeds[note.id].uri) if note.id in embeds else None,
            )
            for link_id, note in links
        ]
        for highlight_id, links in attached.items()
    }
    contexts = {
        row.highlight_id: row
        for row in db.execute(
            text(f"""
            SELECT hfa.highlight_id,min(scope.start_offset) AS start_offset,
                   max(scope.end_offset) AS end_offset,f.canonical_text
            FROM highlight_fragment_anchors hfa
            JOIN ({text_scope_rows_sql(requested_media_ids_cte_sql())}) scope
              ON scope.fragment_id=hfa.fragment_id
             AND scope.start_offset<=hfa.start_offset AND scope.end_offset>=hfa.end_offset
            JOIN fragments f ON f.id=hfa.fragment_id
            WHERE hfa.highlight_id=ANY(:ids)
            GROUP BY hfa.highlight_id,f.canonical_text
        """),
            {"ids": ids, "viewer_id": viewer_id},
        )
    }
    projected = [
        _highlight_out(
            highlight,
            viewer_id,
            anchor,
            conversations.get(highlight.id, []),
            notes.get(highlight.id, []),
        )
        for highlight, anchor in anchored
    ]

    for item in projected:
        anchor = item.anchor
        if (
            not isinstance(anchor, FragmentAnchorOut)
            or anchor.start_offset is None
            or anchor.end_offset is None
        ):
            continue
        context = contexts.get(item.id)
        item.prefix = (
            context.canonical_text[
                max(
                    context.start_offset, anchor.start_offset - AFFIX_CODEPOINTS
                ) : anchor.start_offset
            ]
            if context is not None
            else ""
        )
        item.suffix = (
            context.canonical_text[
                anchor.end_offset : min(context.end_offset, anchor.end_offset + AFFIX_CODEPOINTS)
            ]
            if context is not None
            else ""
        )
    return projected


def project_highlights_with_links(
    db: Session, viewer_id: UUID, highlights: list[Highlight]
) -> list[TypedHighlightOut]:
    return _project_anchored(db, viewer_id, [(item, _anchor_out(item)) for item in highlights])


def list_highlights_for_media(
    db: Session, viewer_id: UUID, media_id: UUID, mine_only: bool = True
) -> list[TypedHighlightOut]:
    """PDF media yield geometry anchors; every other kind yields fragment anchors.

    Missing fragment caches stay locator-less; repair belongs to the preceding
    writable phase, never this snapshot.
    """
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    visible = (
        (Highlight.user_id == viewer_id) & Highlight.authored_visible
        if mine_only
        else highlight_visibility_filter(viewer_id)
    )

    if media.kind == "pdf":
        pdf_rows = db.scalars(
            select(Highlight)
            .join(HighlightPdfAnchor, Highlight.id == HighlightPdfAnchor.highlight_id)
            .where(
                HighlightPdfAnchor.media_id == media_id,
                Highlight.anchor_kind == "pdf_page_geometry",
                visible,
            )
            .order_by(
                HighlightPdfAnchor.page_number,
                HighlightPdfAnchor.sort_top,
                HighlightPdfAnchor.sort_left,
                Highlight.created_at,
                Highlight.id,
            )
        ).all()
        return project_highlights_with_links(db, viewer_id, list(pdf_rows))

    source_media_id = media_id
    scope = None
    if media.kind == "text_part":
        scope = read_media_text_scope(db, media_id)
        source_media_id = scope.source_media_id
    rows = db.execute(
        select(Highlight, Fragment.id)
        .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
        .outerjoin(Fragment, Fragment.id == HighlightFragmentAnchor.fragment_id)
        .where(
            Highlight.anchor_media_id == source_media_id,
            text(highlight_in_reading_scope_sql("highlights.id", f"'{media_id}'::uuid"))
            if scope is not None
            else text("TRUE"),
            Highlight.anchor_kind == "fragment_offsets",
            visible,
        )
        .order_by(
            Fragment.idx,  # NULLS LAST: unresolved highlights sort after resolved
            HighlightFragmentAnchor.start_offset,
            Highlight.created_at,
            Highlight.id,
        )
    ).all()
    unresolved = FragmentAnchorOut(
        media_id=media_id, fragment_id=None, start_offset=None, end_offset=None
    )
    projected = _project_anchored(
        db,
        viewer_id,
        [(item, unresolved if live is None else _anchor_out(item)) for item, live in rows],
    )
    if scope is not None:
        for item in projected:
            anchor = item.anchor
            if (
                not isinstance(anchor, FragmentAnchorOut)
                or anchor.fragment_id is None
                or anchor.start_offset is None
                or anchor.end_offset is None
            ):
                continue
            interval = next(
                value
                for value in scope.fragment_intervals
                if value.fragment_id == anchor.fragment_id
            )
            source = db.execute(
                select(Fragment.canonical_text).where(Fragment.id == anchor.fragment_id)
            ).scalar_one()
            item.prefix = source[
                max(
                    interval.start_offset, anchor.start_offset - AFFIX_CODEPOINTS
                ) : anchor.start_offset
            ]
            item.suffix = source[
                anchor.end_offset : min(interval.end_offset, anchor.end_offset + AFFIX_CODEPOINTS)
            ]
    return projected
