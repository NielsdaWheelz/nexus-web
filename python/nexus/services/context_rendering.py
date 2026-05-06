"""Context rendering for LLM prompts.

 Renders context items into XML-tagged blocks
for inclusion in LLM prompts.

Per S3 spec:
- Context blocks include source, metadata, exact quote, surrounding context
- Context cap: 25,000 chars total
- Max 10 context items per message

Note: This module has DB access and is intentionally kept outside the LLM
adapter layer (which must be DB-free per PR-04 spec).
"""

import json
from collections.abc import Sequence
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentChunk,
    Contributor,
    Conversation,
    EvidenceSpan,
    Highlight,
    HighlightPdfAnchor,
    Media,
    Message,
    NoteBlock,
    Page,
    PdfPageTextSpan,
    Podcast,
)
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.conversation import ContextItem, MessageContextRef, ReaderSelectionContext
from nexus.services.context_window import get_context_window
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.pdf_quote_match import MatcherAnomaly, MatchStatus, compute_match
from nexus.services.pdf_quote_match_policy import (
    CoherenceAnomalyKind,
    CoherenceFallbackAction,
    PdfQuoteMatchInternalError,
    handle_coherence_unclassified_exception,
    handle_recoverable_anomaly,
    handle_recoverable_coherence_anomaly,
    handle_unclassified_exception,
)
from nexus.services.pdf_readiness import is_pdf_quote_text_ready
from nexus.services.quote_context_errors import QuoteContextBlockingError

logger = get_logger(__name__)

# System prompt version (tracked in message_llm.prompt_version)
PROMPT_VERSION = "v2"

# Limits
MAX_CONTEXTS = 10
MAX_CONTEXT_CHARS = 25000
_PDF_CONTEXT_RENDER_PATH = "pdf_quote_context_render"


def _format_timestamp_ms(timestamp_ms: int) -> str:
    total_seconds = max(0, timestamp_ms // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _resolve_renderable_highlight_kind(highlight: Highlight) -> str | None:
    """Return the canonical anchor kind if the typed highlight is renderable."""
    if highlight.anchor_media_id is None:
        return None

    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        fragment = fragment_anchor.fragment if fragment_anchor is not None else None
        if fragment is not None and fragment.media_id == highlight.anchor_media_id:
            return "fragment_offsets"

    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is not None and pdf_anchor.media_id == highlight.anchor_media_id:
            return "pdf_page_geometry"

    return None


def render_context_blocks(
    db: Session,
    contexts: Sequence[ContextItem],
) -> tuple[str, int]:
    """Render context items into XML-tagged blocks for the prompt.

    Args:
        db: Database session.
        contexts: Ordered canonical typed context targets.

    Returns:
        Tuple of (rendered_context_text, total_chars).

    Note:
        Contexts that fail to render are logged and skipped.
        Total chars is capped at MAX_CONTEXT_CHARS.
    """
    if not contexts:
        return "", 0

    # Limit to max contexts
    if len(contexts) > MAX_CONTEXTS:
        logger.warning(
            "context_limit_exceeded",
            requested=len(contexts),
            limit=MAX_CONTEXTS,
        )
        contexts = contexts[:MAX_CONTEXTS]

    rendered_blocks: list[str] = []
    total_chars = 0

    for ctx in contexts:
        try:
            block = _render_single_context(db, ctx)
            if block:
                block_chars = len(block)

                # Check if adding this block would exceed limit
                if total_chars + block_chars > MAX_CONTEXT_CHARS:
                    logger.info(
                        "context_char_limit_reached",
                        current_chars=total_chars,
                        block_chars=block_chars,
                        limit=MAX_CONTEXT_CHARS,
                    )
                    break

                rendered_blocks.append(block)
                total_chars += block_chars

        except QuoteContextBlockingError:
            raise
        except Exception as e:
            logger.warning(
                "context_render_failed",
                context_type=_context_log_type(ctx),
                context_id=_context_log_id(ctx),
                error=str(e),
            )
            continue

    if rendered_blocks:
        return "\n\n".join(rendered_blocks), total_chars

    return "", 0


def render_conversation_scope_block(scope_metadata: dict[str, object]) -> str:
    scope_type = scope_metadata.get("type")
    if scope_type == "general":
        return ""

    if scope_type == "media":
        lines = ['<conversation_scope type="media">']
        title = scope_metadata.get("title")
        if isinstance(title, str) and title:
            lines.append(f"<title>{xml_escape(title)}</title>")
        media_kind = scope_metadata.get("media_kind")
        if isinstance(media_kind, str) and media_kind:
            lines.append(f"<media_kind>{xml_escape(media_kind)}</media_kind>")
        contributors = scope_metadata.get("contributors")
        if isinstance(contributors, list) and contributors:
            lines.append("<contributors>")
            for contributor in contributors:
                if not isinstance(contributor, dict):
                    continue
                credited_name = contributor.get("credited_name")
                role = contributor.get("role")
                if isinstance(credited_name, str) and credited_name:
                    role_attr = f' role="{xml_escape(role)}"' if isinstance(role, str) else ""
                    lines.append(
                        f"<contributor{role_attr}>{xml_escape(credited_name)}</contributor>"
                    )
            lines.append("</contributors>")
        published_date = scope_metadata.get("published_date")
        if isinstance(published_date, str) and published_date:
            lines.append(f"<publication_date>{xml_escape(published_date)}</publication_date>")
        publisher = scope_metadata.get("publisher")
        if isinstance(publisher, str) and publisher:
            lines.append(f"<publisher>{xml_escape(publisher)}</publisher>")
        canonical_source_url = scope_metadata.get("canonical_source_url")
        if isinstance(canonical_source_url, str) and canonical_source_url:
            lines.append(
                f"<canonical_source_url>{xml_escape(canonical_source_url)}</canonical_source_url>"
            )
        lines.append("</conversation_scope>")
        return "\n".join(lines)

    if scope_type == "library":
        lines = ['<conversation_scope type="library">']
        title = scope_metadata.get("title")
        if isinstance(title, str) and title:
            lines.append(f"<name>{xml_escape(title)}</name>")
        entry_count = scope_metadata.get("entry_count")
        if isinstance(entry_count, int):
            lines.append(f"<entry_count>{entry_count}</entry_count>")
        media_kinds = scope_metadata.get("media_kinds")
        if isinstance(media_kinds, list) and media_kinds:
            lines.append("<media_kinds>")
            for media_kind in media_kinds:
                if isinstance(media_kind, str) and media_kind:
                    lines.append(f"<media_kind>{xml_escape(media_kind)}</media_kind>")
            lines.append("</media_kinds>")
        source_policy = scope_metadata.get("source_policy")
        if isinstance(source_policy, str) and source_policy:
            lines.append(f"<source_policy>{xml_escape(source_policy)}</source_policy>")
        lines.append("</conversation_scope>")
        return "\n".join(lines)

    return ""


def _context_log_type(ctx: ContextItem) -> str:
    if ctx.kind == "reader_selection":
        return "reader_selection"
    return ctx.type


def _context_log_id(ctx: ContextItem) -> str:
    if ctx.kind == "reader_selection":
        return str(ctx.client_context_id)
    return str(ctx.id)


def _render_single_context(db: Session, ctx: ContextItem) -> str | None:
    """Render a single context item to an XML block."""
    if ctx.kind == "reader_selection":
        return _render_reader_selection_context(ctx)

    ctx_type = ctx.type
    ctx_id = ctx.id

    if ctx_type == "media":
        return _render_media_context(db, ctx_id)
    if ctx_type == "highlight":
        return _render_highlight_context(db, ctx_id)
    if ctx_type in {"page", "note_block"}:
        return _render_note_context(db, ctx_type, ctx_id)
    if ctx_type == "conversation":
        return _render_conversation_context(db, ctx_id)
    if ctx_type == "message":
        return _render_message_context(db, ctx_id)
    if ctx_type == "podcast":
        return _render_podcast_context(db, ctx_id)
    if ctx_type == "content_chunk":
        return _render_content_chunk_context(db, ctx)
    if ctx_type == "contributor":
        return _render_contributor_context(db, ctx_id)
    logger.warning("unknown_context_type", context_type=ctx_type)
    return None


def _render_reader_selection_context(ctx: ReaderSelectionContext) -> str:
    lines = [
        "<reader_selection>",
        f"<source>{xml_escape(ctx.media_title)}</source>",
        f"<media_kind>{xml_escape(ctx.media_kind)}</media_kind>",
        f"<quote>{xml_escape(ctx.exact)}</quote>",
    ]
    surrounding = f"{ctx.prefix or ''}{ctx.exact}{ctx.suffix or ''}"
    if surrounding != ctx.exact:
        lines.append(f"<surrounding>{xml_escape(surrounding)}</surrounding>")
    lines.append(
        "<source_locator>"
        f"{xml_escape(json.dumps(ctx.locator, sort_keys=True, separators=(',', ':')))}"
        "</source_locator>"
    )
    lines.append("</reader_selection>")
    return "\n".join(lines)


def _render_media_context(db: Session, media_id: UUID) -> str | None:
    """Render a media context (just metadata, no excerpt)."""
    media = db.get(Media, media_id)
    if not media:
        return None

    lines = ["<media>", f"<source>{xml_escape(media.title)}</source>"]
    if media.canonical_source_url:
        lines.append(f"<url>{xml_escape(media.canonical_source_url)}</url>")
    lines.append("</media>")
    return "\n".join(lines)


def _render_highlight_context(db: Session, highlight_id: UUID) -> str | None:
    """Render a highlight context with quote and surrounding context."""
    highlight = db.get(Highlight, highlight_id)
    if not highlight:
        return None

    anchor_kind = _resolve_renderable_highlight_kind(highlight)
    if anchor_kind is None:
        logger.warning(
            "context_render_highlight_unrenderable",
            highlight_id=str(highlight_id),
            anchor_kind=highlight.anchor_kind,
        )
        return None

    if anchor_kind == "fragment_offsets":
        return _render_fragment_highlight_context(db, highlight)

    return _render_pdf_highlight_context(db, highlight)


def _render_fragment_highlight_context(db, highlight) -> str | None:
    """Render a fragment-anchored highlight context."""
    fragment_anchor = highlight.fragment_anchor
    if fragment_anchor is None or fragment_anchor.fragment is None:
        return None
    fragment = fragment_anchor.fragment
    if fragment.media_id != highlight.anchor_media_id:
        return None
    media = db.get(Media, fragment.media_id)
    if media is None:
        return None

    context_window = get_context_window(
        db,
        fragment.id,
        fragment_anchor.start_offset,
        fragment_anchor.end_offset,
    )

    lines = ["<highlight>", f"<source>{xml_escape(media.title)}</source>"]
    if media.canonical_source_url:
        lines.append(f"<url>{xml_escape(media.canonical_source_url)}</url>")
    if fragment.t_start_ms is not None:
        lines.append(f"<timestamp>{_format_timestamp_ms(fragment.t_start_ms)}</timestamp>")
    if fragment.speaker_label:
        lines.append(f"<speaker>{xml_escape(fragment.speaker_label)}</speaker>")
    lines.append(f"<quote>{xml_escape(highlight.exact)}</quote>")
    if context_window.text != highlight.exact:
        lines.append(f"<surrounding>{xml_escape(context_window.text)}</surrounding>")
    lines.append("</highlight>")
    return "\n".join(lines)


def _load_pdf_page_span(
    db: Session,
    media_id: UUID,
    page_number: int,
) -> PdfPageTextSpan | None:
    return (
        db.query(PdfPageTextSpan)
        .filter(
            PdfPageTextSpan.media_id == media_id,
            PdfPageTextSpan.page_number == page_number,
        )
        .first()
    )


def _build_pdf_nearby_context(plain_text: str, start_offset: int, end_offset: int) -> str:
    window = 64
    return plain_text[max(0, start_offset - window) : min(len(plain_text), end_offset + window)]


def _validate_unique_pdf_offsets(
    db: Session,
    highlight: Highlight,
    media: Media,
    pdf_anchor: HighlightPdfAnchor,
) -> tuple[int, int] | None:
    """Validate persisted unique offsets before using nearby-context rendering."""

    def _record_coherence_anomaly(anomaly_kind: CoherenceAnomalyKind) -> None:
        handle_recoverable_coherence_anomaly(
            anomaly_kind,
            highlight_id=highlight.id,
            media_id=media.id,
            page_number=pdf_anchor.page_number,
            match_status=pdf_anchor.plain_text_match_status,
            match_version=pdf_anchor.plain_text_match_version,
            path=_PDF_CONTEXT_RENDER_PATH,
        )

    if pdf_anchor.plain_text_match_version != 1:
        _record_coherence_anomaly(CoherenceAnomalyKind.unsupported_match_version)
        return None

    start_offset = pdf_anchor.plain_text_start_offset
    end_offset = pdf_anchor.plain_text_end_offset
    if start_offset is None or end_offset is None or start_offset < 0 or end_offset <= start_offset:
        _record_coherence_anomaly(CoherenceAnomalyKind.status_offsets_inconsistent)
        return None

    plain_text = media.plain_text or ""
    if end_offset > len(plain_text):
        _record_coherence_anomaly(CoherenceAnomalyKind.offsets_out_of_range)
        return None

    page_span = _load_pdf_page_span(db, media.id, pdf_anchor.page_number)
    if page_span and (
        start_offset < page_span.start_offset
        or end_offset > page_span.end_offset
        or page_span.end_offset < page_span.start_offset
    ):
        _record_coherence_anomaly(CoherenceAnomalyKind.offsets_outside_page_span)
        return None

    exact = highlight.exact
    if plain_text[start_offset:end_offset] != exact:
        _record_coherence_anomaly(CoherenceAnomalyKind.offset_substring_mismatch_exact)
        return None

    return start_offset, end_offset


def _resolve_pdf_nearby_context(
    db: Session,
    highlight: Highlight,
    media: Media,
    pdf_anchor: HighlightPdfAnchor,
) -> str | None:
    """Resolve nearby context deterministically for PDF quote rendering."""
    plain_text = media.plain_text or ""
    status = pdf_anchor.plain_text_match_status

    if status == MatchStatus.unique.value and not highlight.exact:
        fallback_action = handle_recoverable_coherence_anomaly(
            CoherenceAnomalyKind.exact_status_inconsistent,
            highlight_id=highlight.id,
            media_id=media.id,
            page_number=pdf_anchor.page_number,
            match_status=status,
            match_version=pdf_anchor.plain_text_match_version,
            path=_PDF_CONTEXT_RENDER_PATH,
        )
        if fallback_action == CoherenceFallbackAction.retry_as_pending:
            status = MatchStatus.pending.value
        else:
            return None

    if status == MatchStatus.unique.value:
        try:
            coherent_offsets = _validate_unique_pdf_offsets(db, highlight, media, pdf_anchor)
        except Exception as exc:
            try:
                handle_coherence_unclassified_exception(
                    exc,
                    highlight_id=highlight.id,
                    media_id=media.id,
                    page_number=pdf_anchor.page_number,
                    match_status=status,
                    match_version=pdf_anchor.plain_text_match_version,
                    path=_PDF_CONTEXT_RENDER_PATH,
                )
            except PdfQuoteMatchInternalError as policy_exc:
                raise QuoteContextBlockingError(ApiErrorCode.E_INTERNAL) from policy_exc
            raise QuoteContextBlockingError(ApiErrorCode.E_INTERNAL) from exc
        if coherent_offsets is not None:
            start_offset, end_offset = coherent_offsets
            return _build_pdf_nearby_context(plain_text, start_offset, end_offset)
        # Incoherent persisted metadata is treated as pending for in-memory retry.
        status = MatchStatus.pending.value

    if status in {
        MatchStatus.ambiguous.value,
        MatchStatus.no_match.value,
        MatchStatus.empty_exact.value,
    }:
        return None

    if status != MatchStatus.pending.value:
        fallback_action = handle_recoverable_coherence_anomaly(
            CoherenceAnomalyKind.unknown_match_status,
            highlight_id=highlight.id,
            media_id=media.id,
            page_number=pdf_anchor.page_number,
            match_status=status,
            match_version=pdf_anchor.plain_text_match_version,
            path=_PDF_CONTEXT_RENDER_PATH,
        )
        if fallback_action == CoherenceFallbackAction.retry_as_pending:
            status = MatchStatus.pending.value
        else:
            return None

    page_span = _load_pdf_page_span(db, media.id, pdf_anchor.page_number)
    page_span_start = page_span.start_offset if page_span else None
    page_span_end = page_span.end_offset if page_span else None

    try:
        result = compute_match(
            exact=highlight.exact,
            page_number=pdf_anchor.page_number,
            plain_text=plain_text,
            page_span_start=page_span_start,
            page_span_end=page_span_end,
        )
    except MatcherAnomaly as anomaly:
        handle_recoverable_anomaly(
            anomaly,
            highlight_id=highlight.id,
            media_id=media.id,
            page_number=pdf_anchor.page_number,
            path=_PDF_CONTEXT_RENDER_PATH,
        )
        return None
    except Exception as exc:
        try:
            handle_unclassified_exception(
                exc,
                highlight_id=highlight.id,
                media_id=media.id,
                page_number=pdf_anchor.page_number,
                path=_PDF_CONTEXT_RENDER_PATH,
            )
        except PdfQuoteMatchInternalError as policy_exc:
            raise QuoteContextBlockingError(ApiErrorCode.E_INTERNAL) from policy_exc
        raise QuoteContextBlockingError(ApiErrorCode.E_INTERNAL) from exc

    if (
        result.status != MatchStatus.unique
        or result.start_offset is None
        or result.end_offset is None
    ):
        return None

    return _build_pdf_nearby_context(plain_text, result.start_offset, result.end_offset)


def _render_pdf_highlight_context(db, highlight) -> str | None:
    """Render a PDF-anchored highlight context with deterministic degrade semantics."""
    pdf_anchor = highlight.pdf_anchor
    if pdf_anchor is None or pdf_anchor.media_id != highlight.anchor_media_id:
        return None
    media = db.get(Media, pdf_anchor.media_id)
    if media is None:
        return None
    if not is_pdf_quote_text_ready(db, pdf_anchor.media_id):
        raise QuoteContextBlockingError(ApiErrorCode.E_MEDIA_NOT_READY)

    lines = ["<highlight>", f"<source>{xml_escape(media.title)}</source>"]
    if media.canonical_source_url:
        lines.append(f"<url>{xml_escape(media.canonical_source_url)}</url>")
    lines.append(f"<quote>{xml_escape(highlight.exact)}</quote>")
    nearby_context = _resolve_pdf_nearby_context(db, highlight, media, pdf_anchor)
    if nearby_context and nearby_context != highlight.exact:
        lines.append(f"<surrounding>{xml_escape(nearby_context)}</surrounding>")
    lines.append("</highlight>")
    return "\n".join(lines)


def _render_note_context(db: Session, context_type: str, context_id: UUID) -> str | None:
    if context_type == "page":
        page = db.get(Page, context_id)
        if page is None:
            return None
        blocks = _ordered_note_blocks_for_page(db, page.id)
        content = _note_outline_markdown(blocks, None)
        return "\n".join(
            [
                "<page>",
                f"<title>{xml_escape(page.title)}</title>",
                f"<content>{xml_escape(content)}</content>",
                "</page>",
            ]
        )

    block = db.get(NoteBlock, context_id)
    if block is None:
        return None
    page_id = block.page_id
    assert page_id is not None
    blocks = _ordered_note_blocks_for_page(db, page_id)
    content = _note_outline_markdown(blocks, block.parent_block_id, root_block=block)
    return "\n".join(
        [
            "<note_block>",
            f"<content>{xml_escape(content)}</content>",
            "</note_block>",
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
    text = (block.body_markdown or block.body_text or "").strip()
    lines = text.splitlines() or [""]
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


def _render_conversation_context(db: Session, conversation_id: UUID) -> str | None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        return None
    return "\n".join(
        [
            "<conversation>",
            f"<title>{xml_escape(conversation.title)}</title>",
            f"<scope_type>{xml_escape(conversation.scope_type)}</scope_type>",
            "</conversation>",
        ]
    )


def _render_message_context(db: Session, message_id: UUID) -> str | None:
    message = db.get(Message, message_id)
    if message is None:
        return None
    lines = [
        "<message>",
        f"<role>{xml_escape(message.role)}</role>",
        f"<sequence>{message.seq}</sequence>",
    ]
    if message.conversation is not None:
        lines.append(f"<conversation>{xml_escape(message.conversation.title)}</conversation>")
    lines.append(f"<content>{xml_escape(message.content)}</content>")
    lines.append("</message>")
    return "\n".join(lines)


def _render_podcast_context(db: Session, podcast_id: UUID) -> str | None:
    podcast = db.get(Podcast, podcast_id)
    if podcast is None:
        return None
    lines = ["<podcast>", f"<source>{xml_escape(podcast.title)}</source>"]
    contributors = load_contributor_credits_for_podcasts(db, [podcast_id]).get(podcast_id, [])
    if contributors:
        lines.append("<contributors>")
        for contributor in contributors:
            lines.append(
                f'<contributor role="{xml_escape(contributor.role)}">'
                f"{xml_escape(contributor.credited_name)}</contributor>"
            )
        lines.append("</contributors>")
    if podcast.website_url:
        lines.append(f"<url>{xml_escape(podcast.website_url)}</url>")
    if podcast.description:
        lines.append(f"<description>{xml_escape(podcast.description)}</description>")
    lines.append("</podcast>")
    return "\n".join(lines)


def _render_content_chunk_context(db: Session, ctx: MessageContextRef) -> str | None:
    chunk = db.get(ContentChunk, ctx.id)
    if chunk is None:
        return None
    media = db.get(Media, chunk.media_id)
    if media is None:
        return None
    if ctx.evidence_span_ids:
        return _render_content_chunk_evidence_spans(db, media, chunk, ctx.evidence_span_ids)
    lines = [
        "<content_chunk>",
        f"<source>{xml_escape(media.title)}</source>",
        f"<source_kind>{xml_escape(chunk.source_kind)}</source_kind>",
    ]
    headings = [heading for heading in chunk.heading_path if isinstance(heading, str) and heading]
    if headings:
        lines.append(f"<heading_path>{xml_escape(' / '.join(headings))}</heading_path>")
    lines.append(f"<content>{xml_escape(chunk.chunk_text)}</content>")
    lines.append("</content_chunk>")
    return "\n".join(lines)


def _render_content_chunk_evidence_spans(
    db: Session,
    media: Media,
    chunk: ContentChunk,
    evidence_span_ids: Sequence[UUID],
) -> str | None:
    lines = [
        "<content_chunk>",
        f"<source>{xml_escape(media.title)}</source>",
        f"<source_kind>{xml_escape(chunk.source_kind)}</source_kind>",
    ]
    rendered = 0
    seen: set[UUID] = set()
    for evidence_span_id in evidence_span_ids:
        if evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        span = db.get(EvidenceSpan, evidence_span_id)
        if (
            span is None
            or span.media_id != chunk.media_id
            or span.index_run_id != chunk.index_run_id
        ):
            continue
        lines.append(f"<evidence_span_id>{span.id}</evidence_span_id>")
        lines.append(f"<citation_label>{xml_escape(span.citation_label)}</citation_label>")
        lines.append(f"<content>{xml_escape(span.span_text)}</content>")
        rendered += 1
    if rendered == 0:
        return None
    lines.append("</content_chunk>")
    return "\n".join(lines)


def _render_contributor_context(db: Session, contributor_id: UUID) -> str | None:
    contributor = db.get(Contributor, contributor_id)
    if contributor is None or contributor.status in {"merged", "tombstoned"}:
        return None
    lines = [
        "<contributor>",
        f"<handle>{xml_escape(contributor.handle)}</handle>",
        f"<display_name>{xml_escape(contributor.display_name)}</display_name>",
    ]
    if contributor.sort_name:
        lines.append(f"<sort_name>{xml_escape(contributor.sort_name)}</sort_name>")
    if contributor.kind:
        lines.append(f"<kind>{xml_escape(contributor.kind)}</kind>")
    if contributor.disambiguation:
        lines.append(f"<disambiguation>{xml_escape(contributor.disambiguation)}</disambiguation>")
    lines.append("</contributor>")
    return "\n".join(lines)
