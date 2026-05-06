"""Object-search projection, embedding, and retrieval for knowledge objects."""

from __future__ import annotations

import hashlib
from typing import Any, Literal
from uuid import UUID

import httpx
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    DailyNotePage,
    NoteBlock,
    ObjectSearchDocument,
    ObjectSearchEmbedding,
    Page,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.semantic_chunks import (
    build_text_embedding,
    build_text_embeddings,
    current_transcript_embedding_model,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)

logger = get_logger(__name__)

OBJECT_SEARCH_INDEX_VERSION = 1


def project_page(db: Session, viewer_id: UUID, page: Page) -> None:
    blocks = db.execute(
        select(NoteBlock.id, NoteBlock.parent_block_id, NoteBlock.body_text)
        .where(NoteBlock.user_id == viewer_id, NoteBlock.page_id == page.id)
        .order_by(
            NoteBlock.parent_block_id.asc().nullsfirst(),
            NoteBlock.order_key.asc(),
            NoteBlock.id.asc(),
        )
    ).all()
    daily_terms = _daily_terms(db, viewer_id, page.id)
    page_body = "\n".join(
        part for part in [page.description or "", *[row[2] for row in blocks]] if part
    )
    _upsert_document(
        db,
        viewer_id=viewer_id,
        object_type="page",
        object_id=page.id,
        parent_object_type=None,
        parent_object_id=None,
        title_text=page.title,
        body_text=page_body,
        search_text=_join_search_text(page.title, page.description or "", daily_terms, page_body),
        route_path=f"/pages/{page.id}",
    )

    block_map = {row[0]: (row[1], row[2] or "") for row in blocks}
    for block_id, _parent_id, body_text in blocks:
        ancestor_text = _ancestor_text(block_map, block_id)
        _upsert_document(
            db,
            viewer_id=viewer_id,
            object_type="note_block",
            object_id=block_id,
            parent_object_type="page",
            parent_object_id=page.id,
            title_text=page.title,
            body_text=body_text,
            search_text=_join_search_text(page.title, daily_terms, ancestor_text, body_text),
            route_path=f"/notes/{block_id}",
        )


def project_note_block(db: Session, viewer_id: UUID, block: NoteBlock) -> None:
    page = db.get(Page, block.page_id)
    title = page.title if page is not None else "Note"
    blocks = db.execute(
        select(NoteBlock.id, NoteBlock.parent_block_id, NoteBlock.body_text).where(
            NoteBlock.user_id == viewer_id,
            NoteBlock.page_id == block.page_id,
        )
    ).all()
    _upsert_document(
        db,
        viewer_id=viewer_id,
        object_type="note_block",
        object_id=block.id,
        parent_object_type="page",
        parent_object_id=block.page_id,
        title_text=title,
        body_text=block.body_text,
        search_text=_join_search_text(
            title,
            _daily_terms(db, viewer_id, block.page_id),
            _ancestor_text({row[0]: (row[1], row[2] or "") for row in blocks}, block.id),
            block.body_text,
        ),
        route_path=f"/notes/{block.id}",
    )


def rebuild_missing_embeddings(db: Session, viewer_id: UUID, *, limit: int = 100) -> int:
    dimensions = transcript_embedding_dimensions()
    expected_model = current_transcript_embedding_model()
    rows = db.execute(
        select(
            ObjectSearchDocument.id,
            ObjectSearchDocument.object_type,
            ObjectSearchDocument.object_id,
            ObjectSearchDocument.search_text,
            ObjectSearchDocument.content_hash,
            ObjectSearchDocument.index_version,
        )
        .outerjoin(
            ObjectSearchEmbedding,
            and_(
                ObjectSearchEmbedding.search_document_id == ObjectSearchDocument.id,
                ObjectSearchEmbedding.embedding_model == expected_model,
                ObjectSearchEmbedding.index_version == ObjectSearchDocument.index_version,
                ObjectSearchEmbedding.deleted_at.is_(None),
            ),
        )
        .where(
            ObjectSearchDocument.user_id == viewer_id,
            ObjectSearchDocument.deleted_at.is_(None),
            ObjectSearchDocument.index_version == OBJECT_SEARCH_INDEX_VERSION,
            or_(
                ObjectSearchEmbedding.id.is_(None),
                ObjectSearchEmbedding.content_hash != ObjectSearchDocument.content_hash,
                ObjectSearchEmbedding.embedding_dimensions != dimensions,
                ObjectSearchDocument.index_status != "ready",
            ),
        )
        .order_by(ObjectSearchDocument.updated_at.asc(), ObjectSearchDocument.id.asc())
        .limit(limit)
    ).all()
    if not rows:
        return 0

    embedding_model, vectors = build_text_embeddings([row[3] for row in rows])
    for row, vector in zip(rows, vectors, strict=True):
        document = db.get(ObjectSearchDocument, row[0])
        if document is None or document.deleted_at is not None:
            continue
        embedding = db.scalar(
            select(ObjectSearchEmbedding).where(
                ObjectSearchEmbedding.search_document_id == document.id,
                ObjectSearchEmbedding.embedding_model == embedding_model,
                ObjectSearchEmbedding.index_version == document.index_version,
            )
        )
        if embedding is None:
            db.add(
                ObjectSearchEmbedding(
                    user_id=viewer_id,
                    search_document_id=document.id,
                    object_type=document.object_type,
                    object_id=document.object_id,
                    embedding_model=embedding_model,
                    embedding_dimensions=len(vector),
                    content_hash=document.content_hash,
                    index_version=document.index_version,
                    embedding=vector,
                    deleted_at=None,
                )
            )
        else:
            embedding.user_id = viewer_id
            embedding.object_type = document.object_type
            embedding.object_id = document.object_id
            embedding.embedding_dimensions = len(vector)
            embedding.content_hash = document.content_hash
            embedding.embedding = vector
            embedding.deleted_at = None
            embedding.updated_at = func.now()
        document.index_status = "ready"
        document.updated_at = func.now()
    db.commit()
    return len(rows)


def search_objects(
    db: Session,
    *,
    viewer_id: UUID,
    object_type: Literal["page", "note_block"],
    query_text: str,
    semantic: bool,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "object_type": object_type,
        "query": query_text,
        "contains_query": f"%{query_text}%",
        "index_version": OBJECT_SEARCH_INDEX_VERSION,
        "limit": limit,
    }
    semantic_cte = ""
    semantic_join = ""
    semantic_score = "0.0"
    semantic_match = "FALSE"
    if semantic:
        try:
            embedding_model, query_embedding = build_text_embedding(query_text)
            dimensions = transcript_embedding_dimensions()
            if len(query_embedding) != dimensions:
                raise ApiError(
                    ApiErrorCode.E_INTERNAL,
                    "Object-search query embedding has the wrong dimensionality.",
                )
            params["embedding_model"] = embedding_model
            params["embedding_dimensions"] = dimensions
            params["query_embedding"] = to_pgvector_literal(query_embedding)
            params["semantic_limit"] = max(limit * 20, 100)
            semantic_cte = f"""
                query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({dimensions})) AS embedding
                ),
                semantic_matches AS (
                    SELECT
                        ose.search_document_id,
                        (1 - (ose.embedding <=> qe.embedding)) AS semantic_score
                    FROM object_search_embeddings ose
                    JOIN query_embedding qe ON true
                    WHERE ose.user_id = :viewer_id
                      AND ose.embedding_model = :embedding_model
                      AND ose.embedding_dimensions = :embedding_dimensions
                      AND ose.index_version = :index_version
                      AND ose.deleted_at IS NULL
                      AND ose.embedding IS NOT NULL
                    ORDER BY ose.embedding <=> qe.embedding ASC, ose.search_document_id ASC
                    LIMIT :semantic_limit
                ),
            """
            semantic_join = "LEFT JOIN semantic_matches sm ON sm.search_document_id = osd.id"
            semantic_score = "COALESCE(sm.semantic_score, 0.0)"
            semantic_match = "sm.search_document_id IS NOT NULL"
        except (ApiError, ValueError, httpx.HTTPError) as exc:
            logger.warning(
                "object_search_query_embedding_failed",
                query_hash=hashlib.sha256(query_text.encode("utf-8")).hexdigest()[:16],
                error=str(exc),
            )

    scope_filter = _scope_filter_sql(scope_type)
    if scope_type != "all":
        params["scope_id"] = scope_id
    sql = f"""
        WITH
            {semantic_cte}
            query_terms AS (
                SELECT websearch_to_tsquery('english', :query) AS tsq
            )
        SELECT
            osd.object_id,
            osd.parent_object_id,
            osd.title_text,
            osd.body_text,
            osd.route_path,
            ts_rank_cd(osd.search_vector, qt.tsq) AS lexical_score,
            CASE
                WHEN lower(osd.title_text) = lower(:query) THEN 4.0
                WHEN osd.title_text ILIKE :contains_query THEN 2.0
                ELSE 0.0
            END AS exact_score,
            {semantic_score} AS semantic_score,
            ts_headline(
                'english',
                osd.search_text,
                qt.tsq,
                'MaxWords=50, MinWords=5, MaxFragments=1'
            ) AS snippet,
            (
                CASE
                    WHEN lower(osd.title_text) = lower(:query) THEN 4.0
                    WHEN osd.title_text ILIKE :contains_query THEN 2.0
                    ELSE 0.0
                END
                + (ts_rank_cd(osd.search_vector, qt.tsq) * 2.0)
                + ({semantic_score} * 1.5)
            ) AS score
        FROM object_search_documents osd
        CROSS JOIN query_terms qt
        {semantic_join}
        WHERE osd.user_id = :viewer_id
          AND osd.object_type = :object_type
          AND osd.index_version = :index_version
          AND osd.deleted_at IS NULL
          AND (
                osd.search_vector @@ qt.tsq
             OR osd.title_text ILIKE :contains_query
             OR {semantic_match}
          )
          {scope_filter}
        ORDER BY score DESC, osd.object_id ASC
        LIMIT :limit
    """
    return [dict(row) for row in db.execute(text(sql), params).mappings().all()]


def delete_document(db: Session, viewer_id: UUID, *, object_type: str, object_id: UUID) -> None:
    document = db.scalar(
        select(ObjectSearchDocument).where(
            ObjectSearchDocument.user_id == viewer_id,
            ObjectSearchDocument.object_type == object_type,
            ObjectSearchDocument.object_id == object_id,
            ObjectSearchDocument.index_version == OBJECT_SEARCH_INDEX_VERSION,
        )
    )
    if document is None:
        return
    db.execute(
        delete(ObjectSearchEmbedding).where(ObjectSearchEmbedding.search_document_id == document.id)
    )
    db.delete(document)


def _upsert_document(
    db: Session,
    *,
    viewer_id: UUID,
    object_type: Literal["page", "note_block"],
    object_id: UUID,
    parent_object_type: str | None,
    parent_object_id: UUID | None,
    title_text: str,
    body_text: str,
    search_text: str,
    route_path: str,
) -> None:
    title_text = title_text[:300] or "Untitled"
    search_text = search_text.strip() or title_text
    content_hash = hashlib.sha256(
        "\0".join(
            [
                object_type,
                str(object_id),
                parent_object_type or "",
                str(parent_object_id or ""),
                title_text,
                body_text,
                search_text,
                route_path,
            ]
        ).encode("utf-8")
    ).hexdigest()
    document = None
    for pending in db.new:
        if not isinstance(pending, ObjectSearchDocument):
            continue
        if (
            pending.user_id == viewer_id
            and pending.object_type == object_type
            and pending.object_id == object_id
            and pending.index_version == OBJECT_SEARCH_INDEX_VERSION
        ):
            document = pending
            break
    if document is None:
        document = db.scalar(
            select(ObjectSearchDocument).where(
                ObjectSearchDocument.user_id == viewer_id,
                ObjectSearchDocument.object_type == object_type,
                ObjectSearchDocument.object_id == object_id,
                ObjectSearchDocument.index_version == OBJECT_SEARCH_INDEX_VERSION,
            )
        )
    if document is None:
        db.add(
            ObjectSearchDocument(
                user_id=viewer_id,
                object_type=object_type,
                object_id=object_id,
                parent_object_type=parent_object_type,
                parent_object_id=parent_object_id,
                title_text=title_text,
                body_text=body_text,
                search_text=search_text,
                route_path=route_path,
                content_hash=content_hash,
                index_version=OBJECT_SEARCH_INDEX_VERSION,
                index_status="pending_embedding",
            )
        )
        return

    if document.content_hash != content_hash:
        document.index_status = "pending_embedding"
    document.parent_object_type = parent_object_type
    document.parent_object_id = parent_object_id
    document.title_text = title_text
    document.body_text = body_text
    document.search_text = search_text
    document.route_path = route_path
    document.content_hash = content_hash
    document.deleted_at = None
    document.updated_at = func.now()


def _daily_terms(db: Session, viewer_id: UUID, page_id: UUID | None) -> str:
    if page_id is None:
        return ""
    daily = db.scalar(
        select(DailyNotePage.local_date).where(
            DailyNotePage.user_id == viewer_id,
            DailyNotePage.page_id == page_id,
            DailyNotePage.deleted_at.is_(None),
        )
    )
    if daily is None:
        return ""
    return f"{daily.isoformat()} {daily:%B} {daily.day}, {daily.year}"


def _ancestor_text(blocks: dict[UUID, tuple[UUID | None, str]], block_id: UUID) -> str:
    parts: list[str] = []
    seen = {block_id}
    parent_id = blocks.get(block_id, (None, ""))[0]
    while parent_id is not None and parent_id not in seen:
        seen.add(parent_id)
        parent_id, body_text = blocks.get(parent_id, (None, ""))
        if body_text:
            parts.append(body_text)
    return " ".join(reversed(parts))


def _join_search_text(*parts: str) -> str:
    return " ".join(part.strip() for part in parts if part and part.strip())


def _scope_filter_sql(scope_type: str) -> str:
    if scope_type == "all":
        return ""
    if scope_type == "media":
        return """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                WHERE (
                        (ol.a_type = osd.object_type AND ol.a_id = osd.object_id)
                     OR (ol.b_type = osd.object_type AND ol.b_id = osd.object_id)
                )
                  AND (
                        (ol.a_type = 'media' AND ol.a_id = :scope_id)
                     OR (ol.b_type = 'media' AND ol.b_id = :scope_id)
                     OR h.anchor_media_id = :scope_id
                  )
            )
        """
    if scope_type == "library":
        return """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                JOIN library_entries le
                  ON le.library_id = :scope_id
                 AND le.media_id IS NOT NULL
                 AND (
                        (ol.a_type = 'media' AND le.media_id = ol.a_id)
                     OR (ol.b_type = 'media' AND le.media_id = ol.b_id)
                     OR le.media_id = h.anchor_media_id
                 )
                WHERE (
                        (ol.a_type = osd.object_type AND ol.a_id = osd.object_id)
                     OR (ol.b_type = osd.object_type AND ol.b_id = osd.object_id)
                )
            )
        """
    if scope_type == "conversation":
        return """
            AND (
                EXISTS (
                    SELECT 1
                    FROM message_context_items mci
                    JOIN messages msg ON msg.id = mci.message_id
                    WHERE mci.object_type = osd.object_type
                      AND mci.object_id = osd.object_id
                      AND msg.conversation_id = :scope_id
                )
                OR EXISTS (
                    SELECT 1
                    FROM object_links ol
                    JOIN messages msg
                      ON (
                            (ol.a_type = 'message' AND msg.id = ol.a_id)
                         OR (ol.b_type = 'message' AND msg.id = ol.b_id)
                      )
                    WHERE ol.relation_type = 'used_as_context'
                      AND (
                            (ol.a_type = osd.object_type AND ol.a_id = osd.object_id)
                         OR (ol.b_type = osd.object_type AND ol.b_id = osd.object_id)
                      )
                      AND msg.conversation_id = :scope_id
                )
            )
        """
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")
