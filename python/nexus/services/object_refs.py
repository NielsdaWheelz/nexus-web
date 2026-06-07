"""Hydration for universal object refs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    visible_content_credit_rows_sql,
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    Conversation,
    Fragment,
    Highlight,
    Media,
    Message,
    NoteBlock,
    Page,
    PinnedObjectRef,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    OBJECT_TYPES,
    HydratedObjectRef,
    ObjectRef,
    PinnedObjectRefOut,
)
from nexus.services.contributors import hydrate_contributor_object_ref
from nexus.services.note_block_markdown import (
    note_outline_markdown,
    ordered_note_blocks_for_page,
)


@dataclass(frozen=True)
class PinObjectRefInput:
    object_ref: ObjectRef
    surface_key: str = "navbar"
    order_key: str | None = None


@dataclass(frozen=True)
class UpdatePinnedObjectRefPatch:
    surface_key: str | None = None
    order_key: str | None = None


def hydrate_object_ref(db: Session, viewer_id: UUID, ref: ObjectRef) -> HydratedObjectRef:
    if ref.object_type == "page":
        page = db.get(Page, ref.object_id)
        if page is None or page.user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="page",
            object_id=page.id,
            label=page.title,
            snippet=page.description,
            route=f"/pages/{page.id}",
            icon="file-text",
        )

    if ref.object_type == "note_block":
        block = db.get(NoteBlock, ref.object_id)
        if block is None or block.user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        label = block.body_text.strip().splitlines()[0][:120] if block.body_text.strip() else "Note"
        return HydratedObjectRef(
            object_type="note_block",
            object_id=block.id,
            label=label,
            snippet=block.body_text[:300],
            route=f"/notes/{block.id}",
            icon="list",
        )

    if ref.object_type == "media":
        media = db.get(Media, ref.object_id)
        if media is None or not can_read_media(db, viewer_id, media.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="media",
            object_id=media.id,
            label=media.title,
            snippet=media.description,
            route=f"/media/{media.id}",
            icon="book-open",
        )

    if ref.object_type == "highlight":
        highlight = db.get(Highlight, ref.object_id)
        if highlight is None or highlight.anchor_media_id is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        if not can_read_highlight(db, viewer_id, highlight.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="highlight",
            object_id=highlight.id,
            label=highlight.exact[:120] or "Highlight",
            snippet=highlight.exact,
            route=f"/media/{highlight.anchor_media_id}#highlight-{highlight.id}",
            icon="highlighter",
        )

    if ref.object_type == "conversation":
        row = db.execute(
            text("SELECT id, title FROM conversations WHERE id = :id"),
            {"id": ref.object_id},
        ).fetchone()
        if row is None or not can_read_conversation(db, viewer_id, ref.object_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="conversation",
            object_id=row[0],
            label=row[1],
            route=f"/conversations/{row[0]}",
            icon="messages-square",
        )

    if ref.object_type == "message":
        message = db.get(Message, ref.object_id)
        if message is None or not can_read_conversation(db, viewer_id, message.conversation_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="message",
            object_id=message.id,
            label=f"Message #{message.seq}",
            snippet=message.content[:300],
            route=f"/conversations/{message.conversation_id}",
            icon="message-square",
        )

    if ref.object_type == "contributor":
        return hydrate_contributor_object_ref(db, viewer_id, ref.object_id)

    if ref.object_type == "podcast":
        row = db.execute(
            text(
                f"""
                SELECT p.id, p.title, p.description
                FROM podcasts p
                WHERE p.id = :id
                  AND p.id IN ({visible_podcast_ids_cte_sql()})
                """
            ),
            {"viewer_id": viewer_id, "id": ref.object_id},
        ).fetchone()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="podcast",
            object_id=row[0],
            label=row[1],
            snippet=row[2],
            route=f"/podcasts/{row[0]}",
            icon="podcast",
        )

    if ref.object_type == "content_chunk":
        row = db.execute(
            text(
                """
                SELECT cc.id, cc.owner_id AS media_id, cc.chunk_text, m.title
                FROM content_chunks cc
                JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                WHERE cc.id = :id
                """
            ),
            {"id": ref.object_id},
        ).fetchone()
        if row is None or not can_read_media(db, viewer_id, row[1]):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="content_chunk",
            object_id=row[0],
            label=row[3],
            snippet=str(row[2] or "")[:300],
            route=f"/media/{row[1]}",
            icon="text",
        )

    if ref.object_type == "fragment":
        fragment = db.get(Fragment, ref.object_id)
        if fragment is None or not can_read_media(db, viewer_id, fragment.media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="fragment",
            object_id=fragment.id,
            label=f"Fragment {fragment.idx + 1}",
            snippet=fragment.canonical_text[:300],
            route=f"/media/{fragment.media_id}#fragment-{fragment.id}",
            icon="text",
        )

    if ref.object_type == "evidence_span":
        row = db.execute(
            text(
                """
                SELECT es.id, es.owner_id AS media_id, es.span_text, es.citation_label, m.title
                FROM evidence_spans es
                JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
                WHERE es.id = :id
                """
            ),
            {"id": ref.object_id},
        ).fetchone()
        if row is None or not can_read_media(db, viewer_id, row[1]):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        return HydratedObjectRef(
            object_type="evidence_span",
            object_id=row[0],
            label=f"{row[4]} - {row[3]}",
            snippet=str(row[2] or "")[:300],
            route=f"/media/{row[1]}#evidence-{row[0]}",
            icon="quote",
        )

    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")


def search_object_refs(
    db: Session,
    viewer_id: UUID,
    q: str,
    *,
    limit: int = 8,
) -> list[HydratedObjectRef]:
    query = q.strip()
    if not query:
        return []

    pattern = f"%{query}%"
    results: list[HydratedObjectRef] = []

    for object_id in db.scalars(
        select(Page.id)
        .where(
            Page.user_id == viewer_id,
            Page.title.ilike(pattern) | Page.description.ilike(pattern),
        )
        .order_by(Page.title.asc(), Page.id.asc())
        .limit(limit)
    ):
        results.append(
            hydrate_object_ref(db, viewer_id, ObjectRef(object_type="page", object_id=object_id))
        )
        if len(results) >= limit:
            return results

    for object_id in db.scalars(
        select(NoteBlock.id)
        .where(NoteBlock.user_id == viewer_id, NoteBlock.body_text.ilike(pattern))
        .order_by(NoteBlock.updated_at.desc(), NoteBlock.id.asc())
        .limit(limit)
    ):
        results.append(
            hydrate_object_ref(
                db,
                viewer_id,
                ObjectRef(object_type="note_block", object_id=object_id),
            )
        )
        if len(results) >= limit:
            return results

    media_rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT m.id
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            WHERE m.title ILIKE :pattern
               OR COALESCE(m.description, '') ILIKE :pattern
            ORDER BY m.title ASC, m.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit},
    ).scalars()
    for object_id in media_rows:
        results.append(
            hydrate_object_ref(db, viewer_id, ObjectRef(object_type="media", object_id=object_id))
        )
        if len(results) >= limit:
            return results

    podcast_rows = db.execute(
        text(
            f"""
            SELECT p.id
            FROM podcasts p
            WHERE (
                    p.title ILIKE :pattern
                    OR COALESCE(p.description, '') ILIKE :pattern
                  )
              AND p.id IN ({visible_podcast_ids_cte_sql()})
            ORDER BY p.title ASC, p.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit},
    ).scalars()
    for object_id in podcast_rows:
        results.append(
            hydrate_object_ref(db, viewer_id, ObjectRef(object_type="podcast", object_id=object_id))
        )
        if len(results) >= limit:
            return results

    content_chunk_rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT cc.id
            FROM content_chunks cc
            JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
            JOIN visible_media vm ON vm.media_id = cc.owner_id AND cc.owner_kind = 'media'
            JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind AND mcis.owner_id = cc.owner_id
                AND mcis.status = 'ready'
            WHERE cc.chunk_text ILIKE :pattern
               OR m.title ILIKE :pattern
            ORDER BY cc.created_at DESC, cc.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit},
    ).scalars()
    for object_id in content_chunk_rows:
        results.append(
            hydrate_object_ref(
                db, viewer_id, ObjectRef(object_type="content_chunk", object_id=object_id)
            )
        )
        if len(results) >= limit:
            return results

    fragment_rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT f.id
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            JOIN visible_media vm ON vm.media_id = f.media_id
            WHERE f.canonical_text ILIKE :pattern
               OR m.title ILIKE :pattern
            ORDER BY f.created_at DESC, f.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit},
    ).scalars()
    for object_id in fragment_rows:
        results.append(
            hydrate_object_ref(
                db, viewer_id, ObjectRef(object_type="fragment", object_id=object_id)
            )
        )
        if len(results) >= limit:
            return results

    contributor_rows = db.execute(
        text(
            f"""
            WITH
                visible_contributor_credits AS ({visible_content_credit_rows_sql()}),
                visible_contributors AS ({visible_contributor_ids_cte_sql()}),
                alias_text AS (
                    SELECT contributor_id, string_agg(alias, ' ') AS aliases
                    FROM contributor_aliases
                    GROUP BY contributor_id
                )
            SELECT c.id
            FROM contributors c
            JOIN visible_contributors vc ON vc.contributor_id = c.id
            LEFT JOIN alias_text ON alias_text.contributor_id = c.id
            WHERE c.status IN ('unverified', 'verified')
              AND (
                    c.display_name ILIKE :pattern
                    OR COALESCE(c.sort_name, '') ILIKE :pattern
                    OR COALESCE(c.disambiguation, '') ILIKE :pattern
                    OR COALESCE(alias_text.aliases, '') ILIKE :pattern
                    OR EXISTS (
                        SELECT 1
                        FROM visible_contributor_credits cc_match
                        WHERE cc_match.contributor_id = c.id
                          AND cc_match.credited_name ILIKE :pattern
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM contributor_external_ids cei
                        WHERE cei.contributor_id = c.id
                          AND (
                                cei.external_key ILIKE :pattern
                                OR COALESCE(cei.external_url, '') ILIKE :pattern
                          )
                    )
              )
            ORDER BY c.display_name ASC, c.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit},
    ).scalars()
    for object_id in contributor_rows:
        results.append(
            hydrate_object_ref(
                db, viewer_id, ObjectRef(object_type="contributor", object_id=object_id)
            )
        )
        if len(results) >= limit:
            return results

    highlight_ids = db.scalars(
        select(Highlight.id)
        .where(Highlight.exact.ilike(pattern))
        .order_by(Highlight.updated_at.desc(), Highlight.id.asc())
        .limit(limit * 3)
    )
    for object_id in highlight_ids:
        if not can_read_highlight(db, viewer_id, object_id):
            continue
        results.append(
            hydrate_object_ref(
                db, viewer_id, ObjectRef(object_type="highlight", object_id=object_id)
            )
        )
        if len(results) >= limit:
            return results

    conversation_ids = db.scalars(
        select(Conversation.id)
        .where(Conversation.title.ilike(pattern))
        .order_by(Conversation.updated_at.desc(), Conversation.id.asc())
        .limit(limit * 3)
    )
    for object_id in conversation_ids:
        if not can_read_conversation(db, viewer_id, object_id):
            continue
        results.append(
            hydrate_object_ref(
                db, viewer_id, ObjectRef(object_type="conversation", object_id=object_id)
            )
        )
        if len(results) >= limit:
            return results

    message_rows = db.execute(
        select(Message.id, Message.conversation_id)
        .where(Message.status == "complete", Message.content.ilike(pattern))
        .order_by(Message.created_at.desc(), Message.id.asc())
        .limit(limit * 3)
    )
    for object_id, conversation_id in message_rows:
        if not can_read_conversation(db, viewer_id, conversation_id):
            continue
        results.append(
            hydrate_object_ref(db, viewer_id, ObjectRef(object_type="message", object_id=object_id))
        )
        if len(results) >= limit:
            return results

    evidence_span_rows = db.execute(
        text(
            """
            WITH visible_media AS (
                SELECT media_id FROM library_entries le
                JOIN memberships m ON m.library_id = le.library_id
                WHERE m.user_id = :viewer_id
            )
            SELECT es.id
            FROM evidence_spans es
            JOIN visible_media vm ON vm.media_id = es.owner_id AND es.owner_kind = 'media'
            WHERE es.span_text ILIKE :pattern
               OR es.citation_label ILIKE :pattern
            ORDER BY es.created_at DESC, es.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "pattern": pattern, "limit": limit * 3},
    )
    for (object_id,) in evidence_span_rows:
        results.append(
            hydrate_object_ref(
                db,
                viewer_id,
                ObjectRef(object_type="evidence_span", object_id=object_id),
            )
        )
        if len(results) >= limit:
            return results

    return results


def list_pinned_object_refs(
    db: Session,
    viewer_id: UUID,
    *,
    surface_key: str = "navbar",
) -> list[PinnedObjectRefOut]:
    pins = db.scalars(
        select(PinnedObjectRef)
        .where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.surface_key == surface_key,
            PinnedObjectRef.deleted_at.is_(None),
        )
        .order_by(
            PinnedObjectRef.order_key.asc(),
            PinnedObjectRef.created_at.asc(),
            PinnedObjectRef.id.asc(),
        )
    ).all()
    return [_pinned_out(db, viewer_id, pin) for pin in pins]


def _commit_pin_or_conflict(db: Session) -> None:
    """Commit a pinned-ref mutation, mapping the unique-pin constraint to a typed conflict."""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        constraint_name = integrity_constraint_name(exc)
        if constraint_name == "uix_user_pinned_objects_surface_ref" or (
            constraint_name is None and "uix_user_pinned_objects_surface_ref" in str(exc.orig)
        ):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object ref is already pinned") from exc
        raise


def pin_object_ref(
    db: Session,
    viewer_id: UUID,
    pin_input: PinObjectRefInput,
) -> PinnedObjectRefOut:
    hydrate_object_ref(db, viewer_id, pin_input.object_ref)
    existing = db.scalar(
        select(PinnedObjectRef).where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.surface_key == pin_input.surface_key,
            PinnedObjectRef.object_type == pin_input.object_ref.object_type,
            PinnedObjectRef.object_id == pin_input.object_ref.object_id,
            PinnedObjectRef.deleted_at.is_(None),
        )
    )
    if existing is not None:
        if pin_input.order_key is not None:
            existing.order_key = pin_input.order_key
            existing.updated_at = func.now()
            db.commit()
            db.refresh(existing)
        return _pinned_out(db, viewer_id, existing)

    pin = PinnedObjectRef(
        user_id=viewer_id,
        object_type=pin_input.object_ref.object_type,
        object_id=pin_input.object_ref.object_id,
        surface_key=pin_input.surface_key,
        order_key=pin_input.order_key or _next_pin_order_key(db, viewer_id, pin_input.surface_key),
    )
    db.add(pin)
    _commit_pin_or_conflict(db)
    db.refresh(pin)
    return _pinned_out(db, viewer_id, pin)


def update_pinned_object_ref(
    db: Session,
    viewer_id: UUID,
    pin_id: UUID,
    patch: UpdatePinnedObjectRefPatch,
) -> PinnedObjectRefOut:
    pin = db.get(PinnedObjectRef, pin_id)
    if pin is None or pin.user_id != viewer_id or pin.deleted_at is not None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Pinned object ref not found")
    if patch.surface_key is not None:
        pin.surface_key = patch.surface_key
    if patch.order_key is not None:
        pin.order_key = patch.order_key
    pin.updated_at = func.now()
    _commit_pin_or_conflict(db)
    db.refresh(pin)
    return _pinned_out(db, viewer_id, pin)


def unpin_object_ref(db: Session, viewer_id: UUID, pin_id: UUID) -> None:
    pin = db.get(PinnedObjectRef, pin_id)
    if pin is None or pin.user_id != viewer_id or pin.deleted_at is not None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Pinned object ref not found")
    db.execute(delete(PinnedObjectRef).where(PinnedObjectRef.id == pin.id))
    db.commit()


def _next_pin_order_key(db: Session, viewer_id: UUID, surface_key: str) -> str:
    count = db.scalar(
        select(func.count())
        .select_from(PinnedObjectRef)
        .where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.surface_key == surface_key,
            PinnedObjectRef.deleted_at.is_(None),
        )
    )
    return f"{int(count or 0) + 1:010d}"


def _pinned_out(db: Session, viewer_id: UUID, pin: PinnedObjectRef) -> PinnedObjectRefOut:
    return PinnedObjectRefOut(
        id=pin.id,
        object_ref=hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type=cast(OBJECT_TYPES, pin.object_type), object_id=pin.object_id),
        ),
        surface_key=pin.surface_key,
        order_key=pin.order_key,
        created_at=pin.created_at,
        updated_at=pin.updated_at,
    )


def render_object_context(db: Session, viewer_id: UUID, ref: ObjectRef) -> str:
    hydrated = hydrate_object_ref(db, viewer_id, ref)

    if ref.object_type == "page":
        blocks = ordered_note_blocks_for_page(db, ref.object_id)
        content = note_outline_markdown(blocks, None)
        return "\n".join(
            [
                '<context_lookup_result type="page">',
                f"<title>{xml_escape(hydrated.label)}</title>",
                f"<content>{xml_escape(content)}</content>",
                "</context_lookup_result>",
            ]
        )

    if ref.object_type == "note_block":
        block = db.get(NoteBlock, ref.object_id)
        if block is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
        page_id = block.page_id
        assert page_id is not None
        blocks = ordered_note_blocks_for_page(db, page_id)
        content = note_outline_markdown(blocks, block.parent_block_id, root_block=block)
        return "\n".join(
            [
                '<context_lookup_result type="note_block">',
                f"<note_block_id>{block.id}</note_block_id>",
                f"<content>{xml_escape(content)}</content>",
                "</context_lookup_result>",
            ]
        )

    preview = hydrated.snippet or hydrated.label
    return "\n".join(
        [
            f'<context_lookup_result type="{xml_escape(ref.object_type)}">',
            f"<title>{xml_escape(hydrated.label)}</title>",
            f"<excerpt>{xml_escape(preview)}</excerpt>",
            "</context_lookup_result>",
        ]
    )
