"""Hydration for universal object refs."""

from __future__ import annotations

from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    visible_media_ids_cte_sql,
)
from nexus.db.models import Conversation, Highlight, Media, Message, NoteBlock, Page
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.notes import HydratedObjectRef, ObjectRef
from nexus.services.contributors import hydrate_contributor_object_ref


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
            route=f"/media/{highlight.anchor_media_id}?highlight={highlight.id}",
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
                """
                SELECT p.id, p.title, p.description
                FROM podcasts p
                WHERE p.id = :id
                  AND (
                        EXISTS (
                            SELECT 1
                            FROM podcast_subscriptions ps
                            WHERE ps.podcast_id = p.id
                              AND ps.user_id = :viewer_id
                              AND ps.status = 'active'
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM library_entries le
                            JOIN memberships m ON m.library_id = le.library_id
                                              AND m.user_id = :viewer_id
                            WHERE le.podcast_id = p.id
                        )
                  )
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
                SELECT cc.id, cc.media_id, cc.chunk_text, m.title
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
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
            """
            SELECT p.id
            FROM podcasts p
            WHERE (
                    p.title ILIKE :pattern
                    OR COALESCE(p.description, '') ILIKE :pattern
                  )
              AND (
                    EXISTS (
                        SELECT 1
                        FROM podcast_subscriptions ps
                        WHERE ps.podcast_id = p.id
                          AND ps.user_id = :viewer_id
                          AND ps.status = 'active'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM library_entries le
                        JOIN memberships m ON m.library_id = le.library_id
                                          AND m.user_id = :viewer_id
                        WHERE le.podcast_id = p.id
                    )
              )
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
            JOIN media m ON m.id = cc.media_id
            JOIN visible_media vm ON vm.media_id = cc.media_id
            JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                AND mcis.active_run_id = cc.index_run_id
            JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                AND active_run.state = 'ready'
                AND active_run.deactivated_at IS NULL
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

    contributor_rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                visible_podcasts AS (
                    SELECT ps.podcast_id
                    FROM podcast_subscriptions ps
                    WHERE ps.user_id = :viewer_id
                      AND ps.status = 'active'

                    UNION

                    SELECT le.podcast_id
                    FROM library_entries le
                    JOIN memberships m ON m.library_id = le.library_id
                                      AND m.user_id = :viewer_id
                    WHERE le.podcast_id IS NOT NULL
                ),
                visible_contributor_credits AS (
                    SELECT cc.*
                    FROM contributor_credits cc
                    LEFT JOIN visible_media vm ON vm.media_id = cc.media_id
                    LEFT JOIN visible_podcasts vp ON vp.podcast_id = cc.podcast_id
                    WHERE vm.media_id IS NOT NULL
                       OR vp.podcast_id IS NOT NULL
                       OR cc.project_gutenberg_catalog_ebook_id IS NOT NULL
                ),
                visible_contributor_object_links AS (
                    SELECT ol.a_id AS contributor_id
                    FROM object_links ol
                    WHERE ol.user_id = :viewer_id
                      AND ol.a_type = 'contributor'

                    UNION

                    SELECT ol.b_id AS contributor_id
                    FROM object_links ol
                    WHERE ol.user_id = :viewer_id
                      AND ol.b_type = 'contributor'
                ),
                visible_contributor_context_items AS (
                    SELECT mci.object_id AS contributor_id
                    FROM message_context_items mci
                    WHERE mci.user_id = :viewer_id
                      AND mci.object_type = 'contributor'
                ),
                visible_contributors AS (
                    SELECT contributor_id
                    FROM visible_contributor_credits

                    UNION

                    SELECT contributor_id
                    FROM visible_contributor_object_links

                    UNION

                    SELECT contributor_id
                    FROM visible_contributor_context_items
                ),
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

    return results


def render_object_context(db: Session, viewer_id: UUID, ref: ObjectRef) -> str:
    hydrated = hydrate_object_ref(db, viewer_id, ref)

    if ref.object_type == "page":
        blocks = _ordered_note_blocks_for_page(db, ref.object_id)
        content = _note_outline_markdown(blocks, None)
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
        blocks = _ordered_note_blocks_for_page(db, page_id)
        content = _note_outline_markdown(blocks, block.parent_block_id, root_block=block)
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


def _ordered_note_blocks_for_page(db: Session, page_id: UUID) -> list[NoteBlock]:
    return list(
        db.scalars(
            select(NoteBlock)
            .where(NoteBlock.page_id == page_id)
            .order_by(
                NoteBlock.parent_block_id.asc().nullsfirst(),
                NoteBlock.order_key.asc(),
                NoteBlock.created_at.asc(),
                NoteBlock.id.asc(),
            )
        )
    )


def _note_outline_markdown(
    blocks: list[NoteBlock],
    parent_id: UUID | None,
    *,
    root_block: NoteBlock | None = None,
) -> str:
    blocks_by_parent: dict[UUID | None, list[NoteBlock]] = {}
    for block in blocks:
        blocks_by_parent.setdefault(block.parent_block_id, []).append(block)

    lines: list[str] = []

    def visit(block: NoteBlock, depth: int) -> None:
        lines.append(_note_block_markdown(block, depth))
        for child in blocks_by_parent.get(block.id, []):
            visit(child, depth + 1)

    if root_block is not None:
        visit(root_block, 0)
    else:
        for block in blocks_by_parent.get(parent_id, []):
            visit(block, 0)

    return "\n".join(lines).strip()


def _note_block_markdown(block: NoteBlock, depth: int) -> str:
    indent = "  " * depth
    text_value = (block.body_markdown or block.body_text or "").strip()
    lines = text_value.splitlines() or [""]
    if block.block_kind == "heading":
        level = min(depth + 1, 6)
        rendered = [f"{indent}{'#' * level} {lines[0]}".rstrip()]
        rendered.extend(f"{indent}{line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "todo":
        rendered = [f"{indent}- [ ] {lines[0]}".rstrip()]
        rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "quote":
        return "\n".join(f"{indent}> {line}".rstrip() for line in lines)
    if block.block_kind == "code":
        return "\n".join([f"{indent}```", *[f"{indent}{line}" for line in lines], f"{indent}```"])
    rendered = [f"{indent}- {lines[0]}".rstrip()]
    rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
    return "\n".join(rendered)
