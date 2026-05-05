"""Unified hydration for chat source refs and context refs."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_highlight, can_read_media
from nexus.db.models import Contributor, MessageContextItem, MessageRetrieval
from nexus.errors import NotFoundError
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.notes import ObjectRef
from nexus.services.context_rendering import render_context_blocks
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.contributors import get_contributor_by_handle, get_contributor_by_id
from nexus.services.object_refs import render_object_context
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
    "page",
    "note_block",
    "content_chunk",
    "message",
    "podcast",
    "contributor",
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
    if context_type not in {"web_result", "contributor"} and context_id is None:
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

    if context_type == "page":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            render_object_context(
                db,
                viewer_id,
                ObjectRef(object_type="page", object_id=context_id),
            ),
            max_chars=max_chars,
        )

    if context_type == "note_block":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            render_object_context(
                db,
                viewer_id,
                ObjectRef(object_type="note_block", object_id=context_id),
            ),
            max_chars=max_chars,
        )

    if context_type == "content_chunk":
        assert context_id is not None
        return _resolve_text_result(
            source_ref,
            context_ref,
            _render_content_chunk_context(
                db,
                viewer_id,
                context_id,
                _evidence_span_ids_from_context_ref(context_ref),
            ),
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

    if context_type == "contributor":
        rendered_contributor = _render_contributor_context(
            db,
            viewer_id,
            context_ref.get("contributor_handle")
            or context_ref.get("handle")
            or context_ref.get("id"),
        )
        if isinstance(rendered_contributor, ContextLookupFailure):
            return _failed(
                source_ref,
                context_ref,
                rendered_contributor.code,
                rendered_contributor.message,
            )
        contributor_handle, text_block = rendered_contributor
        return _resolve_text_result(
            source_ref,
            {
                "type": "contributor",
                "id": contributor_handle,
                "contributor_handle": contributor_handle,
            },
            text_block,
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
    if retrieval.result_ref.get("status") in {"no_indexed_evidence", "no_results"}:
        return _resolved(
            source_ref,
            retrieval.context_ref,
            _render_app_search_status(retrieval.result_ref),
            max_chars=max_chars,
            citations=(retrieval.result_ref,),
        )
    if retrieval.result_type == "web_result":
        return _resolved(
            source_ref,
            retrieval.context_ref,
            _render_web_result(retrieval.result_ref),
            max_chars=max_chars,
            citations=(retrieval.result_ref,),
        )
    if retrieval.evidence_span_id is not None:
        text_block = _render_evidence_span_context(
            db,
            viewer_id,
            retrieval.evidence_span_id,
            index_run_id=_index_run_id_from_content_chunk_context_ref(db, retrieval.context_ref),
        )
        if isinstance(text_block, ContextLookupFailure):
            return _failed(source_ref, retrieval.context_ref, text_block.code, text_block.message)
        return _resolved(
            source_ref,
            _context_ref_with_evidence_span_id(
                retrieval.context_ref,
                retrieval.evidence_span_id,
            ),
            text_block,
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
        select(MessageContextItem).where(MessageContextItem.id == context_row_id)
    ).scalar_one_or_none()
    if row is None or row.message is None:
        return None
    if not can_read_conversation(db, viewer_id, row.message.conversation_id):
        return None
    if row.object_type == "contributor":
        contributor_handle = db.scalar(
            select(Contributor.handle).where(
                Contributor.id == row.object_id,
                Contributor.status.in_(("unverified", "verified")),
            )
        )
        if contributor_handle is None:
            return None
        return {
            "type": "contributor",
            "id": contributor_handle,
            "contributor_handle": contributor_handle,
        }
    context_ref: dict[str, object] = {"type": row.object_type, "id": str(row.object_id)}
    if row.object_type == "content_chunk":
        evidence_span_ids = _evidence_span_ids_from_context_ref(row.context_snapshot_json)
        if evidence_span_ids:
            context_ref["evidence_span_ids"] = [
                str(evidence_span_id) for evidence_span_id in evidence_span_ids
            ]
    return context_ref


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


def _context_ref_with_evidence_span_id(
    context_ref: Mapping[str, object],
    evidence_span_id: UUID,
) -> dict[str, object]:
    next_ref = dict(context_ref)
    evidence_span_ids = _evidence_span_ids_from_context_ref(next_ref)
    if evidence_span_id not in evidence_span_ids:
        evidence_span_ids.append(evidence_span_id)
    next_ref["evidence_span_ids"] = [str(span_id) for span_id in evidence_span_ids]
    return next_ref


def _can_read_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> bool:
    return can_read_highlight(db, viewer_id, highlight_id)


def _render_content_chunk_context(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
    evidence_span_ids: Sequence[UUID] = (),
) -> str | ContextLookupFailure:
    if evidence_span_ids:
        return _render_content_chunk_evidence_spans(
            db,
            viewer_id,
            chunk_id,
            evidence_span_ids,
        )

    row = db.execute(
        text(
            """
            SELECT
                cc.media_id,
                cc.chunk_text,
                cc.summary_locator,
                cc.source_kind,
                m.title,
                m.canonical_source_url
            FROM content_chunks cc
            JOIN media m ON m.id = cc.media_id
            WHERE cc.id = :chunk_id
            """
        ),
        {"chunk_id": chunk_id},
    ).fetchone()
    if row is None:
        return ContextLookupFailure(code="not_found", message="Content chunk not found")
    if not can_read_media(db, viewer_id, row[0]):
        return ContextLookupFailure(code="forbidden", message="Content chunk not readable")

    lines = [
        '<context_lookup_result type="content_chunk">',
        f"<source>{xml_escape(row[4])}</source>",
    ]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    locator = dict(row[2] or {})
    timestamp = _format_timestamp_ms(locator.get("t_start_ms"))
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[3]:
        lines.append(f"<source_kind>{xml_escape(str(row[3]))}</source_kind>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_content_chunk_evidence_spans(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
    evidence_span_ids: Sequence[UUID],
) -> str | ContextLookupFailure:
    lines: list[str] = []
    seen: set[UUID] = set()
    media_id: UUID | None = None
    for evidence_span_id in evidence_span_ids:
        if evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        row = db.execute(
            text(
                """
                SELECT
                    cc.media_id,
                    cc.source_kind,
                    m.title,
                    m.canonical_source_url,
                    es.id,
                    es.citation_label,
                    es.span_text
                FROM content_chunks cc
                JOIN evidence_spans es ON es.id = :evidence_span_id
                    AND es.media_id = cc.media_id
                    AND es.index_run_id = cc.index_run_id
                JOIN media m ON m.id = cc.media_id
                WHERE cc.id = :chunk_id
                """
            ),
            {"chunk_id": chunk_id, "evidence_span_id": evidence_span_id},
        ).fetchone()
        if row is None:
            continue
        if media_id is None:
            media_id = row[0]
            if not can_read_media(db, viewer_id, media_id):
                return ContextLookupFailure(code="forbidden", message="Content chunk not readable")
            lines.extend(
                [
                    '<context_lookup_result type="content_chunk">',
                    f"<source>{xml_escape(row[2])}</source>",
                ]
            )
            if row[3]:
                lines.append(f"<url>{xml_escape(row[3])}</url>")
            if row[1]:
                lines.append(f"<source_kind>{xml_escape(str(row[1]))}</source_kind>")
        lines.append(f"<evidence_span_id>{row[4]}</evidence_span_id>")
        lines.append(f"<citation_label>{xml_escape(row[5])}</citation_label>")
        lines.append(f"<evidence_span>{xml_escape(row[6] or '')}</evidence_span>")

    if not lines:
        return ContextLookupFailure(code="not_found", message="Evidence span not found")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_evidence_span_context(
    db: Session,
    viewer_id: UUID,
    evidence_span_id: UUID,
    *,
    index_run_id: UUID | None = None,
) -> str | ContextLookupFailure:
    run_filter = ""
    params = {"evidence_span_id": evidence_span_id}
    if index_run_id is not None:
        run_filter = "AND es.index_run_id = :index_run_id"
        params["index_run_id"] = index_run_id

    row = db.execute(
        text(
            f"""
            SELECT
                es.media_id,
                es.span_text,
                es.citation_label,
                es.resolver_kind,
                m.title,
                m.canonical_source_url
            FROM evidence_spans es
            JOIN media m ON m.id = es.media_id
            WHERE es.id = :evidence_span_id
              {run_filter}
            """
        ),
        params,
    ).fetchone()
    if row is None:
        return ContextLookupFailure(code="not_found", message="Evidence span not found")
    if not can_read_media(db, viewer_id, row[0]):
        return ContextLookupFailure(code="forbidden", message="Evidence span not readable")

    lines = [
        '<context_lookup_result type="evidence_span">',
        f"<source>{xml_escape(row[4])}</source>",
        f"<evidence_span_id>{evidence_span_id}</evidence_span_id>",
        f"<citation_label>{xml_escape(row[2])}</citation_label>",
        f"<source_kind>{xml_escape(row[3])}</source_kind>",
    ]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    lines.append(f"<excerpt>{xml_escape(row[1] or '')}</excerpt>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _index_run_id_from_content_chunk_context_ref(
    db: Session,
    context_ref: Mapping[str, object],
) -> UUID | None:
    if context_ref.get("type") != "content_chunk":
        return None
    chunk_id = _parse_uuid(context_ref.get("id"))
    if chunk_id is None:
        return None
    return db.execute(
        text("SELECT index_run_id FROM content_chunks WHERE id = :chunk_id"),
        {"chunk_id": chunk_id},
    ).scalar_one_or_none()


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
            SELECT p.title, p.description, p.website_url
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
    contributors = load_contributor_credits_for_podcasts(db, [podcast_id]).get(podcast_id, [])
    if contributors:
        lines.append("<contributors>")
        for contributor in contributors:
            lines.append(
                f'<contributor role="{xml_escape(contributor.role)}">'
                f"{xml_escape(contributor.credited_name)}</contributor>"
            )
        lines.append("</contributors>")
    if row[2]:
        lines.append(f"<url>{xml_escape(row[2])}</url>")
    if row[1]:
        lines.append(f"<description>{xml_escape(row[1])}</description>")
    lines.append("</context_lookup_result>")
    return "\n".join(lines)


def _render_contributor_context(
    db: Session, viewer_id: UUID, contributor_ref: object
) -> tuple[str, str] | ContextLookupFailure:
    ref_text = str(contributor_ref or "").strip()
    if not ref_text:
        return ContextLookupFailure(code="invalid", message="Contributor handle is invalid")
    contributor_id = _parse_uuid(ref_text)
    if contributor_id is not None:
        try:
            contributor = get_contributor_by_id(db, contributor_id, viewer_id=viewer_id)
        except NotFoundError:
            return ContextLookupFailure(code="not_found", message="Contributor not found")
    else:
        try:
            contributor = get_contributor_by_handle(db, ref_text, viewer_id=viewer_id)
        except NotFoundError:
            return ContextLookupFailure(code="not_found", message="Contributor not found")

    handle = contributor.handle
    lines = [
        '<context_lookup_result type="contributor">',
        f"<contributor_handle>{xml_escape(handle)}</contributor_handle>",
        f"<display_name>{xml_escape(contributor.display_name)}</display_name>",
    ]
    if contributor.sort_name:
        lines.append(f"<sort_name>{xml_escape(contributor.sort_name)}</sort_name>")
    if contributor.kind:
        lines.append(f"<kind>{xml_escape(contributor.kind)}</kind>")
    if contributor.disambiguation:
        lines.append(f"<disambiguation>{xml_escape(contributor.disambiguation)}</disambiguation>")
    lines.append("</context_lookup_result>")
    return handle, "\n".join(lines)


def _render_app_search_status(result_ref: Mapping[str, object]) -> str:
    return (
        f'<app_search_results status="{xml_escape(str(result_ref.get("status") or "no_results"))}" '
        f'scope="{xml_escape(str(result_ref.get("scope") or "all"))}" '
        f'filters="{xml_escape(json.dumps(result_ref.get("filters") or {}, sort_keys=True))}" />'
    )


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


def _evidence_span_ids_from_context_ref(context_ref: Mapping[str, object]) -> list[UUID]:
    raw_values = context_ref.get("evidence_span_ids")
    if raw_values is None:
        raw_values = context_ref.get("evidenceSpanIds")
    if raw_values is None:
        raw_values = context_ref.get("evidence_span_id")
    if raw_values is None:
        raw_values = context_ref.get("evidenceSpanId")
    if isinstance(raw_values, str):
        values = [raw_values]
    elif isinstance(raw_values, Sequence) and not isinstance(raw_values, (str, bytes)):
        values = list(raw_values)
    else:
        values = []

    evidence_span_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        evidence_span_id = _parse_uuid(value)
        if evidence_span_id is None or evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        evidence_span_ids.append(evidence_span_id)
    return evidence_span_ids


def _parse_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None
