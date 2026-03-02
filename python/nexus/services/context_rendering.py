"""Context rendering for LLM prompts.

Renders context items (media, highlights, annotations) into markdown blocks
for inclusion in LLM prompts.

Per S3 spec:
- Context blocks include source, metadata, exact quote, surrounding context
- Context cap: 25,000 chars total
- Max 10 context items per message

Note: This module has DB access and is intentionally kept outside the LLM
adapter layer (which must be DB-free per PR-04 spec).
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Annotation, Highlight, HighlightPdfAnchor, Media, PdfPageTextSpan
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.context_window import get_context_window
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
PROMPT_VERSION = "s3_v1"

# Limits
MAX_CONTEXTS = 10
MAX_CONTEXT_CHARS = 25000
_PDF_CONTEXT_RENDER_PATH = "pdf_quote_context_render"


def _format_timestamp_ms(timestamp_ms: int) -> str:
    total_seconds = max(0, timestamp_ms // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


@dataclass
class RenderedContext:
    """A rendered context block for the prompt."""

    text: str
    media_id: UUID | None
    char_count: int


def render_context_blocks(
    db: Session,
    contexts: list[dict],
) -> tuple[str, int]:
    """Render context items into markdown blocks for the prompt.

    Args:
        db: Database session.
        contexts: List of context dicts with keys:
            - type: "media" | "highlight" | "annotation"
            - id: UUID of the target

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
                context_type=ctx.get("type"),
                context_id=str(ctx.get("id")),
                error=str(e),
            )
            continue

    if rendered_blocks:
        result = "\n\n---\n\n".join(rendered_blocks)
        return result, total_chars

    return "", 0


def _render_single_context(db: Session, ctx: dict) -> str | None:
    """Render a single context item to a markdown block."""
    ctx_type = ctx.get("type")
    ctx_id = ctx.get("id")

    if not ctx_type or not ctx_id:
        return None

    if ctx_type == "media":
        return _render_media_context(db, ctx_id)
    elif ctx_type == "highlight":
        return _render_highlight_context(db, ctx_id)
    elif ctx_type == "annotation":
        return _render_annotation_context(db, ctx_id)
    else:
        logger.warning("unknown_context_type", context_type=ctx_type)
        return None


def _render_media_context(db: Session, media_id: UUID) -> str | None:
    """Render a media context (just metadata, no excerpt)."""
    media = db.get(Media, media_id)
    if not media:
        return None

    lines = [
        f"**Source:** {media.title}",
    ]

    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")

    return "\n".join(lines)


def _render_highlight_context(db: Session, highlight_id: UUID) -> str | None:
    """Render a highlight context with quote and surrounding context.

    S6 PR-02: uses anchor-kind dispatch seam. Fragment rendering path is
    unchanged; PDF rendering is deferred to pr-05.
    """
    from nexus.services.highlight_kernel import ResolverState, resolve_highlight

    highlight = db.get(Highlight, highlight_id)
    if not highlight:
        return None

    resolution = resolve_highlight(highlight)
    if resolution.state == ResolverState.mismatch:
        logger.warning(
            "context_render_highlight_mismatch",
            highlight_id=str(highlight_id),
            mismatch_code=resolution.mismatch_code.value if resolution.mismatch_code else None,
        )
        return None

    if resolution.anchor_kind == "fragment_offsets":
        return _render_fragment_highlight_context(db, highlight, resolution)

    if resolution.anchor_kind == "pdf_page_geometry":
        return _render_pdf_highlight_context(db, highlight, resolution)

    # Future non-fragment anchor kinds fall back to exact-only rendering.
    return _render_fallback_highlight_context(db, highlight, resolution)


def _render_fragment_highlight_context(db, highlight, resolution) -> str | None:
    """Render a fragment-anchored highlight context (unchanged from pre-PR-02)."""
    fragment = highlight.fragment
    if fragment is None:
        return None
    media = fragment.media

    context_window = get_context_window(
        db,
        fragment.id,
        highlight.start_offset,
        highlight.end_offset,
    )

    lines = [
        f"**Source:** {media.title}",
    ]

    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")

    if fragment.t_start_ms is not None:
        lines.append(f"Timestamp: {_format_timestamp_ms(fragment.t_start_ms)}")
    if fragment.speaker_label:
        lines.append(f"Speaker: {fragment.speaker_label}")

    lines.append("")
    lines.append("**Quoted text:**")
    for line in highlight.exact.split("\n"):
        lines.append(f"> {line}")

    if context_window.text != highlight.exact:
        lines.append("")
        lines.append("**Context:**")
        lines.append(context_window.text)

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


def _render_pdf_highlight_context(db, highlight, resolution) -> str | None:
    """Render a PDF-anchored highlight context with deterministic degrade semantics."""
    media_id = resolution.anchor_media_id
    if media_id is None:
        return None
    media = db.get(Media, media_id)
    if media is None:
        return None
    if not is_pdf_quote_text_ready(db, media_id):
        raise QuoteContextBlockingError(ApiErrorCode.E_MEDIA_NOT_READY)

    pdf_anchor = highlight.pdf_anchor
    if pdf_anchor is None:
        return None

    lines = [f"**Source:** {media.title}"]
    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")
    lines.append("")
    lines.append("**Quoted text:**")
    for line in highlight.exact.split("\n"):
        lines.append(f"> {line}")

    nearby_context = _resolve_pdf_nearby_context(db, highlight, media, pdf_anchor)
    if nearby_context and nearby_context != highlight.exact:
        lines.append("")
        lines.append("**Context:**")
        lines.append(nearby_context)

    return "\n".join(lines)


def _render_pdf_annotation_context(db, highlight, annotation, resolution) -> str | None:
    """Render a PDF-anchored annotation context with deterministic degrade semantics."""
    media_id = resolution.anchor_media_id
    if media_id is None:
        return None
    media = db.get(Media, media_id)
    if media is None:
        return None
    if not is_pdf_quote_text_ready(db, media_id):
        raise QuoteContextBlockingError(ApiErrorCode.E_MEDIA_NOT_READY)

    pdf_anchor = highlight.pdf_anchor
    if pdf_anchor is None:
        return None

    lines = [f"**Source:** {media.title}"]
    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")
    lines.append("")
    lines.append("**Quoted text:**")
    for line in highlight.exact.split("\n"):
        lines.append(f"> {line}")

    lines.append("")
    lines.append("**User's note:**")
    lines.append(annotation.body)

    nearby_context = _resolve_pdf_nearby_context(db, highlight, media, pdf_anchor)
    if nearby_context and nearby_context != highlight.exact:
        lines.append("")
        lines.append("**Context:**")
        lines.append(nearby_context)

    return "\n".join(lines)


def _render_fallback_highlight_context(db, highlight, resolution) -> str | None:
    """Fallback rendering for non-fragment highlight contexts (pr-05+)."""
    from nexus.db.models import Media as MediaModel

    media_id = resolution.anchor_media_id
    if media_id is None:
        return None
    media = db.get(MediaModel, media_id)
    if media is None:
        return None

    lines = [f"**Source:** {media.title}"]
    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")
    if highlight.exact:
        lines.append("")
        lines.append("**Quoted text:**")
        for line in highlight.exact.split("\n"):
            lines.append(f"> {line}")
    return "\n".join(lines)


def _render_annotation_context(db: Session, annotation_id: UUID) -> str | None:
    """Render an annotation context (highlight + annotation note).

    S6 PR-02: uses anchor-kind dispatch via highlight rendering seam.
    """
    from nexus.services.highlight_kernel import ResolverState, resolve_highlight

    annotation = db.get(Annotation, annotation_id)
    if not annotation:
        return None

    highlight = annotation.highlight
    if not highlight:
        return None

    resolution = resolve_highlight(highlight)
    if resolution.state == ResolverState.mismatch:
        logger.warning(
            "context_render_annotation_mismatch",
            annotation_id=str(annotation_id),
            highlight_id=str(highlight.id),
            mismatch_code=resolution.mismatch_code.value if resolution.mismatch_code else None,
        )
        return None

    if resolution.anchor_kind == "fragment_offsets":
        return _render_fragment_annotation_context(db, highlight, annotation, resolution)

    if resolution.anchor_kind == "pdf_page_geometry":
        return _render_pdf_annotation_context(db, highlight, annotation, resolution)

    # Future non-fragment anchor kinds fall back to exact-only rendering.
    return _render_fallback_annotation_context(db, highlight, annotation, resolution)


def _render_fragment_annotation_context(db, highlight, annotation, resolution) -> str | None:
    """Render a fragment-anchored annotation context (unchanged from pre-PR-02)."""
    fragment = highlight.fragment
    if fragment is None:
        return None
    media = fragment.media

    context_window = get_context_window(
        db,
        fragment.id,
        highlight.start_offset,
        highlight.end_offset,
    )

    lines = [
        f"**Source:** {media.title}",
    ]

    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")

    if fragment.t_start_ms is not None:
        lines.append(f"Timestamp: {_format_timestamp_ms(fragment.t_start_ms)}")
    if fragment.speaker_label:
        lines.append(f"Speaker: {fragment.speaker_label}")

    lines.append("")
    lines.append("**Quoted text:**")
    for line in highlight.exact.split("\n"):
        lines.append(f"> {line}")

    lines.append("")
    lines.append("**User's note:**")
    lines.append(annotation.body)

    if context_window.text != highlight.exact:
        lines.append("")
        lines.append("**Context:**")
        lines.append(context_window.text)

    return "\n".join(lines)


def _render_fallback_annotation_context(db, highlight, annotation, resolution) -> str | None:
    """Fallback rendering for non-fragment annotation contexts (pr-05+)."""
    from nexus.db.models import Media as MediaModel

    media_id = resolution.anchor_media_id
    if media_id is None:
        return None
    media = db.get(MediaModel, media_id)
    if media is None:
        return None

    lines = [f"**Source:** {media.title}"]
    if media.canonical_source_url:
        lines.append(f"URL: {media.canonical_source_url}")
    if highlight.exact:
        lines.append("")
        lines.append("**Quoted text:**")
        for line in highlight.exact.split("\n"):
            lines.append(f"> {line}")
    lines.append("")
    lines.append("**User's note:**")
    lines.append(annotation.body)
    return "\n".join(lines)
