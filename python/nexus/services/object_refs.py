"""Hydration for universal object refs (pins, the note-editor picker, ref chips).

Loading and permissions ride ``resource_graph.resolve`` — the single per-scheme
data-access owner; only the route/icon presentation for these surfaces lives
here."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, assert_never, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    visible_content_credit_rows_sql,
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    Conversation,
    Highlight,
    Media,
    Message,
    NoteBlock,
    Page,
    PinnedObjectRef,
    Tag,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    OBJECT_TYPES,
    HydratedObjectRef,
    ObjectRef,
    PinnedObjectRefOut,
)
from nexus.services.contributors import hydrate_contributor_object_ref
from nexus.services.note_block_markdown import note_block_outline_markdown, page_outline_markdown
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import (
    LoadedResource,
    load_resource_batch,
    parent_media_id_for_read_pointer,
    reader_target_for_citation_target,
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
    if ref.object_type == "contributor":
        return hydrate_contributor_object_ref(db, viewer_id, ref.object_id)
    resource_ref = ResourceRef(scheme=cast("ResourceScheme", ref.object_type), id=ref.object_id)
    loaded = load_resource_batch(db, [resource_ref], viewer_id=viewer_id)[resource_ref.uri]
    if loaded.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object not found")
    return _hydrated_from_loaded(db, viewer_id, ref, loaded)


def _hydrated_from_loaded(
    db: Session, viewer_id: UUID, ref: ObjectRef, loaded: LoadedResource
) -> HydratedObjectRef:
    """Map a visible :class:`LoadedResource` onto this surface's label/route/icon shape.

    Parent media/conversation ids exist only as routes here, so they are looked
    up locally; everything content-bearing comes from the loaded resource.
    """
    object_type = ref.object_type
    object_id = ref.object_id
    if object_type == "page":
        return HydratedObjectRef(
            object_type="page",
            object_id=object_id,
            label=loaded.title or "",
            snippet=loaded.body or None,
            route=f"/pages/{object_id}",
            icon="file-text",
        )
    if object_type == "note_block":
        body = loaded.body or ""
        return HydratedObjectRef(
            object_type="note_block",
            object_id=object_id,
            label=body.strip().splitlines()[0][:120] if body.strip() else "Note",
            snippet=body[:300],
            route=f"/notes/{object_id}",
            icon="list",
        )
    if object_type == "media":
        return HydratedObjectRef(
            object_type="media",
            object_id=object_id,
            label=loaded.title or "",
            snippet=db.scalar(select(Media.description).where(Media.id == object_id)),
            route=f"/media/{object_id}",
            icon="book-open",
        )
    if object_type == "highlight":
        exact = loaded.quote.exact if loaded.quote is not None else ""
        media_id = db.scalar(select(Highlight.anchor_media_id).where(Highlight.id == object_id))
        return HydratedObjectRef(
            object_type="highlight",
            object_id=object_id,
            label=exact[:120] or "Highlight",
            snippet=exact,
            route=f"/media/{media_id}#highlight-{object_id}",
            icon="highlighter",
        )
    if object_type == "conversation":
        return HydratedObjectRef(
            object_type="conversation",
            object_id=object_id,
            label=loaded.title or "",
            route=f"/conversations/{object_id}",
            icon="messages-square",
        )
    if object_type == "message":
        conversation_id, seq = db.execute(
            select(Message.conversation_id, Message.seq).where(Message.id == object_id)
        ).one()
        return HydratedObjectRef(
            object_type="message",
            object_id=object_id,
            label=f"Message #{seq}",
            snippet=(loaded.body or "")[:300],
            route=f"/conversations/{conversation_id}",
            icon="message-square",
        )
    if object_type == "podcast":
        return HydratedObjectRef(
            object_type="podcast",
            object_id=object_id,
            label=loaded.title or "",
            snippet=loaded.body,
            route=f"/podcasts/{object_id}",
            icon="podcast",
        )
    if object_type == "content_chunk":
        route = _read_pointer_route(
            db,
            viewer_id=viewer_id,
            scheme="content_chunk",
            resource_id=object_id,
        )
        return HydratedObjectRef(
            object_type="content_chunk",
            object_id=object_id,
            label=loaded.title or "",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="text",
        )
    if object_type == "fragment":
        media_id = parent_media_id_for_read_pointer(db, scheme=object_type, resource_id=object_id)
        return HydratedObjectRef(
            object_type="fragment",
            object_id=object_id,
            label=f"Fragment {(loaded.fragment_idx or 0) + 1}",
            snippet=(loaded.body or "")[:300],
            route=f"/media/{media_id}#fragment-{object_id}",
            icon="text",
        )
    if object_type == "evidence_span":
        route = _read_pointer_route(
            db,
            viewer_id=viewer_id,
            scheme="evidence_span",
            resource_id=object_id,
        )
        return HydratedObjectRef(
            object_type="evidence_span",
            object_id=object_id,
            label=f"{loaded.title} - {loaded.citation_label}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="quote",
        )
    if object_type == "tag":
        return HydratedObjectRef(
            object_type="tag",
            object_id=object_id,
            label=loaded.title or "",
            route=None,
            icon="tag",
        )
    if object_type == "contributor":
        # justify-defect: hydrate_object_ref handles contributors before loading.
        raise AssertionError("contributor refs hydrate through contributors service")
    assert_never(object_type)


def _read_pointer_route(
    db: Session,
    *,
    viewer_id: UUID,
    scheme: Literal["content_chunk", "evidence_span"],
    resource_id: UUID,
) -> str | None:
    media_id, locator = reader_target_for_citation_target(
        db,
        viewer_id=viewer_id,
        target=ResourceRef(scheme=scheme, id=resource_id),
    )
    if media_id is not None:
        if scheme == "evidence_span":
            return f"/media/{media_id}#evidence-{resource_id}"
        return f"/media/{media_id}"
    if _is_note_block_offsets(locator):
        return f"/notes/{locator['block_id']}"
    page_id = _page_owner_id_for_read_pointer(db, scheme=scheme, resource_id=resource_id)
    return f"/pages/{page_id}" if page_id is not None else None


def _is_note_block_offsets(locator: object) -> bool:
    return (
        isinstance(locator, dict)
        and locator.get("type") == "note_block_offsets"
        and isinstance(locator.get("block_id"), str)
        and bool(locator["block_id"])
    )


def _page_owner_id_for_read_pointer(
    db: Session,
    *,
    scheme: Literal["content_chunk", "evidence_span"],
    resource_id: UUID,
) -> UUID | None:
    table = "content_chunks" if scheme == "content_chunk" else "evidence_spans"
    return db.scalar(
        text(
            f"""
            SELECT p.id
            FROM {table} source
            JOIN pages p ON p.id = source.owner_id
            WHERE source.id = :resource_id
              AND source.owner_kind = 'page'
            """
        ),
        {"resource_id": resource_id},
    )


def search_object_refs(
    db: Session,
    viewer_id: UUID,
    q: str,
    *,
    limit: int = 8,
    object_types: set[OBJECT_TYPES] | None = None,
) -> list[HydratedObjectRef]:
    query = q.strip()
    if not query:
        return []

    pattern = f"%{query}%"
    tag_pattern = f"%{query.removeprefix('#')}%"
    results: list[HydratedObjectRef] = []

    if _search_includes(object_types, "page"):
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
                hydrate_object_ref(
                    db, viewer_id, ObjectRef(object_type="page", object_id=object_id)
                )
            )
            if len(results) >= limit:
                return results

    if _search_includes(object_types, "note_block"):
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

    if _search_includes(object_types, "tag"):
        for object_id in db.scalars(
            select(Tag.id)
            .where(
                Tag.user_id == viewer_id,
                Tag.name.ilike(tag_pattern) | Tag.slug.ilike(tag_pattern),
            )
            .order_by(Tag.name.asc(), Tag.id.asc())
            .limit(limit)
        ):
            results.append(
                hydrate_object_ref(db, viewer_id, ObjectRef(object_type="tag", object_id=object_id))
            )
            if len(results) >= limit:
                return results

    if _search_includes(object_types, "media"):
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
                hydrate_object_ref(
                    db, viewer_id, ObjectRef(object_type="media", object_id=object_id)
                )
            )
            if len(results) >= limit:
                return results

    if _search_includes(object_types, "podcast"):
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
                hydrate_object_ref(
                    db, viewer_id, ObjectRef(object_type="podcast", object_id=object_id)
                )
            )
            if len(results) >= limit:
                return results

    if _search_includes(object_types, "content_chunk"):
        content_chunk_rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                     visible_chunks AS (
                        SELECT cc.id, cc.created_at
                        FROM content_chunks cc
                        JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                        JOIN visible_media vm ON vm.media_id = cc.owner_id
                        JOIN content_index_states cis
                          ON cis.owner_kind = cc.owner_kind
                         AND cis.owner_id = cc.owner_id
                         AND cis.status = 'ready'
                        WHERE cc.chunk_text ILIKE :pattern
                           OR m.title ILIKE :pattern
                        UNION ALL
                        SELECT cc.id, cc.created_at
                        FROM content_chunks cc
                        JOIN pages p ON p.id = cc.owner_id AND cc.owner_kind = 'page'
                        JOIN content_index_states cis
                          ON cis.owner_kind = cc.owner_kind
                         AND cis.owner_id = cc.owner_id
                         AND cis.status = 'ready'
                        WHERE p.user_id = :viewer_id
                          AND (
                                cc.chunk_text ILIKE :pattern
                                OR p.title ILIKE :pattern
                              )
                     )
                SELECT cc.id
                FROM visible_chunks cc
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

    if _search_includes(object_types, "fragment"):
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

    if _search_includes(object_types, "contributor"):
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

    if _search_includes(object_types, "highlight"):
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

    if _search_includes(object_types, "conversation"):
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

    if _search_includes(object_types, "message"):
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
                hydrate_object_ref(
                    db, viewer_id, ObjectRef(object_type="message", object_id=object_id)
                )
            )
            if len(results) >= limit:
                return results

    if _search_includes(object_types, "evidence_span"):
        evidence_span_rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                     visible_spans AS (
                        SELECT es.id, es.created_at
                        FROM evidence_spans es
                        JOIN visible_media vm ON vm.media_id = es.owner_id
                        JOIN content_index_states cis
                          ON cis.owner_kind = es.owner_kind
                         AND cis.owner_id = es.owner_id
                         AND cis.status = 'ready'
                        WHERE es.owner_kind = 'media'
                          AND (
                                es.span_text ILIKE :pattern
                                OR es.citation_label ILIKE :pattern
                              )
                        UNION ALL
                        SELECT es.id, es.created_at
                        FROM evidence_spans es
                        JOIN pages p ON p.id = es.owner_id AND es.owner_kind = 'page'
                        JOIN content_index_states cis
                          ON cis.owner_kind = es.owner_kind
                         AND cis.owner_id = es.owner_id
                         AND cis.status = 'ready'
                        WHERE p.user_id = :viewer_id
                          AND (
                                es.span_text ILIKE :pattern
                                OR es.citation_label ILIKE :pattern
                                OR p.title ILIKE :pattern
                              )
                     )
                SELECT es.id
                FROM visible_spans es
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


def _search_includes(object_types: set[OBJECT_TYPES] | None, object_type: OBJECT_TYPES) -> bool:
    return object_types is None or object_type in object_types


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
        content = page_outline_markdown(db, viewer_id=viewer_id, page_id=ref.object_id)
        return "\n".join(
            [
                '<context_lookup_result type="page">',
                f"<title>{xml_escape(hydrated.label)}</title>",
                f"<content>{xml_escape(content)}</content>",
                "</context_lookup_result>",
            ]
        )

    if ref.object_type == "note_block":
        content = note_block_outline_markdown(db, viewer_id=viewer_id, block_id=ref.object_id)
        return "\n".join(
            [
                '<context_lookup_result type="note_block">',
                f"<note_block_id>{ref.object_id}</note_block_id>",
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
