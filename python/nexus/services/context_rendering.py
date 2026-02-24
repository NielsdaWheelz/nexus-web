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

from nexus.db.models import Annotation, Highlight, Media
from nexus.logging import get_logger
from nexus.services.context_window import get_context_window

logger = get_logger(__name__)

# System prompt version (tracked in message_llm.prompt_version)
PROMPT_VERSION = "s3_v1"

# Limits
MAX_CONTEXTS = 10
MAX_CONTEXT_CHARS = 25000


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

    # PDF and future anchor kinds deferred to pr-05
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

    lines.append("")
    lines.append("**Quoted text:**")
    for line in highlight.exact.split("\n"):
        lines.append(f"> {line}")

    if context_window.text != highlight.exact:
        lines.append("")
        lines.append("**Context:**")
        lines.append(context_window.text)

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

    # PDF and future anchor kinds deferred to pr-05
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
