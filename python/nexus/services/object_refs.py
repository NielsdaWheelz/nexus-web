"""Hydration for universal object refs (the note-editor picker and ref chips).

Loading and permissions ride ``resource_graph.resolve`` — the single per-scheme
data-access owner; only icon presentation for these surfaces lives here."""

from __future__ import annotations

from typing import assert_never, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    credited_visible_contributor_ids_cte_sql,
    visible_content_credit_rows_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.models import (
    Conversation,
    Highlight,
    Media,
    Message,
    NoteBlock,
    Page,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_items import (
    OBJECT_TYPES,
    HydratedObjectRef,
    ObjectRef,
)
from nexus.services.contributors import hydrate_contributor_object_ref
from nexus.services.note_block_markdown import note_block_outline_markdown, page_outline_markdown
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import (
    LoadedResource,
    load_resource_batch,
)
from nexus.services.resource_items.routing import route_for_ref


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
    """Map a visible :class:`LoadedResource` onto this surface's label/icon shape."""
    object_type = ref.object_type
    object_id = ref.object_id
    route = route_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ResourceRef(scheme=cast("ResourceScheme", object_type), id=object_id),
    )
    if object_type == "page":
        return HydratedObjectRef(
            object_type="page",
            object_id=object_id,
            label=loaded.title or "",
            route=route,
            icon="file-text",
        )
    if object_type == "note_block":
        body = loaded.body or ""
        return HydratedObjectRef(
            object_type="note_block",
            object_id=object_id,
            label=body.strip().splitlines()[0][:120] if body.strip() else "Note",
            snippet=body[:300],
            route=route,
            icon="list",
        )
    if object_type == "media":
        return HydratedObjectRef(
            object_type="media",
            object_id=object_id,
            label=loaded.title or "",
            snippet=db.scalar(select(Media.description).where(Media.id == object_id)),
            route=route,
            icon="book-open",
        )
    if object_type == "highlight":
        exact = loaded.quote.exact if loaded.quote is not None else ""
        return HydratedObjectRef(
            object_type="highlight",
            object_id=object_id,
            label=exact[:120] or "Highlight",
            snippet=exact,
            route=route,
            icon="highlighter",
        )
    if object_type == "conversation":
        return HydratedObjectRef(
            object_type="conversation",
            object_id=object_id,
            label=loaded.title or "",
            route=route,
            icon="messages-square",
        )
    if object_type == "message":
        seq = db.scalar(select(Message.seq).where(Message.id == object_id))
        return HydratedObjectRef(
            object_type="message",
            object_id=object_id,
            label=f"Message #{seq}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="message-square",
        )
    if object_type == "podcast":
        return HydratedObjectRef(
            object_type="podcast",
            object_id=object_id,
            label=loaded.title or "",
            snippet=loaded.body,
            route=route,
            icon="podcast",
        )
    if object_type == "library":
        return HydratedObjectRef(
            object_type="library",
            object_id=object_id,
            label=loaded.title or "",
            snippet=loaded.body,
            route=route,
            icon="library",
        )
    if object_type == "oracle_reading":
        return HydratedObjectRef(
            object_type="oracle_reading",
            object_id=object_id,
            label=loaded.title or "",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="sparkles",
        )
    if object_type == "oracle_passage_anchor":
        return HydratedObjectRef(
            object_type="oracle_passage_anchor",
            object_id=object_id,
            label=loaded.title or "",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="quote",
        )
    if object_type == "external_snapshot":
        return HydratedObjectRef(
            object_type="external_snapshot",
            object_id=object_id,
            label=loaded.title or "",
            snippet=loaded.body,
            route=route,
            icon="globe",
        )
    if object_type == "content_chunk":
        return HydratedObjectRef(
            object_type="content_chunk",
            object_id=object_id,
            label=loaded.title or "",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="text",
        )
    if object_type == "fragment":
        return HydratedObjectRef(
            object_type="fragment",
            object_id=object_id,
            label=f"Fragment {(loaded.fragment_idx or 0) + 1}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="text",
        )
    if object_type == "evidence_span":
        return HydratedObjectRef(
            object_type="evidence_span",
            object_id=object_id,
            label=f"{loaded.title} - {loaded.citation_label}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="quote",
        )
    if object_type == "artifact":
        return HydratedObjectRef(
            object_type="artifact",
            object_id=object_id,
            label=f"Library dossier - {loaded.title or 'Library'}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="sparkles",
        )
    if object_type == "artifact_revision":
        return HydratedObjectRef(
            object_type="artifact_revision",
            object_id=object_id,
            label=f"Library dossier revision - {loaded.title or 'Library'}",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="sparkles",
        )
    if object_type == "reader_apparatus_item":
        return HydratedObjectRef(
            object_type="reader_apparatus_item",
            object_id=object_id,
            label=loaded.title or "Reader apparatus",
            snippet=(loaded.body or "")[:300],
            route=route,
            icon="notebook-tabs",
        )
    if object_type == "contributor":
        # justify-defect: hydrate_object_ref handles contributors before loading.
        raise AssertionError("contributor refs hydrate through contributors service")
    assert_never(object_type)


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
    results: list[HydratedObjectRef] = []

    if _search_includes(object_types, "page"):
        for object_id in db.scalars(
            select(Page.id)
            .where(
                Page.user_id == viewer_id,
                Page.title.ilike(pattern),
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
                        JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
                        JOIN content_index_states cis
                          ON cis.owner_kind = cc.owner_kind
                         AND cis.owner_id = cc.owner_id
                         AND cis.status = 'ready'
                        WHERE nb.user_id = :viewer_id
                          AND cc.chunk_text ILIKE :pattern
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
        # The picker demands the narrow credited-visible predicate (spec §2.8, D-8):
        # a retained key owner or graph-referenced identity with zero visible credits
        # never surfaces here. Matching spans display name, every human alias, and
        # visible credited names — never an external identity key (spec §4).
        contributor_rows = db.execute(
            text(
                f"""
                WITH
                    visible_contributor_credits AS ({visible_content_credit_rows_sql()}),
                    credited_visible AS ({credited_visible_contributor_ids_cte_sql()}),
                    alias_text AS (
                        SELECT contributor_id, string_agg(alias, ' ') AS aliases
                        FROM contributor_aliases
                        GROUP BY contributor_id
                    )
                SELECT c.id
                FROM contributors c
                JOIN credited_visible cv ON cv.contributor_id = c.id
                LEFT JOIN alias_text ON alias_text.contributor_id = c.id
                WHERE (
                        c.display_name ILIKE :pattern
                        OR COALESCE(alias_text.aliases, '') ILIKE :pattern
                        OR EXISTS (
                            SELECT 1
                            FROM visible_contributor_credits cc_match
                            WHERE cc_match.contributor_id = c.id
                              AND cc_match.credited_name ILIKE :pattern
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
                        JOIN note_blocks nb ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
                        JOIN content_index_states cis
                          ON cis.owner_kind = es.owner_kind
                         AND cis.owner_id = es.owner_id
                         AND cis.status = 'ready'
                        WHERE nb.user_id = :viewer_id
                          AND (
                                es.span_text ILIKE :pattern
                                OR es.citation_label ILIKE :pattern
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
