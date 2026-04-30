"""Unified hydration for chat source refs and context refs."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media
from nexus.db.models import Annotation, Highlight, MessageContext, MessageRetrieval
from nexus.schemas.conversation import MessageContextRef
from nexus.services.context_rendering import render_context_blocks
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.quote_context_errors import QuoteContextBlockingError

LookupFailureCode = Literal[
    "invalid",
    "not_found",
    "forbidden",
    "unsupported",
    "too_large",
    "blocked",
]

SUPPORTED_CONTEXT_REF_TYPES = {
    "media",
    "highlight",
    "annotation",
    "fragment",
    "transcript_chunk",
    "message",
    "podcast",
    "web_result",
}
SUPPORTED_SOURCE_REF_TYPES = {
    "message",
    "message_context",
    "message_retrieval",
    "app_context_ref",
    "web_result",
}


@dataclass(frozen=True)
class ContextLookupFailure:
    code: LookupFailureCode
    message: str


@dataclass(frozen=True)
class ContextLookupResult:
    source_ref: Mapping[str, object]
    context_ref: Mapping[str, object] | None
    evidence_text: str
    estimated_tokens: int
    citations: tuple[Mapping[str, object], ...]
    failure: ContextLookupFailure | None = None

    @property
    def resolved(self) -> bool:
        return self.failure is None


class ContextLookupError(ValueError):
    """Raised by callers when a required lookup result failed."""

    def __init__(self, result: ContextLookupResult) -> None:
        failure = result.failure
        message = failure.message if failure is not None else "Context lookup failed"
        super().__init__(message)
        self.result = result


def hydrate_context_ref(
    db: Session,
    *,
    viewer_id: UUID,
    context_ref: Mapping[str, object],
    max_chars: int = 12000,
) -> ContextLookupResult:
    """Hydrate an app context_ref into bounded evidence text."""

    context_type = context_ref.get("type")
    context_id = _parse_uuid(context_ref.get("id"))
    source_ref = {"type": "app_context_ref", "context_ref": dict(context_ref)}
    if not isinstance(context_type, str) or context_type not in SUPPORTED_CONTEXT_REF_TYPES:
        return _failed(source_ref, context_ref, "unsupported", "Unsupported context_ref type")
    if context_type != "web_result" and context_id is None:
        return _failed(source_ref, context_ref, "invalid", "context_ref id is invalid")

    if context_type == "media":
        assert context_id is not None
        if not can_read_media(db, viewer_id, context_id):
            return _failed(source_ref, context_ref, "forbidden", "Context not readable")
        text_block = _render_message_context_ref(
            db,
            MessageContextRef(type="media", id=context_id),
        )
        return _resolve_text_result(source_ref, context_ref, text_block, max_chars=max_chars)

    if context_type == "highlight":
        assert context_id is not None
        if not _can_read_highlight(db, viewer_id, context_id):
            return _failed(source_ref, context_ref, "forbidden", "Context not readable")
        text_block = _render_message_context_ref(
            db,
            MessageContextRef(type="highlight", id=context_id),
        )
        return _resolve_text_result(source_ref, context_ref, text_block, max_chars=max_chars)

    if context_type == "annotation":
        assert context_id is not None
        if not _can_read_annotation(db, viewer_id, context_id):
            return _failed(source_ref, context_ref, "forbidden", "Context not readable")
        text_block = _render_message_context_ref(
            db,
            MessageContextRef(type="annotation", id=context_id),
        )
        return _resolve_text_result(source_ref, context_ref, text_block, max_chars=max_chars)

    if context_type == "fragment":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            _render_fragment_context(db, viewer_id, context_id),
            max_chars=max_chars,
        )

    if context_type == "transcript_chunk":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            _render_transcript_chunk_context(db, viewer_id, context_id),
            max_chars=max_chars,
        )

    if context_type == "message":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            _render_message_context(db, viewer_id, context_id),
            max_chars=max_chars,
        )

    if context_type == "podcast":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            _render_podcast_context(db, viewer_id, context_id),
            max_chars=max_chars,
        )

    if context_type == "web_result":
        result_ref = context_ref.get("result_ref")
        if not isinstance(result_ref, Mapping):
            return _failed(source_ref, context_ref, "invalid", "web_result requires result_ref")
        return _resolved(
            source_ref,
            context_ref,
            _render_web_result(result_ref),
            max_chars=max_chars,
            citations=(dict(result_ref),),
        )

    return _failed(source_ref, context_ref, "unsupported", "Unsupported context_ref type")


def hydrate_source_ref(
    db: Session,
    *,
    viewer_id: UUID,
    source_ref: Mapping[str, object],
    max_chars: int = 12000,
) -> ContextLookupResult:
    """Hydrate a SourceRef into bounded evidence text with permission checks."""

    source_type = source_ref.get("type")
    if not isinstance(source_type, str) or source_type not in SUPPORTED_SOURCE_REF_TYPES:
        return _failed(source_ref, None, "unsupported", "Unsupported source_ref type")

    if source_type == "message":
        message_id = _parse_uuid(source_ref.get("message_id") or source_ref.get("id"))
        if message_id is None:
            return _failed(source_ref, None, "invalid", "message source_ref id is invalid")
        return _resolve_text_result(
            source_ref,
            {"type": "message", "id": str(message_id)},
            _render_message_context(db, viewer_id, message_id),
            max_chars=max_chars,
        )

    if source_type == "message_context":
        context_row_id = _parse_uuid(source_ref.get("message_context_id") or source_ref.get("id"))
        if context_row_id is None:
            return _failed(source_ref, None, "invalid", "message_context source_ref id is invalid")
        context_ref = _context_ref_from_message_context(db, viewer_id, context_row_id)
        if context_ref is None:
            return _failed(source_ref, None, "not_found", "Message context not found")
        nested = hydrate_context_ref(
            db,
            viewer_id=viewer_id,
            context_ref=context_ref,
            max_chars=max_chars,
        )
        return _with_source_ref(nested, source_ref)

    if source_type == "message_retrieval":
        retrieval_id = _parse_uuid(source_ref.get("retrieval_id") or source_ref.get("id"))
        if retrieval_id is None:
            return _failed(source_ref, None, "invalid", "message_retrieval id is invalid")
        return _hydrate_message_retrieval(
            db,
            viewer_id=viewer_id,
            retrieval_id=retrieval_id,
            source_ref=source_ref,
            max_chars=max_chars,
        )

    if source_type == "app_context_ref":
        context_ref = source_ref.get("context_ref")
        if not isinstance(context_ref, Mapping):
            return _failed(source_ref, None, "invalid", "app_context_ref requires context_ref")
        nested = hydrate_context_ref(
            db,
            viewer_id=viewer_id,
            context_ref=context_ref,
            max_chars=max_chars,
        )
        return _with_source_ref(nested, source_ref)

    if source_type == "web_result":
        result_ref = source_ref.get("result_ref")
        if not isinstance(result_ref, Mapping):
            return _failed(source_ref, None, "invalid", "web_result requires result_ref")
        return _resolved(
            source_ref,
            {"type": "web_result", "id": str(source_ref.get("id") or result_ref.get("result_ref"))},
            _render_web_result(result_ref),
            max_chars=max_chars,
            citations=(dict(result_ref),),
        )

    return _failed(source_ref, None, "unsupported", "Unsupported source_ref type")


def hydrate_source_refs(
    db: Session,
    *,
    viewer_id: UUID,
    source_refs: Sequence[Mapping[str, object]],
    max_chars: int = 12000,
) -> list[ContextLookupResult]:
    return [
        hydrate_source_ref(db, viewer_id=viewer_id, source_ref=source_ref, max_chars=max_chars)
        for source_ref in source_refs
    ]


def _hydrate_message_retrieval(
    db: Session,
    *,
    viewer_id: UUID,
    retrieval_id: UUID,
    source_ref: Mapping[str, object],
    max_chars: int,
) -> ContextLookupResult:
    retrieval = db.get(MessageRetrieval, retrieval_id)
    if retrieval is None:
        return _failed(source_ref, None, "not_found", "Message retrieval not found")
    tool_call = retrieval.tool_call
    if tool_call is None or not can_read_conversation(db, viewer_id, tool_call.conversation_id):
        return _failed(source_ref, None, "forbidden", "Retrieval not readable")
    if retrieval.result_type == "web_result":
        return _resolved(
            source_ref,
            retrieval.context_ref,
            _render_web_result(retrieval.result_ref),
            max_chars=max_chars,
            citations=(retrieval.result_ref,),
        )
    nested = hydrate_context_ref(
        db,
        viewer_id=viewer_id,
        context_ref=retrieval.context_ref,
        max_chars=max_chars,
    )
    return _with_source_ref(nested, source_ref, citations=(retrieval.result_ref,))


def _context_ref_from_message_context(
    db: Session,
    viewer_id: UUID,
    context_row_id: UUID,
) -> dict[str, object] | None:
    row = db.execute(
        select(MessageContext).where(MessageContext.id == context_row_id)
    ).scalar_one_or_none()
    if row is None or row.message is None:
        return None
    if not can_read_conversation(db, viewer_id, row.message.conversation_id):
        return None
    if row.target_type == "media" and row.media_id is not None:
        return {"type": "media", "id": str(row.media_id)}
    if row.target_type == "highlight" and row.highlight_id is not None:
        return {"type": "highlight", "id": str(row.highlight_id)}
    if row.target_type == "annotation" and row.annotation_id is not None:
        return {"type": "annotation", "id": str(row.annotation_id)}
    return None


def _resolve_text_result(
    source_ref: Mapping[str, object],
    context_ref: Mapping[str, object] | None,
    rendered: str | ContextLookupFailure,
    *,
    max_chars: int,
) -> ContextLookupResult:
    if isinstance(rendered, ContextLookupFailure):
        return _failed(source_ref, context_ref, rendered.code, rendered.message)
    return _resolved(source_ref, context_ref, rendered, max_chars=max_chars)


def _render_message_context_ref(
    db: Session,
    context_ref: MessageContextRef,
) -> str | ContextLookupFailure:
    try:
        return render_context_blocks(db, [context_ref])[0]
    except QuoteContextBlockingError as exc:
        return ContextLookupFailure(
            code="blocked",
            message=f"Context cannot be rendered: {exc.error_code.value}",
        )


def _resolved(
    source_ref: Mapping[str, object],
    context_ref: Mapping[str, object] | None,
    evidence_text: str,
    *,
    max_chars: int,
    citations: Sequence[Mapping[str, object]] = (),
) -> ContextLookupResult:
    if not evidence_text:
        return _failed(source_ref, context_ref, "not_found", "Context had no renderable evidence")
    if len(evidence_text) > max_chars:
        return _failed(source_ref, context_ref, "too_large", "Context evidence is too large")
    return ContextLookupResult(
        source_ref=source_ref,
        context_ref=context_ref,
        evidence_text=evidence_text,
        estimated_tokens=estimate_tokens(evidence_text),
        citations=tuple(citations),
        failure=None,
    )


def _failed(
    source_ref: Mapping[str, object],
    context_ref: Mapping[str, object] | None,
    code: LookupFailureCode,
    message: str,
) -> ContextLookupResult:
    return ContextLookupResult(
        source_ref=source_ref,
        context_ref=context_ref,
        evidence_text="",
        estimated_tokens=0,
        citations=(),
        failure=ContextLookupFailure(code=code, message=message),
    )


def _with_source_ref(
    result: ContextLookupResult,
    source_ref: Mapping[str, object],
    citations: Sequence[Mapping[str, object]] | None = None,
) -> ContextLookupResult:
    return ContextLookupResult(
        source_ref=source_ref,
        context_ref=result.context_ref,
        evidence_text=result.evidence_text,
        estimated_tokens=result.estimated_tokens,
        citations=tuple(citations) if citations is not None else result.citations,
        failure=result.failure,
    )


def _can_read_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> bool:
    highlight = db.get(Highlight, highlight_id)
    media_id = _highlight_anchor_media_id(highlight) if highlight is not None else None
    return media_id is not None and can_read_media(db, viewer_id, media_id)


def _can_read_annotation(db: Session, viewer_id: UUID, annotation_id: UUID) -> bool:
    annotation = db.get(Annotation, annotation_id)
    highlight = annotation.highlight if annotation is not None else None
    media_id = _highlight_anchor_media_id(highlight) if highlight is not None else None
    return media_id is not None and can_read_media(db, viewer_id, media_id)


def _highlight_anchor_media_id(highlight: Highlight | None) -> UUID | None:
    if highlight is None or highlight.anchor_media_id is None:
        return None
    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        fragment = fragment_anchor.fragment if fragment_anchor is not None else None
        if fragment is not None and fragment.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
        return None
    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is not None and pdf_anchor.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
        return None
    return None


def _render_fragment_context(
    db: Session,
    viewer_id: UUID,
    fragment_id: UUID,
) -> str | ContextLookupFailure:
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
    if row is None:
        return ContextLookupFailure(code="not_found", message="Fragment not found")
    if not can_read_media(db, viewer_id, row[0]):
        return ContextLookupFailure(code="forbidden", message="Fragment not readable")

    lines = ['<context_lookup_result type="fragment">', f"<source>{xml_escape(row[4])}</source>"]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    timestamp = _format_timestamp_ms(row[2])
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[3]:
        lines.append(f"<speaker>{xml_escape(row[3])}</speaker>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_transcript_chunk_context(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
) -> str | ContextLookupFailure:
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
            FROM content_chunks tc
            JOIN media m ON m.id = tc.media_id
            WHERE tc.id = :chunk_id
              AND tc.source_kind = 'transcript'
            """
        ),
        {"chunk_id": chunk_id},
    ).fetchone()
    if row is None:
        return ContextLookupFailure(code="not_found", message="Transcript chunk not found")
    if not can_read_media(db, viewer_id, row[0]):
        return ContextLookupFailure(code="forbidden", message="Transcript chunk not readable")

    lines = [
        '<context_lookup_result type="transcript_chunk">',
        f"<source>{xml_escape(row[4])}</source>",
    ]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    timestamp = _format_timestamp_ms(row[2])
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_message_context(
    db: Session,
    viewer_id: UUID,
    message_id: UUID,
) -> str | ContextLookupFailure:
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
    if row is None:
        return ContextLookupFailure(code="not_found", message="Message not found")
    if not can_read_conversation(db, viewer_id, row[0]):
        return ContextLookupFailure(code="forbidden", message="Message not readable")

    return "\n".join(
        [
            '<context_lookup_result type="message">',
            f"<conversation_id>{row[0]}</conversation_id>",
            f"<message_seq>{row[1]}</message_seq>",
            f"<message_role>{xml_escape(row[2])}</message_role>",
            f"<excerpt>{xml_escape(row[3] or '')}</excerpt>",
            "</context_lookup_result>",
        ]
    )


def _render_podcast_context(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> str | ContextLookupFailure:
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
        return ContextLookupFailure(code="not_found", message="Podcast not found")

    lines = ['<context_lookup_result type="podcast">', f"<source>{xml_escape(row[0])}</source>"]
    if row[1]:
        lines.append(f"<author>{xml_escape(row[1])}</author>")
    if row[3]:
        lines.append(f"<url>{xml_escape(row[3])}</url>")
    if row[2]:
        lines.append(f"<description>{xml_escape(row[2])}</description>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_web_result(result_ref: Mapping[str, object]) -> str:
    title = str(result_ref.get("title") or "")
    url = str(result_ref.get("url") or "")
    lines = [
        f'<web_search_result ref="{xml_escape(str(result_ref.get("result_ref") or ""))}">',
        f"<title>{xml_escape(title)}</title>",
    ]
    if url:
        lines.append(f"<url>{xml_escape(url)}</url>")
    source_name = result_ref.get("source_name")
    if isinstance(source_name, str) and source_name:
        lines.append(f"<source>{xml_escape(source_name)}</source>")
    published_at = result_ref.get("published_at")
    if isinstance(published_at, str) and published_at:
        lines.append(f"<published_at>{xml_escape(published_at)}</published_at>")
    snippet = result_ref.get("snippet")
    if isinstance(snippet, str) and snippet:
        lines.append(f"<excerpt>{xml_escape(snippet)}</excerpt>")
    extra_snippets = result_ref.get("extra_snippets")
    if isinstance(extra_snippets, Sequence) and not isinstance(extra_snippets, str):
        for extra_snippet in extra_snippets:
            if isinstance(extra_snippet, str) and extra_snippet:
                lines.append(f"<excerpt>{xml_escape(extra_snippet)}</excerpt>")
    lines.append("</web_search_result>")
    return "\n".join(lines)


def _format_timestamp_ms(timestamp_ms: int | None) -> str | None:
    if timestamp_ms is None:
        return None
    total_seconds = max(0, int(timestamp_ms) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _parse_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None
