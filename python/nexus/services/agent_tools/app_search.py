"""Provider-neutral app-search tool execution for chat.

The chat pipeline uses this module as the canonical read-only tool for finding
relevant app content before the final model call. It deliberately persists only
privacy-safe query metadata: raw user queries are never stored in tool tables.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media
from nexus.db.models import Annotation
from nexus.logging import get_logger
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.search import SearchResultOut
from nexus.services.context_rendering import render_context_blocks
from nexus.services.search import ALL_RESULT_TYPES, hash_query, search

logger = get_logger(__name__)

APP_SEARCH_TOOL_NAME = "app_search"
APP_SEARCH_LIMIT = 8
APP_SEARCH_SELECTED_LIMIT = 6
APP_SEARCH_CONTEXT_CHARS = 16000
APP_SEARCH_QUERY_MAX_CHARS = 512

_SHORT_NON_SEARCH_MESSAGES = {
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
}

_SEARCH_CUE_TERMS = (
    "find",
    "search",
    "look up",
    "lookup",
    "show me",
    "source",
    "sources",
    "cite",
    "citation",
    "saved",
    "library",
    "highlight",
    "annotation",
    "note",
    "notes",
    "fragment",
    "episode",
    "podcast",
    "video",
    "article",
    "book",
    "pdf",
    "document",
    "transcript",
    "where did",
    "what did",
    "when did",
    "summarize",
    "compare",
)

_CURRENT_SCOPE_TERMS = (
    "this conversation",
    "this chat",
    "above",
    "earlier",
    "we discussed",
    "attached",
    "this document",
    "this article",
    "this episode",
    "this video",
    "this pdf",
)


@dataclass(slots=True)
class AppSearchCitation:
    """Compact model/frontend citation for a retrieved search result."""

    result_type: str
    source_id: str
    title: str
    source_label: str | None
    snippet: str
    deep_link: str
    context_ref: dict[str, Any]
    media_id: str | None
    media_kind: str | None
    score: float | None
    selected: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "result_type": self.result_type,
            "source_id": self.source_id,
            "title": self.title,
            "source_label": self.source_label,
            "snippet": self.snippet,
            "deep_link": self.deep_link,
            "context_ref": self.context_ref,
            "media_id": self.media_id,
            "media_kind": self.media_kind,
            "score": self.score,
            "selected": self.selected,
        }


@dataclass(slots=True)
class AppSearchRun:
    """Executed app-search tool call."""

    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    query_hash: str
    scope: str
    requested_types: list[str]
    semantic: bool
    citations: list[AppSearchCitation]
    selected_citations: list[AppSearchCitation]
    context_text: str
    context_chars: int
    latency_ms: int
    status: str
    error_code: str | None = None
    tool_call_id: UUID | None = None
    tool_call_index: int = 0
    result_refs: list[dict[str, Any]] = field(default_factory=list)

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "started",
            "scope": self.scope,
            "types": self.requested_types,
            "semantic": self.semantic,
        }

    def tool_result_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": self.status,
            "error_code": self.error_code,
            "result_count": len(self.citations),
            "selected_count": len(self.selected_citations),
            "latency_ms": self.latency_ms,
            "citations": [citation.to_json() for citation in self.selected_citations],
        }


def should_run_app_search(content: str, *, has_user_context: bool) -> bool:
    """Return whether chat should execute app search for this user turn."""
    normalized = " ".join(content.lower().split())
    if len(normalized) < 2 or normalized in _SHORT_NON_SEARCH_MESSAGES:
        return False
    if any(term in normalized for term in _SEARCH_CUE_TERMS):
        return True
    return not has_user_context and len(normalized) >= 12


def infer_app_search_scope(content: str, conversation_id: UUID) -> str:
    """Choose the default tool scope for the current turn."""
    normalized = " ".join(content.lower().split())
    if any(term in normalized for term in _CURRENT_SCOPE_TERMS):
        return f"conversation:{conversation_id}"
    return "all"


def build_app_search_query(content: str) -> str:
    """Build the search query from a user message without storing raw text."""
    query = " ".join(content.split()).strip()
    lowered = query.lower()
    for prefix in (
        "find me ",
        "find ",
        "search for ",
        "search ",
        "look up ",
        "lookup ",
        "show me ",
        "show ",
        "sources for ",
        "cite ",
        "what did ",
        "where did ",
        "when did ",
    ):
        if lowered.startswith(prefix):
            query = query[len(prefix) :].strip()
            lowered = query.lower()
            break

    for phrase in (
        " in my library",
        " from my library",
        " in my saved items",
        " from my saved items",
        " in saved content",
        " from saved content",
    ):
        query = query.replace(phrase, "").replace(phrase.title(), "")

    query = query.strip(" \t\r\n?.!,;:")
    return (query or content).strip()[:APP_SEARCH_QUERY_MAX_CHARS]


def execute_app_search(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    content: str,
    has_user_context: bool,
) -> AppSearchRun | None:
    """Run app search for a chat turn and persist tool/retrieval metadata."""
    if not should_run_app_search(content, has_user_context=has_user_context):
        return None

    query = build_app_search_query(content)
    scope = infer_app_search_scope(query, conversation_id)
    requested_types = list(ALL_RESULT_TYPES)
    semantic = True
    start = time.monotonic()
    status = "complete"
    error_code = None

    try:
        response = search(
            db=db,
            viewer_id=viewer_id,
            q=query,
            scope=scope,
            types=requested_types,
            semantic=semantic,
            limit=APP_SEARCH_LIMIT,
        )
        result_rows = list(response.results)
        citations = [_citation_from_search_result(result) for result in result_rows]
        result_refs = [result.model_dump(mode="json") for result in result_rows]
        context_text, context_chars, selected = render_retrieved_context_blocks(
            db,
            viewer_id=viewer_id,
            citations=citations,
        )
        if not context_text and not citations:
            context_text = '<app_search_results status="no_results" />'
            context_chars = len(context_text)
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        logger.warning(
            "agent_app_search_failed",
            query_hash=hash_query(query),
            scope=scope,
            error=str(exc),
        )
        status = "error"
        error_code = "E_APP_SEARCH_FAILED"
        citations = []
        selected = []
        result_refs = []
        context_text = ""
        context_chars = 0

    latency_ms = int((time.monotonic() - start) * 1000)
    run = AppSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash=hash_query(query),
        scope=scope,
        requested_types=requested_types,
        semantic=semantic,
        citations=citations,
        selected_citations=selected,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        result_refs=result_refs,
    )
    persist_app_search_run(db, run)
    return run


def _citation_from_search_result(result: SearchResultOut) -> AppSearchCitation:
    payload = result.model_dump(mode="json")
    context_ref = payload["context_ref"]
    return AppSearchCitation(
        result_type=str(payload["type"]),
        source_id=str(payload["id"]),
        title=str(payload["title"]),
        source_label=payload.get("source_label"),
        snippet=str(payload["snippet"]),
        deep_link=str(payload["deep_link"]),
        context_ref=context_ref,
        media_id=payload.get("media_id"),
        media_kind=payload.get("media_kind"),
        score=float(payload["score"]) if payload.get("score") is not None else None,
    )


def persist_app_search_run(db: Session, run: AppSearchRun) -> None:
    """Persist the app-search tool call and retrieval rows."""
    selected_context_refs = [citation.context_ref for citation in run.selected_citations]
    insert_tool = text(
        """
        INSERT INTO message_tool_calls (
            conversation_id,
            user_message_id,
            assistant_message_id,
            tool_name,
            tool_call_index,
            query_hash,
            scope,
            requested_types,
            semantic,
            result_refs,
            selected_context_refs,
            provider_request_ids,
            latency_ms,
            status,
            error_code
        )
        VALUES (
            :conversation_id,
            :user_message_id,
            :assistant_message_id,
            :tool_name,
            :tool_call_index,
            :query_hash,
            :scope,
            :requested_types,
            :semantic,
            :result_refs,
            :selected_context_refs,
            '[]'::jsonb,
            :latency_ms,
            :status,
            :error_code
        )
        ON CONFLICT (assistant_message_id, tool_call_index)
        DO UPDATE SET
            query_hash = EXCLUDED.query_hash,
            scope = EXCLUDED.scope,
            requested_types = EXCLUDED.requested_types,
            semantic = EXCLUDED.semantic,
            result_refs = EXCLUDED.result_refs,
            selected_context_refs = EXCLUDED.selected_context_refs,
            latency_ms = EXCLUDED.latency_ms,
            status = EXCLUDED.status,
            error_code = EXCLUDED.error_code,
            updated_at = now()
        RETURNING id
        """
    ).bindparams(
        bindparam("requested_types", type_=JSONB),
        bindparam("result_refs", type_=JSONB),
        bindparam("selected_context_refs", type_=JSONB),
    )
    tool_call_id = db.execute(
        insert_tool,
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": run.tool_call_index,
            "query_hash": run.query_hash,
            "scope": run.scope,
            "requested_types": run.requested_types,
            "semantic": run.semantic,
            "result_refs": run.result_refs,
            "selected_context_refs": selected_context_refs,
            "latency_ms": run.latency_ms,
            "status": run.status,
            "error_code": run.error_code,
        },
    ).scalar_one()
    run.tool_call_id = tool_call_id

    db.execute(
        text("DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id"),
        {"tool_call_id": tool_call_id},
    )

    insert_retrieval = text(
        """
        INSERT INTO message_retrievals (
            tool_call_id,
            ordinal,
            result_type,
            source_id,
            media_id,
            context_ref,
            result_ref,
            deep_link,
            score,
            selected
        )
        VALUES (
            :tool_call_id,
            :ordinal,
            :result_type,
            :source_id,
            :media_id,
            :context_ref,
            :result_ref,
            :deep_link,
            :score,
            :selected
        )
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
    )
    selected_ids = {citation.source_id for citation in run.selected_citations}
    for ordinal, citation in enumerate(run.citations):
        db.execute(
            insert_retrieval,
            {
                "tool_call_id": tool_call_id,
                "ordinal": ordinal,
                "result_type": citation.result_type,
                "source_id": citation.source_id,
                "media_id": citation.media_id,
                "context_ref": citation.context_ref,
                "result_ref": citation.to_json(),
                "deep_link": citation.deep_link,
                "score": citation.score,
                "selected": citation.source_id in selected_ids,
            },
        )
    db.commit()


def render_retrieved_context_blocks(
    db: Session,
    *,
    viewer_id: UUID,
    citations: list[AppSearchCitation],
) -> tuple[str, int, list[AppSearchCitation]]:
    """Render selected search citations into bounded prompt context blocks."""
    rendered_blocks: list[str] = []
    selected: list[AppSearchCitation] = []
    total_chars = 0

    for citation in citations[:APP_SEARCH_SELECTED_LIMIT]:
        block = _render_single_retrieved_context(db, viewer_id, citation)
        if not block:
            continue
        block_chars = len(block)
        if total_chars + block_chars > APP_SEARCH_CONTEXT_CHARS:
            break
        citation.selected = True
        selected.append(citation)
        rendered_blocks.append(block)
        total_chars += block_chars

    if not rendered_blocks:
        return "", 0, selected
    return "\n\n".join(rendered_blocks), total_chars, selected


def _render_single_retrieved_context(
    db: Session,
    viewer_id: UUID,
    citation: AppSearchCitation,
) -> str | None:
    context_type = citation.context_ref.get("type")
    context_id = _parse_uuid(citation.context_ref.get("id"))
    if context_id is None:
        return None

    if context_type == "media":
        if not can_read_media(db, viewer_id, context_id):
            return None
        return render_context_blocks(db, [MessageContextRef(type="media", id=context_id)])[0]

    if context_type == "annotation":
        if not _can_read_annotation(db, viewer_id, context_id):
            return None
        return render_context_blocks(db, [MessageContextRef(type="annotation", id=context_id)])[0]

    if context_type == "fragment":
        return _render_fragment_context(db, viewer_id, context_id)

    if context_type == "transcript_chunk":
        return _render_transcript_chunk_context(db, viewer_id, context_id)

    if context_type == "message":
        return _render_message_context(db, viewer_id, context_id)

    if context_type == "podcast":
        return _render_podcast_context(db, viewer_id, context_id)

    return None


def _parse_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _format_timestamp_ms(timestamp_ms: int | None) -> str | None:
    if timestamp_ms is None:
        return None
    total_seconds = max(0, int(timestamp_ms) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _can_read_annotation(db: Session, viewer_id: UUID, annotation_id: UUID) -> bool:
    annotation = db.get(Annotation, annotation_id)
    if annotation is None or annotation.highlight is None:
        return False
    media_id = annotation.highlight.anchor_media_id
    return media_id is not None and can_read_media(db, viewer_id, media_id)


def _render_fragment_context(db: Session, viewer_id: UUID, fragment_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT
                f.media_id,
                f.canonical_text,
                f.t_start_ms,
                f.speaker_label,
                m.title,
                m.canonical_source_url
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            WHERE f.id = :fragment_id
            """
        ),
        {"fragment_id": fragment_id},
    ).fetchone()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None

    lines = ['<app_search_result type="fragment">', f"<source>{xml_escape(row[4])}</source>"]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    timestamp = _format_timestamp_ms(row[2])
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[3]:
        lines.append(f"<speaker>{xml_escape(row[3])}</speaker>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_transcript_chunk_context(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT
                tc.media_id,
                tc.chunk_text,
                tc.t_start_ms,
                tc.t_end_ms,
                m.title,
                m.canonical_source_url
            FROM podcast_transcript_chunks tc
            JOIN media m ON m.id = tc.media_id
            WHERE tc.id = :chunk_id
            """
        ),
        {"chunk_id": chunk_id},
    ).fetchone()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None

    lines = [
        '<app_search_result type="transcript_chunk">',
        f"<source>{xml_escape(row[4])}</source>",
    ]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    timestamp = _format_timestamp_ms(row[2])
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_message_context(db: Session, viewer_id: UUID, message_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT conversation_id, seq, role, content
            FROM messages
            WHERE id = :message_id
              AND status != 'pending'
            """
        ),
        {"message_id": message_id},
    ).fetchone()
    if row is None or not can_read_conversation(db, viewer_id, row[0]):
        return None

    return "\n".join(
        [
            '<app_search_result type="message">',
            f"<conversation_id>{row[0]}</conversation_id>",
            f"<message_seq>{row[1]}</message_seq>",
            f"<message_role>{xml_escape(row[2])}</message_role>",
            f"<excerpt>{xml_escape(row[3] or '')}</excerpt>",
            "</app_search_result>",
        ]
    )


def _render_podcast_context(db: Session, viewer_id: UUID, podcast_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT p.title, p.author, p.description, p.website_url
            FROM podcasts p
            WHERE p.id = :podcast_id
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
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None

    lines = ['<app_search_result type="podcast">', f"<source>{xml_escape(row[0])}</source>"]
    if row[1]:
        lines.append(f"<author>{xml_escape(row[1])}</author>")
    if row[3]:
        lines.append(f"<url>{xml_escape(row[3])}</url>")
    if row[2]:
        lines.append(f"<description>{xml_escape(row[2])}</description>")
    lines.append("</app_search_result>")
    return "\n".join(lines)
